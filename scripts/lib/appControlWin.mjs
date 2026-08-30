// Windows counterpart to appControl.mjs's macOS-only process/lifecycle helpers.
//
// The mac file drives the app through `pgrep`/`ps`/`osascript`/`open` — none of
// which exist on Windows. This file gives the same operations (find the app's
// pids, launch it, quit it, resolve where it's installed, fire the
// viboplr://probe deep link, and locate its profile dump) using PowerShell/WMI
// equivalents, so appControl.mjs can dispatch to this module on win32 instead
// of forking every call site in perf-probe.mjs / app-smoke.mjs.
//
// One thing IS simpler here than on mac: WebView2's helper processes
// (msedgewebview2.exe: browser/renderer/GPU/utility) stay real child processes
// of the exe. macOS's launchd reparents WKWebView's helpers to PPID 1, which is
// why that file needs the powermetrics-coalition workaround; Windows needs only
// an ordinary parent/child process-tree walk.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const EXE_NAME = "viboplr.exe";
export const PRODUCT_NAME = "Viboplr";

let psExe = null;
/** Prefer PowerShell 7 (pwsh) when present; both understand the same commands used here. */
function powershellExe() {
  if (psExe) return psExe;
  const pwsh = spawnSync("where", ["pwsh.exe"], { encoding: "utf8" });
  psExe = pwsh.status === 0 && pwsh.stdout.trim() ? "pwsh.exe" : "powershell.exe";
  return psExe;
}

/**
 * Run a PowerShell command and parse its stdout as JSON.
 *
 * Every query here ends in `ConvertTo-Json`, and a single result collapses to a
 * bare object rather than a one-element array — callers normalize that.
 */
function psJson(command, fallback) {
  const res = spawnSync(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout.trim()) return fallback;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return fallback;
  }
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/* ------------------------------------------------------- process attribution */

export function appPidsWin() {
  const rows = asArray(
    psJson(
      `Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | Select-Object ProcessId | ConvertTo-Json`,
      [],
    ),
  );
  return rows.map((r) => Number(r.ProcessId)).filter((n) => Number.isInteger(n) && n > 0);
}

export function processPathWin(pid) {
  const row = psJson(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ExecutablePath | ConvertTo-Json`,
    null,
  );
  return row?.ExecutablePath ?? "";
}

/** Launch argv of a running pid, for verifying which profile it came up under. */
export function processArgsWin(pid) {
  const row = psJson(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object CommandLine | ConvertTo-Json`,
    null,
  );
  return row?.CommandLine ?? "";
}

/**
 * Every live descendant of `rootPids`, refreshed fresh (Windows process listing
 * is a complete, un-thresholded snapshot — no powermetrics-style "omitted below
 * threshold" gotcha to work around here).
 */
export function processTreeWin(rootPids) {
  const all = asArray(
    psJson(
      `Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json`,
      [],
    ),
  );
  const tracked = new Set(rootPids.map(Number));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) {
      const pid = Number(p.ProcessId);
      const ppid = Number(p.ParentProcessId);
      if (tracked.has(ppid) && !tracked.has(pid)) {
        tracked.add(pid);
        grew = true;
      }
    }
  }
  return [...tracked];
}

/* --------------------------------------------------------------- lifecycle */

export async function quitAppWin({ waitFor, probeLink, appPids, onProbeProfile }) {
  if (!appPids().length) return;
  if (onProbeProfile()) {
    await probeLink("quit=on");
    try {
      await waitFor(() => appPids().length === 0, 10000, "Viboplr to exit via probe");
      return;
    } catch {
      console.warn("  ! Probe quit did not take; falling back to a normal quit.");
    }
  }
  spawnSync("taskkill", ["/IM", EXE_NAME, "/T"], { encoding: "utf8" });
  try {
    await waitFor(() => appPids().length === 0, 20000, "Viboplr to quit");
  } catch {
    console.warn("  ! Viboplr did not quit on request; forcing termination.");
    spawnSync("taskkill", ["/IM", EXE_NAME, "/T", "/F"], { encoding: "utf8" });
    await waitFor(() => appPids().length === 0, 10000, "Viboplr to terminate");
  }
}

export function launchAppWin(exePath, args) {
  // PowerShell array literals are `@('a','b')`, not JSON's `['a','b']` — the
  // latter parses as an indexing/type expression and Start-Process silently
  // rejects it as a stray positional argument.
  const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const argList = args.length ? `@(${args.map(psQuote).join(",")})` : "@()";
  // Detached + no window redirection, so this script's stdio isn't inherited
  // by the app and closing the launcher doesn't take the app down with it.
  spawnSync(
    powershellExe(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process -FilePath ${psQuote(exePath)} -ArgumentList ${argList}`,
    ],
    { encoding: "utf8" },
  );
}

/**
 * Where an installed release lives, and what we drive unless told otherwise.
 *
 * Tauri's NSIS installer for this app has no `windows.nsis.installMode`
 * override, so it can land per-user (`%LOCALAPPDATA%\Viboplr`) or per-machine
 * (`%ProgramFiles%\Viboplr`) depending on how the installer was run — unlike
 * macOS there's no single canonical `/Applications` to prefer. Check both
 * common locations first (cheap, no subprocess), then fall back to the
 * uninstall-registry entry Tauri's NSIS installer writes, which is the only
 * place that's authoritative regardless of install mode.
 */
export function resolveAppBundleWin() {
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, PRODUCT_NAME, EXE_NAME),
    process.env.ProgramFiles && join(process.env.ProgramFiles, PRODUCT_NAME, EXE_NAME),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], PRODUCT_NAME, EXE_NAME),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;

  const rows = asArray(
    psJson(
      `Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', ` +
        `'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', ` +
        `'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.DisplayName -like '${PRODUCT_NAME}*' } | ` +
        `Select-Object -First 1 InstallLocation | ConvertTo-Json`,
      null,
    ),
  );
  const installLocation = rows[0]?.InstallLocation;
  if (installLocation) {
    const exe = join(installLocation, EXE_NAME);
    if (existsSync(exe)) return exe;
  }
  return "";
}

/**
 * Send one `viboplr://probe?...` command via the OS-registered protocol
 * handler (tauri-plugin-deep-link registers it in the Windows registry), the
 * same way `open -a <bundle> viboplr://...` does on mac. `Start-Process` here
 * is ShellExecute, so it resolves through the registry rather than requiring
 * us to know which install handles it.
 */
export function probeLinkWin(url) {
  spawnSync(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`], {
    encoding: "utf8",
  });
}

/**
 * Mirrors Tauri's `app_data_dir()` on Windows: `%APPDATA%\<identifier>`
 * (roaming), matching `com.alex.viboplr` from tauri.conf.json. See
 * probeDumpPath in appControl.mjs for the mac equivalent.
 */
export function probeDumpPathWin(bundleId, profile) {
  return join(process.env.APPDATA, bundleId, "profiles", profile, "probe-dump.json");
}
