// Windows measurement backend for perf-probe.mjs, mirroring the shape the mac
// pipeline (samplePowermetrics -> extractSample, sampleFootprint) produces so
// sampleScenario() in perf-probe.mjs can stay mostly platform-agnostic.
//
// See scripts/lib/perfSample.ps1 for why the underlying attribution model
// differs (process tree instead of powermetrics coalitions) and why the GPU
// and memory figures are approximations rather than exact analogs of
// powermetrics/footprint.
//
// No sudo/elevation needed: Process and GPU Engine perf counters and
// Get-Process are readable by a standard user for the app's own processes.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appPidsWin, processTreeWin, processPathWin } from "./appControlWin.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SAMPLE_SCRIPT = join(SCRIPT_DIR, "perfSample.ps1");

let psExe = null;
function powershellExe() {
  if (psExe) return psExe;
  const pwsh = spawnSync("where", ["pwsh.exe"], { encoding: "utf8" });
  psExe = pwsh.status === 0 && pwsh.stdout.trim() ? "pwsh.exe" : "powershell.exe";
  return psExe;
}

// Windows "% Processor Time" and "GPU Engine ... Utilization Percentage" are
// both normalized so 100% == one full core/engine saturated. perf-probe's
// report is keyed to the mac convention of "1000 ms/s == one core", so this
// is the single conversion point between the two unit systems.
const PERCENT_TO_MS_PER_S = 10;

// Windows PowerShell 5.1's `-Encoding utf8` (unlike pwsh 7's) writes a BOM,
// which JSON.parse rejects outright. Stripped unconditionally since it costs
// nothing when absent, and this runs regardless of which PowerShell produced
// the file — pwsh is preferred (see powershellExe()) but isn't guaranteed
// present on every machine this is asked to run on.
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function primeSudoWin() {
  // Nothing needs elevation on this platform — see file header.
}

export function discoverTrackedPidsWin() {
  const app = appPidsWin();
  if (!app.length) return { app: [], tracked: [], resolved: true };
  const tracked = processTreeWin(app);
  return { app, tracked, resolved: true };
}

/**
 * Run perfSample.ps1 for `seconds` one-second samples and return one
 * extracted-sample-shape object per interval, matching what mac's
 * extractSample() produces: { cpu, gpu, energy, perProcess, wsCpu, wsGpu,
 * source }. `tracked` is the pid union observed across the whole window,
 * mirroring coalitionPids()'s union-not-single-snapshot approach (here it's
 * belt-and-suspenders — see perfSample.ps1's per-iteration re-walk — rather
 * than working around a thresholding gotcha, since Windows process listing
 * has none).
 */
export function sampleWindowWin(seconds, appPidSet) {
  const dir = mkdtempSync(join(tmpdir(), "viboplr-perf-win-"));
  const outFile = join(dir, "sample.json");
  const rootPids = [...appPidSet].join(",");

  const res = spawnSync(
    powershellExe(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SAMPLE_SCRIPT,
      "-RootPids",
      rootPids,
      "-Count",
      String(seconds),
      "-OutFile",
      outFile,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (res.status !== 0 || !existsSync(outFile)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`perfSample.ps1 exited ${res.status}\n${res.stderr ?? ""}`);
  }

  let raw;
  try {
    raw = JSON.parse(stripBom(readFileSync(outFile, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const iterations = Array.isArray(raw) ? raw : [raw];

  const trackedUnion = new Set(appPidSet);
  let gpuEverAvailable = false;

  const extracted = iterations.map((it) => {
    // ConvertTo-Json renders an empty PowerShell array as `{}`, not `[]` (the
    // baseline scenario hits this every time — no root pids to track), so
    // these can't be trusted to be arrays without normalizing first.
    const trackedList = Array.isArray(it.tracked) ? it.tracked : [];
    const processList = Array.isArray(it.processes) ? it.processes : [];
    for (const p of trackedList) trackedUnion.add(Number(p));
    if (it.gpuAvailable) gpuEverAvailable = true;

    const perProcess = {};
    let cpu = 0;
    let gpu = 0;
    for (const proc of processList) {
      const name = String(proc.name ?? "unknown");
      perProcess[name] = perProcess[name] ?? { cpu: 0 };
      const cpuMs = (proc.cpuPercent ?? 0) * PERCENT_TO_MS_PER_S;
      perProcess[name].cpu += cpuMs;
      cpu += cpuMs;
      gpu += (proc.gpuPercent ?? 0) * PERCENT_TO_MS_PER_S;
    }
    const dwm = it.dwm;
    const wsCpu = dwm ? (dwm.cpuPercent ?? 0) * PERCENT_TO_MS_PER_S : 0;
    const wsGpu = dwm ? (dwm.gpuPercent ?? 0) * PERCENT_TO_MS_PER_S : 0;

    return {
      cpu,
      gpu: it.gpuAvailable ? gpu : undefined,
      energy: undefined, // No Windows analog to Apple's energy-impact composite.
      perProcess,
      wsCpu,
      wsGpu,
      source: processList.length ? "coalition" : "absent",
    };
  });

  return { extracted, tracked: [...trackedUnion], resolved: true, gpuAvailable: gpuEverAvailable };
}

/** Bracket-sample working-set memory for `pids`, mirroring sampleFootprint's start/end pair. */
export function sampleFootprintWin(pids) {
  if (!pids.length) return { totalMb: 0, perProcess: {} };
  const dir = mkdtempSync(join(tmpdir(), "viboplr-fp-win-"));
  const outFile = join(dir, "fp.json");
  const script =
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ` +
    `Select-Object Id, ProcessName, WorkingSet64 | ConvertTo-Json | Out-File -FilePath '${outFile}' -Encoding utf8`;
  const res = spawnSync(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (res.status !== 0 || !existsSync(outFile)) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`footprint (Windows) failed (exit ${res.status}): ${res.stderr ?? ""}`);
    return { totalMb: undefined, perProcess: {} };
  }
  let rows;
  try {
    const parsed = JSON.parse(stripBom(readFileSync(outFile, "utf8")));
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.error("Failed to parse Windows footprint json:", e);
    rows = [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const perProcess = {};
  let totalBytes = 0;
  for (const row of rows) {
    if (typeof row?.WorkingSet64 !== "number") continue;
    const name = String(row.ProcessName ?? "unknown");
    perProcess[name] = (perProcess[name] ?? 0) + row.WorkingSet64 / (1024 * 1024);
    totalBytes += row.WorkingSet64;
  }
  return { totalMb: totalBytes / (1024 * 1024), perProcess };
}

// Windows analog of classifyBuild's mac path check. Both builds run
// viboplr.exe (same reasoning as mac: Tauri names it after the Cargo
// package), so only the containing directory tells dev from an install.
export function classifyBuildWin(execPath) {
  if (!execPath) return "unknown";
  const p = execPath.replace(/\\/g, "/");
  if (/\/target\/(debug|release)\//i.test(p)) return "dev";
  if (/\/Viboplr\/viboplr\.exe$/i.test(p)) return "release";
  return "unknown";
}

export { processPathWin };
