// Measures the CPU / GPU / memory cost Viboplr imposes on a macOS host.
//
// Viboplr is not a single process: WKWebView spawns com.apple.WebKit.WebContent
// (all React rendering), .GPU (compositing — non-trivial here because the window
// is transparent + undecorated) and .Networking as launchd-parented XPC services.
// They report PPID 1, so a process-tree walk finds none of them.
//
// Attribution therefore goes through powermetrics *coalitions*, which was verified
// against real output on this machine — the com.alex.viboplr coalition contains all
// four processes:
//
//   com.alex.viboplr (id 56774)  cpu=124.56 ms/s  gpu=0.81 ms/s
//       pid 54701  com.apple.WebKit.WebContent   cpu=62.02
//       pid 54696  viboplr                       cpu=41.16
//       pid 54699  com.apple.WebKit.GPU          cpu=26.32
//       pid 54700  com.apple.WebKit.Networking   cpu= 1.13
//
// Schema notes that cost real debugging time, all confirmed against live output:
//   - There is NO top-level per-task array. `all_tasks` is a system-wide summary
//     dict (2179 ms/s on an idle machine); per-task data lives only in
//     coalitions[].tasks[]. Treating all_tasks as ours reports the whole machine.
//   - Coalitions carry `id`, not `pid`.
//   - GPU time exists ONLY on the coalition; member tasks have no gputime_* keys,
//     which is why there is no per-process GPU column. The keys are also OMITTED
//     outright (not zeroed) for any coalition idle on the GPU that interval — only
//     3 of 136 coalitions carried them in one capture.
//   - Compositing is billed to the separate com.apple.WindowServer coalition, so the
//     app's own gpu figure understates its true screen cost. See windowServer().
//   - powermetrics emits one <date> node (`timestamp`) and JSON has no date type,
//     so plutil rejects the whole document unless it is demoted to a string.
//   - The coalition list is thresholded, not top-N capped (counts varied 100/120/125
//     with a tail at 0.01 ms/s), so a running app is never truncated away.
//
// Both powermetrics and footprint require root. sudo is primed once up front.
//
// Usage:
//   node scripts/perf-probe.mjs run [--seconds 60]     guided walk through every scenario
//   node scripts/perf-probe.mjs sample <label> [--seconds 60]
//   node scripts/perf-probe.mjs report [--note "..."]  delta table for the newest run
//   node scripts/perf-probe.mjs save   [--note "..."]  append the newest run to history
//   node scripts/perf-probe.mjs probe                  dump raw powermetrics keys (debugging)
//
// Results live in benchmarks/resource-usage.json, mirroring benchmarks/history.json.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = join(REPO_ROOT, "benchmarks", "resource-usage.json");
const LATEST_PATH = join(REPO_ROOT, "benchmarks", ".resource-usage-latest.json");

// A window shorter than this is dominated by whatever the app was doing when you
// hit Enter rather than by its steady state.
const DEFAULT_SECONDS = 60;
const SAMPLE_INTERVAL_MS = 1000;

const BASELINE_LABEL = "baseline-quit";

// Ordered so each step isolates one additional cost over the step before it. The
// minimized/visible pair is the important one: it separates "playing audio costs
// this" from "drawing the UI costs this", and only the second half is ours to fix.
const SCENARIOS = [
  {
    label: BASELINE_LABEL,
    setup: "Quit Viboplr completely (Cmd-Q). Nothing of the app may be running.",
    isolates: "Noise floor of everything else on the machine.",
  },
  {
    label: "idle-home",
    setup: "Launch Viboplr, let it settle on the Home view, then leave it alone.",
    isolates: "Shelf artwork, image cache, transparent-window compositing at rest.",
  },
  {
    label: "idle-static",
    setup: "Still idle, nothing playing. Open Settings (no carousel, nothing animating) and leave it alone.",
    isolates: "The app truly at rest — idle-home minus this is the hero carousel's cost.",
  },
  {
    label: "playing-minimized",
    setup: "Play a LOCAL audio file, then minimize the window (Cmd-M).",
    isolates: "libmpv decode with the renderer parked — the true cost of audio.",
  },
  {
    label: "playing-visible",
    setup: "Same local track still playing. Restore the window on the library list, don't scroll.",
    isolates: "Cost of showing the UI while audio plays (delta vs the previous step).",
  },
  {
    label: "playing-nowplaying",
    setup: "Same track still playing. Open the fullscreen Now Playing view (artwork + lyrics).",
    isolates: "GPU compositing worst case.",
  },
  {
    label: "playing-mini",
    setup: "Same track still playing. Switch to the mini player (Cmd+Shift+M) and leave the pointer off it.",
    isolates: "Mini player window: compact bar render + the cycling Now Playing info line.",
  },
  {
    label: "playing-video",
    setup: "Play a video in the theater (e.g. the yt-dlp plugin's 'Watch YouTube video').",
    isolates: "mpv hardware decode + video presentation path.",
    optional: true,
  },
  {
    label: "collection-sync",
    setup: "Trigger a collection sync / rescan and leave it running for the whole window.",
    isolates: "Scan burst: CPU, disk, DB writes.",
    optional: true,
  },
  {
    label: "waveform",
    setup: "Open a local track under 15 MB so its waveform generates.",
    isolates: "Waveform decode pass.",
    optional: true,
  },
];

/* ---------------------------------------------------------------- utilities */

function run(cmd, args, { allowFailure = false, maxBuffer } = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer });
  if (res.error) {
    if (allowFailure) return { ok: false, stdout: "", stderr: String(res.error) };
    throw new Error(`${cmd} failed to launch: ${res.error.message}`);
  }
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}\n${res.stderr}`);
  }
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function primeSudo() {
  const cached = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" });
  if (cached.status === 0) return;
  console.log("powermetrics and footprint both need root — priming sudo once.\n");
  const res = spawnSync("sudo", ["-v"], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("\nCould not obtain sudo. Aborting.");
    process.exit(1);
  }
}

function fmt(value, digits = 1) {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function mean(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!nums.length) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function max(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!nums.length) return undefined;
  return Math.max(...nums);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`Failed to parse ${path}:`, e);
    return fallback;
  }
}

/* ------------------------------------------------------- process attribution */

function appPids() {
  // Both builds run a binary named `viboplr` — see classifyBuild.
  const res = run("pgrep", ["-i", "-x", "viboplr"], { allowFailure: true });
  return res.stdout
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function processPath(pid) {
  const res = run("ps", ["-p", String(pid), "-o", "comm="], { allowFailure: true });
  return res.ok ? res.stdout.trim() : "";
}

// The process NAME cannot tell the builds apart. Tauri names the bundle executable
// after the Cargo package (`name = "viboplr"`), not productName, so the release app
// at /Applications/Viboplr.app/Contents/MacOS/viboplr is lowercase too — exactly like
// the dev binary. Only the path distinguishes them.
export function classifyBuild(execPath) {
  if (!execPath) return "unknown";
  if (/\/target\/(debug|release)\//.test(execPath)) return "dev";
  if (/\.app\/Contents\/MacOS\//.test(execPath)) return "release";
  return "unknown";
}

// Verified against real powermetrics output: the com.alex.viboplr coalition already
// contains viboplr + WebKit.WebContent + WebKit.GPU + WebKit.Networking. So a short
// throwaway sample is all we need to learn the helper pids — no `launchctl procinfo`
// responsible-pid walk, and no extra sudo calls per scenario.
function discoverTrackedPids() {
  const app = appPids();
  if (!app.length) return { app: [], tracked: [], resolved: true };
  const samples = samplePowermetrics(1);
  const sample = samples.at(-1);
  if (!sample) return { app, tracked: app, resolved: false };
  const mine = ourCoalitions(sample, new Set(app));
  const pids = new Set(app);
  for (const c of mine) {
    for (const t of c?.tasks ?? []) {
      const pid = Number(t?.pid);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return { app, tracked: [...pids], resolved: mine.length > 0 };
}

/* ----------------------------------------------------------- powermetrics */

function samplePowermetrics(seconds, { keepRaw = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "viboplr-perf-"));
  const out = join(dir, "pm.plist");
  const count = Math.max(2, Math.round((seconds * 1000) / SAMPLE_INTERVAL_MS));

  const res = spawnSync(
    "sudo",
    [
      "powermetrics",
      "-s", "tasks",
      "--show-process-coalition",
      "--show-process-gpu",
      "--show-process-energy",
      "--format", "plist",
      "-i", String(SAMPLE_INTERVAL_MS),
      "-n", String(count),
      "-o", out,
    ],
    { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
  );
  if (res.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`powermetrics exited ${res.status}\n${res.stderr ?? ""}`);
  }

  const samples = parsePlistStream(out, dir);
  if (keepRaw) console.log(`Raw plist kept at ${out}`);
  else rmSync(dir, { recursive: true, force: true });
  return samples;
}

// powermetrics --format plist emits one plist per sample, NUL-separated.
function parsePlistStream(path, workDir) {
  const buf = readFileSync(path);
  const chunks = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x00) {
      if (i > start) chunks.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  const samples = [];
  chunks.forEach((chunk, idx) => {
    // JSON has no date type, so plutil rejects the *entire* document over the one
    // <date> node powermetrics emits for `timestamp`. We read elapsed_ns instead,
    // so demoting it to a string costs nothing.
    const xml = chunk.toString("utf8").replace(/<date>([^<]*)<\/date>/g, "<string>$1</string>");
    const tmp = join(workDir, `chunk-${idx}.plist`);
    writeFileSync(tmp, xml);
    // A sample is ~500 KB of XML and expands past Node's default 1 MB stdout cap.
    const res = run("plutil", ["-convert", "json", "-o", "-", "--", tmp], {
      allowFailure: true,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (!res.ok || !res.stdout.trim()) {
      // Never swallow this: a schema change here silently zeroes every metric.
      console.error(`plutil could not convert sample ${idx}: ${res.stderr.trim() || "empty output"}`);
      return;
    }
    try {
      samples.push(JSON.parse(res.stdout));
    } catch (e) {
      console.error(`Skipping unparseable powermetrics sample ${idx}:`, e);
    }
  });
  return samples;
}

// powermetrics key names have drifted across macOS releases; try every spelling
// we know and fall back to deriving rates from the raw ns counters.
function rateFrom(task, msKeys, nsKeys, elapsedNs) {
  for (const k of msKeys) {
    if (typeof task?.[k] === "number") return task[k];
  }
  for (const k of nsKeys) {
    if (typeof task?.[k] === "number" && elapsedNs > 0) {
      return (task[k] / elapsedNs) * 1000;
    }
  }
  return undefined;
}

const CPU_MS_KEYS = ["cputime_ms_per_s", "cputime_sample_ms_per_s"];
const CPU_NS_KEYS = ["cputime_ns", "cputime_sample_ns"];
const GPU_MS_KEYS = ["gputime_ms_per_s", "gputime_sample_ms_per_s"];
const GPU_NS_KEYS = ["gputime_ns", "gputime_sample_ns"];
const ENERGY_KEYS = ["energy_impact", "energy_impact_per_s"];

function taskName(task) {
  return String(task?.name ?? task?.process_name ?? "");
}

// There is no top-level per-task array. `all_tasks` is a SYSTEM-WIDE summary dict
// (it read 2179 ms/s on a quiet machine) — treating it as one of ours would report
// the whole machine's load as the app's. Per-task data lives only under coalitions.
// Coalitions are keyed by `id`, not `pid`, so identity comes from task membership.
// Pid membership is primary and the name is only a fallback: matching on the name
// first would also capture a *second* instance (a forgotten `tauri dev` alongside
// the release build) and silently double the totals.
function ourCoalitions(sample, pidSet) {
  const coalitions = Array.isArray(sample?.coalitions) ? sample.coalitions : [];
  const byPid = coalitions.filter(
    (c) => Array.isArray(c?.tasks) && c.tasks.some((t) => pidSet.has(Number(t?.pid))),
  );
  if (byPid.length) return byPid;
  return coalitions.filter((c) => /viboplr/i.test(String(c?.name ?? "")));
}

// GPU time is reported per coalition only — member tasks carry no gputime_* keys —
// so there is deliberately no per-process GPU figure.
function extractSample(sample, pidSet) {
  const elapsedNs = Number(sample?.elapsed_ns ?? 0);
  const mine = ourCoalitions(sample, pidSet);

  const perProcess = {};
  const seenPids = new Set();
  for (const c of mine) {
    for (const t of c?.tasks ?? []) {
      const pid = Number(t?.pid);
      if (seenPids.has(pid)) continue;
      seenPids.add(pid);
      const name = taskName(t).replace(/^com\.apple\.WebKit\./, "WebKit.");
      perProcess[name] = perProcess[name] ?? { cpu: 0 };
      perProcess[name].cpu += rateFrom(t, CPU_MS_KEYS, CPU_NS_KEYS, elapsedNs) ?? 0;
    }
  }

  if (!mine.length) {
    // powermetrics lists every coalition with any activity at all (the tail runs to
    // 0.01 ms/s), so absence means the app did nothing measurable this interval.
    // WindowServer still gets read — the baseline scenario depends on it.
    return { cpu: 0, gpu: 0, energy: 0, perProcess, source: "absent", ...windowServer(sample, elapsedNs) };
  }

  const cpu = mine.reduce((a, c) => a + (rateFrom(c, CPU_MS_KEYS, CPU_NS_KEYS, elapsedNs) ?? 0), 0);
  const gpu = mine.reduce((a, c) => a + (rateFrom(c, GPU_MS_KEYS, GPU_NS_KEYS, elapsedNs) ?? 0), 0);
  const energy = mine.reduce((a, c) => {
    const v = ENERGY_KEYS.map((k) => c[k]).find((x) => typeof x === "number");
    return a + (v ?? 0);
  }, 0);
  return { cpu, gpu, energy, perProcess, source: "coalition", ...windowServer(sample, elapsedNs) };
}

// WindowServer does the actual compositing for every app and is billed to its OWN
// coalition, so an app's window cost never shows up in the app's own numbers. That
// matters more here than for a normal app: the window is transparent + undecorated
// with macOSPrivateApi, which is precisely the configuration that makes the compositor
// work harder. Measured directly it read 20.96 ms/s of GPU against 0–29 for the app.
// Only the delta from the app-quit baseline is attributable to us.
function windowServer(sample, elapsedNs) {
  const c = (Array.isArray(sample?.coalitions) ? sample.coalitions : []).find(
    (x) => String(x?.name ?? "") === "com.apple.WindowServer",
  );
  if (!c) return { wsCpu: 0, wsGpu: 0 };
  return {
    wsCpu: rateFrom(c, CPU_MS_KEYS, CPU_NS_KEYS, elapsedNs) ?? 0,
    wsGpu: rateFrom(c, GPU_MS_KEYS, GPU_NS_KEYS, elapsedNs) ?? 0,
  };
}

/* --------------------------------------------------------------- footprint */

// phys_footprint, not RSS. RSS double-counts pages shared across the four
// processes; phys_footprint is what Activity Monitor's Memory column reports.
function sampleFootprint(pids) {
  if (!pids.length) return { totalMb: 0, perProcess: {} };
  const dir = mkdtempSync(join(tmpdir(), "viboplr-fp-"));
  const out = join(dir, "fp.json");
  // Pids go in as positional targets — footprint overloads -p for both --pid and
  // --proc, and positionals accept either form unambiguously.
  const args = ["footprint", "--json", out, ...pids.map(String)];

  const res = spawnSync("sudo", args, { encoding: "utf8" });
  if (res.status !== 0 || !existsSync(out)) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`footprint failed (exit ${res.status}): ${res.stderr ?? ""}`);
    return { totalMb: undefined, perProcess: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(out, "utf8"));
  } catch (e) {
    console.error("Failed to parse footprint json:", e);
    parsed = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
  if (!parsed) return { totalMb: undefined, perProcess: {} };

  const perProcess = {};
  let totalBytes = 0;
  for (const entry of collectFootprintEntries(parsed)) {
    const name = String(entry.name ?? entry.process ?? "unknown").replace(
      /^com\.apple\.WebKit\./,
      "WebKit.",
    );
    const bytes = footprintBytes(entry);
    if (bytes === undefined) continue;
    perProcess[name] = (perProcess[name] ?? 0) + bytes / (1024 * 1024);
    totalBytes += bytes;
  }
  return { totalMb: totalBytes / (1024 * 1024), perProcess };
}

// The json shape has moved around between macOS versions; walk for anything that
// looks like a per-process record with a footprint number on it.
function collectFootprintEntries(node, acc = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectFootprintEntries(item, acc);
    return acc;
  }
  if (node && typeof node === "object") {
    if ((node.name || node.process) && footprintBytes(node) !== undefined) acc.push(node);
    for (const value of Object.values(node)) collectFootprintEntries(value, acc);
  }
  return acc;
}

function footprintBytes(entry) {
  for (const key of ["phys_footprint", "footprint", "phys_footprint_bytes", "total"]) {
    const v = entry?.[key];
    if (typeof v === "number") return v;
    if (typeof v === "object" && typeof v?.bytes === "number") return v.bytes;
  }
  return undefined;
}

/* ---------------------------------------------------------------- sampling */

async function sampleScenario(label, seconds) {
  const expectRunning = label !== BASELINE_LABEL;
  const running = appPids();

  if (expectRunning && !running.length) {
    throw new Error(`No Viboplr process found, but scenario "${label}" needs the app running.`);
  }
  if (!expectRunning && running.length) {
    throw new Error(`Viboplr is still running (pid ${running.join(", ")}) — the baseline needs it quit.`);
  }

  const pre = expectRunning ? discoverTrackedPids() : { app: [], tracked: [], resolved: true };
  const tracked = pre.tracked;
  let build = expectRunning ? "unknown" : "n/a";
  if (expectRunning) {
    if (!pre.resolved) {
      console.warn("  ! No coalition found during pid discovery; tracking the app pid only.");
    }
    build = classifyBuild(processPath(pre.app[0]));
    console.log(`  tracking ${tracked.length} pid(s): ${tracked.join(", ")} — ${build} build`);
    if (build === "dev") {
      console.warn("  ! dev build — numbers include Vite HMR and an unminified bundle.");
    }
  }
  const pidSet = new Set(tracked);

  // Bracket the window rather than sampling it once: the start/end pair turns a
  // leak into a visible number. It cannot be a timer at the midpoint — powermetrics
  // runs under spawnSync, which blocks the event loop for the whole window.
  const empty = { totalMb: 0, perProcess: {} };
  const fpStart = expectRunning ? sampleFootprint(tracked) : empty;

  console.log(`  sampling ${seconds}s ...`);
  const samples = samplePowermetrics(seconds);

  const fpEnd = expectRunning ? sampleFootprint(tracked) : empty;

  // Drop the first sample: powermetrics' opening interval catches the tail of
  // whatever happened while the prompt was on screen.
  const usable = samples.slice(1);
  if (!usable.length) throw new Error("powermetrics returned no usable samples.");

  const extracted = usable.map((s) => extractSample(s, pidSet));
  const growthMb =
    fpEnd.totalMb !== undefined && fpStart.totalMb !== undefined
      ? fpEnd.totalMb - fpStart.totalMb
      : undefined;

  const perProcess = {};
  for (const e of extracted) {
    for (const [name, v] of Object.entries(e.perProcess)) {
      perProcess[name] = perProcess[name] ?? { cpu: [] };
      perProcess[name].cpu.push(v.cpu);
    }
  }

  return {
    label,
    seconds,
    samples: usable.length,
    attribution: extracted.some((e) => e.source === "coalition") ? "coalition" : "absent",
    build,
    tracked_pids: tracked.length,
    helpers_resolved: pre.resolved,
    cpu_ms_per_s_avg: mean(extracted.map((e) => e.cpu)),
    cpu_ms_per_s_peak: max(extracted.map((e) => e.cpu)),
    gpu_ms_per_s_avg: mean(extracted.map((e) => e.gpu)),
    gpu_ms_per_s_peak: max(extracted.map((e) => e.gpu)),
    // Compositing cost lands in WindowServer's own coalition, not ours. Recorded raw;
    // only its delta from the baseline is attributable to the app.
    windowserver_cpu_ms_per_s_avg: mean(extracted.map((e) => e.wsCpu)),
    windowserver_gpu_ms_per_s_avg: mean(extracted.map((e) => e.wsGpu)),
    energy_impact_avg: mean(extracted.map((e) => e.energy)),
    footprint_mb: fpEnd.totalMb,
    footprint_mb_start: fpStart.totalMb,
    footprint_growth_mb: growthMb,
    per_process: Object.fromEntries(
      Object.entries(perProcess).map(([name, v]) => [
        name,
        {
          cpu_ms_per_s_avg: mean(v.cpu),
          footprint_mb: fpEnd.perProcess[name],
        },
      ]),
    ),
  };
}

/* ------------------------------------------------------------------ report */

function renderReport(results, note) {
  const baseline = results.find((r) => r.label === BASELINE_LABEL);
  const cols = [
    ["scenario", 22],
    ["cpu ms/s", 10],
    ["Δcpu", 9],
    ["peak cpu", 10],
    ["gpu ms/s", 9],
    ["ΔwsCPU", 9],
    ["ΔwsGPU", 9],
    ["mem MB", 9],
    ["mem drift", 11],
    ["energy", 8],
  ];
  const line = (cells) => cells.map((c, i) => String(c).padEnd(cols[i][1])).join("");
  const delta = (r, b, key) => {
    if (!b || r === b) return undefined;
    if (r[key] === undefined || b[key] === undefined) return undefined;
    return r[key] - b[key];
  };
  const signed = (v, digits = 1) => (v === undefined ? "—" : `${v >= 0 ? "+" : ""}${fmt(v, digits)}`);

  const out = [];
  out.push("");
  if (note) out.push(note, "");
  out.push(line(cols.map((c) => c[0])));
  out.push("-".repeat(cols.reduce((a, c) => a + c[1], 0)));

  for (const r of results) {
    out.push(
      line([
        r.label,
        fmt(r.cpu_ms_per_s_avg),
        signed(delta(r, baseline, "cpu_ms_per_s_avg")),
        fmt(r.cpu_ms_per_s_peak),
        fmt(r.gpu_ms_per_s_avg),
        signed(delta(r, baseline, "windowserver_cpu_ms_per_s_avg")),
        signed(delta(r, baseline, "windowserver_gpu_ms_per_s_avg")),
        fmt(r.footprint_mb),
        signed(r.footprint_growth_mb),
        fmt(r.energy_impact_avg, 2),
      ]),
    );
  }

  out.push("");
  out.push("1000 ms/s = one core saturated. energy impact is Apple's relative composite.");
  out.push("mem is phys_footprint (Activity Monitor's Memory column); mem drift = growth across the window.");
  out.push(
    "ΔwsCPU/ΔwsGPU = WindowServer's rise over the baseline. Compositing is billed to WindowServer's own",
  );
  out.push(
    "coalition, so the app's real screen cost is its own gpu PLUS these. Add them before judging GPU load.",
  );
  out.push("");

  const withBreakdown = results.filter((r) => Object.keys(r.per_process ?? {}).length);
  if (withBreakdown.length) {
    out.push("Per-process breakdown (cpu ms/s avg | mem MB):");
    for (const r of withBreakdown) {
      const parts = Object.entries(r.per_process)
        .sort((a, b) => (b[1].cpu_ms_per_s_avg ?? 0) - (a[1].cpu_ms_per_s_avg ?? 0))
        .map(([n, v]) => `${n} ${fmt(v.cpu_ms_per_s_avg)} | ${fmt(v.footprint_mb)}`);
      out.push(`  ${r.label}: ${parts.join("   ")}`);
    }
    out.push("");
  }

  // The baseline legitimately has no processes to attribute, so it is never degraded.
  const absent = results.filter((r) => r.label !== BASELINE_LABEL && r.attribution === "absent");
  if (absent.length) {
    out.push(
      `! No coalition found for: ${absent.map((r) => r.label).join(", ")} — the app was running but registered no activity.`,
    );
  }
  const dev = results.filter((r) => r.build === "dev");
  if (dev.length) {
    out.push(`! dev build measured in: ${dev.map((r) => r.label).join(", ")} — not comparable to release numbers.`);
  }
  const unresolved = results.filter((r) => r.label !== BASELINE_LABEL && r.helpers_resolved === false);
  if (unresolved.length) {
    out.push(
      `! Responsible-pid lookup failed for: ${unresolved.map((r) => r.label).join(", ")} — helper attribution relied on coalition membership alone.`,
    );
  }
  if (absent.length || unresolved.length || dev.length) out.push("");
  return out.join("\n");
}

function gitCommit() {
  const res = run("git", ["rev-parse", "--short", "HEAD"], { allowFailure: true });
  return res.ok ? res.stdout.trim() : "unknown";
}

function appVersion() {
  return readJson(join(REPO_ROOT, "package.json"), {}).version ?? "unknown";
}

function saveRun(results, note) {
  const history = readJson(HISTORY_PATH, []);
  history.push({
    date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    version: appVersion(),
    commit: gitCommit(),
    note: note ?? "",
    results,
  });
  writeFileSync(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);
  console.log(`Appended run to ${HISTORY_PATH.replace(REPO_ROOT, ".")}`);
}

/* -------------------------------------------------------------------- cli */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? true;
    else positional.push(a);
  }
  return { positional, flags };
}

async function cmdRun(seconds) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const results = [];
  try {
    console.log(
      `\nEach scenario samples for ${seconds}s. Set the state described, then press Enter.\n` +
        `Type "s" to skip a scenario, or "q" to stop and report what you have.\n`,
    );
    for (const scenario of SCENARIOS) {
      console.log(`\n=== ${scenario.label}${scenario.optional ? " (optional)" : ""}`);
      console.log(`    ${scenario.setup}`);
      console.log(`    isolates: ${scenario.isolates}`);
      const answer = (await rl.question("    [Enter] sample  ·  s skip  ·  q quit > ")).trim().toLowerCase();
      if (answer === "q") break;
      if (answer === "s") {
        console.log("    skipped");
        continue;
      }
      try {
        const result = await sampleScenario(scenario.label, seconds);
        results.push(result);
        console.log(
          `    cpu ${fmt(result.cpu_ms_per_s_avg)} ms/s · gpu ${fmt(result.gpu_ms_per_s_avg)} ms/s · mem ${fmt(result.footprint_mb)} MB`,
        );
      } catch (e) {
        console.error(`    ! ${e.message}`);
      }
    }
  } finally {
    rl.close();
  }
  return results;
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("perf-probe is macOS only (powermetrics / footprint / launchctl).");
    process.exit(1);
  }

  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "run";
  // Validate before priming sudo — a typo should not cost a password prompt.
  const COMMANDS = ["run", "sample", "report", "save", "probe"];
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command "${command}". Try: ${COMMANDS.join(" | ")}`);
    process.exit(1);
  }
  const seconds = Number(flags.seconds ?? DEFAULT_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 5) {
    console.error("--seconds must be a number >= 5.");
    process.exit(1);
  }

  if (command === "probe") {
    primeSudo();
    console.log("Sampling 3s to dump powermetrics key names ...");
    const samples = samplePowermetrics(3, { keepRaw: true });
    const sample = samples.at(-1);
    if (!sample) {
      console.error("No samples returned.");
      process.exit(1);
    }
    console.log("\ntop-level keys:", Object.keys(sample).join(", "));
    const coalitions = Array.isArray(sample.coalitions) ? sample.coalitions : [];
    console.log(`coalitions: ${coalitions.length}`);
    console.log("coalition keys:", Object.keys(coalitions[0] ?? {}).join(", "));
    const withTasks = coalitions.find((c) => Array.isArray(c?.tasks) && c.tasks.length);
    console.log("member task keys:", Object.keys(withTasks?.tasks?.[0] ?? {}).join(", "));

    // The whole point of the probe: confirm the app is visible and that its helpers
    // land in its coalition. Meaningless unless Viboplr is running.
    const app = appPids();
    if (!app.length) {
      console.log(
        "\nViboplr is not running — relaunch it and re-run `probe` to confirm coalition attribution.",
      );
      return;
    }
    const mine = ourCoalitions(sample, new Set(app));
    if (!mine.length) {
      console.log(`\n! app pid(s) ${app.join(", ")} found, but NO matching coalition.`);
      return;
    }
    const elapsedNs = Number(sample?.elapsed_ns ?? 0);
    const ws = windowServer(sample, elapsedNs);
    console.log(`\nWindowServer (compositing, billed separately): cpu=${fmt(ws.wsCpu)} gpu=${fmt(ws.wsGpu)}`);
    for (const c of mine) {
      // Read through rateFrom so this shows what the pipeline will actually record:
      // powermetrics OMITS gputime_* entirely for a coalition with no GPU work, and
      // that is reported as 0, not as missing data.
      const gpu = rateFrom(c, GPU_MS_KEYS, GPU_NS_KEYS, elapsedNs);
      console.log(
        `\ncoalition "${c.name}" (id ${c.id}) cpu=${fmt(c.cputime_ms_per_s)} ` +
          `gpu=${gpu === undefined ? "0.0 (no gpu keys — zero GPU work this interval)" : fmt(gpu)}`,
      );
      for (const t of c.tasks ?? []) {
        console.log(`    pid ${String(t.pid).padEnd(7)} ${taskName(t).padEnd(32)} cpu=${fmt(t.cputime_ms_per_s)}`);
      }
    }

    for (const pid of app) {
      const path = processPath(pid);
      const kind = classifyBuild(path);
      console.log(`\nbuild: ${kind} — pid ${pid} ${path || "(path unavailable)"}`);
      if (kind === "dev") {
        console.log("  ! dev binary: Vite HMR and an unminified bundle. Measure the release .app instead.");
      }
    }
    return;
  }

  if (command === "report" || command === "save") {
    const latest = readJson(LATEST_PATH, null);
    if (!latest?.results?.length) {
      console.error(`No recent run found at ${LATEST_PATH.replace(REPO_ROOT, ".")}. Run \`run\` or \`sample\` first.`);
      process.exit(1);
    }
    console.log(renderReport(latest.results, flags.note));
    if (command === "save") saveRun(latest.results, flags.note);
    return;
  }

  primeSudo();

  let results;
  if (command === "sample") {
    const label = positional[1];
    if (!label) {
      console.error("sample needs a label, e.g. `sample idle-home`.");
      process.exit(1);
    }
    const existing = readJson(LATEST_PATH, { results: [] });
    const result = await sampleScenario(label, seconds);
    results = [...existing.results.filter((r) => r.label !== label), result];
  } else {
    results = await cmdRun(seconds);
  }

  if (!results.length) {
    console.log("No scenarios sampled.");
    return;
  }

  // Keep scenario order stable regardless of the order they were sampled in.
  const order = SCENARIOS.map((s) => s.label);
  results.sort((a, b) => {
    const ai = order.indexOf(a.label);
    const bi = order.indexOf(b.label);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  writeFileSync(LATEST_PATH, `${JSON.stringify({ results }, null, 2)}\n`);
  console.log(renderReport(results, flags.note));
  console.log(
    `Saved to ${LATEST_PATH.replace(REPO_ROOT, ".")} — run \`node scripts/perf-probe.mjs save --note "..."\` to append it to history.`,
  );
}

// Exported for src/__tests__/perfProbe.test.ts, which replays a recorded powermetrics
// plist through the real parser. Only self-execute when invoked directly.
export { extractSample, ourCoalitions, parsePlistStream, renderReport, rateFrom, windowServer };

if (process.argv[1] && process.argv[1].endsWith("perf-probe.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
