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
//   node scripts/perf-probe.mjs run --auto [--settle 10]  unattended walk (drives the
//                                                    app itself; needs the perf profile)
//        ... --video <path> --waveform <path> --artist <name>
//                                                    also run those scenarios, which need
//                                                    real media / a real artist on this machine
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
// Launching / steering / quitting the app is shared with scripts/app-smoke.mjs.
import {
  run,
  sleep,
  appPids,
  processPath,
  quitApp,
  launchApp,
  assertProbeProfile,
  resolveAppBundle,
  probeLink,
  probeDumpPath,
  waitFor,
  APP_NAME,
} from "./lib/appControl.mjs";
import { compareState } from "./lib/appSmoke.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = join(REPO_ROOT, "benchmarks", "resource-usage.json");
const LATEST_PATH = join(REPO_ROOT, "benchmarks", ".resource-usage-latest.json");

// A window shorter than this is dominated by whatever the app was doing when you
// hit Enter rather than by its steady state.
const DEFAULT_SECONDS = 60;
// Long enough for a launch, a view switch and the window animation to finish, so
// none of that lands inside the sampled window. See cmdRunAuto.
const DEFAULT_SETTLE_SECONDS = 10;
const SAMPLE_INTERVAL_MS = 1000;

const BASELINE_LABEL = "baseline-quit";

/**
 * Build the *complete* probe state for a scenario, not just what changed.
 *
 * Every drive declares every axis, because scenarios can be skipped: three are
 * gated on `--video` / `--waveform` / `--artist`, and a delta-style drive
 * inherits whatever the last scenario that *did* run left behind. That produced
 * real, silent breakage — `playing-fullscreen` left fullscreen on, so with no
 * `--artist` the next scenario toggled mini mode out of a fullscreen window; and
 * `playing-mini` left mini mode on, so `playing-video` would have measured the
 * mini player and labelled it video decode.
 *
 * `window=restore` is unconditional for the same reason. Minimizing is not part
 * of this — it has to happen after verification (see `after`), because a
 * miniaturized webview is throttled and may not answer a dump promptly.
 */
function stateQuery({ view, artist, play = false, mini = false, fullscreen = false }) {
  const parts = [
    "window=restore",
    `fullscreen=${fullscreen ? "on" : "off"}`,
    `mini=${mini ? "on" : "off"}`,
  ];
  if (view) parts.push(`view=${view}`);
  if (artist) parts.push(`artist=${encodeURIComponent(artist)}`);
  parts.push(`play=${play ? "on" : "off"}`);
  return parts.join("&");
}

/** What the dump must report after a scenario's drive, before we sample it. */
function expectState({ view, playing = false, miniMode = false, fullscreen = false }) {
  return { view, playing, miniMode, fullscreen };
}

// Ordered so each step isolates one additional cost over the step before it. The
// minimized/visible pair is the important one: it separates "playing audio costs
// this" from "drawing the UI costs this", and only the second half is ours to fix.
const SCENARIOS = [
  {
    label: BASELINE_LABEL,
    setup: "Quit Viboplr completely (Cmd-Q). Nothing of the app may be running.",
    isolates: "Noise floor of everything else on the machine.",
    drive: async () => { await quitApp(); },
  },
  {
    label: "idle-home",
    setup: "Launch Viboplr, let it settle on the Home view, then leave it alone.",
    isolates: "Shelf artwork, image cache, transparent-window compositing at rest.",
    drive: async () => { await launchApp(); await probeLink(stateQuery({ view: "home" })); },
    expect: expectState({ view: "home" }),
  },
  {
    label: "idle-static",
    // NOT Settings: SettingsPanel's mount effect fires dependencies.checkAll()
    // + checkUpdates(), and `yt-dlp --version` alone takes ~16s on this machine
    // (see CLAUDE.md). That subprocess burst landed inside the window of the one
    // scenario meant to be the app's floor. History is a plain list view with no
    // infinite CSS animations and no probe on mount.
    setup: "Still idle, nothing playing. Open History (a plain list, nothing animating).",
    isolates: "The app truly at rest — idle-home minus this is the hero carousel's cost.",
    drive: async () => { await probeLink(stateQuery({ view: "history" })); },
    expect: expectState({ view: "history" }),
  },
  {
    label: "detail-hero",
    // Sits next to idle-static because that is the baseline its own delta is
    // against, and because it is an idle scenario — wedged into the playing
    // chain it used to stop playback halfway through.
    setup: "Nothing playing. Open an artist detail page (needs an FX hero look — see CLAUDE.md).",
    // DetailHeroEffect stacks ~9 infinite animations, including tv-noise
    // repainting a tiled layer ~3x a second. It is the most animation-heavy
    // surface in the app and was unreachable until the probe could open a
    // detail page.
    isolates: "DetailHeroEffect's animation stack — this minus idle-static is its cost.",
    needsArg: "artist",
    drive: async (args) => { await probeLink(stateQuery({ artist: args.artist })); },
    expect: expectState({ view: "artists" }),
  },
  {
    label: "playing-minimized",
    setup: "Play a LOCAL audio file, then minimize the window (Cmd-M).",
    isolates: "libmpv decode with the renderer parked — the true cost of audio.",
    // The perf profile restores its own queue on launch, so `play=on` is enough
    // — no fixture file, and the same real track every run.
    drive: async () => { await probeLink(stateQuery({ view: "search", play: true })); },
    // Verified while still visible, then minimized: a miniaturized webview is
    // throttled and may not answer a dump in time.
    expect: expectState({ view: "search", playing: true }),
    after: async () => { await probeLink("window=minimize"); },
  },
  {
    label: "playing-visible",
    setup: "Same local track still playing. Restore the window on the library list, don't scroll.",
    isolates: "Cost of showing the UI while audio plays (delta vs the previous step).",
    drive: async () => { await probeLink(stateQuery({ view: "search", play: true })); },
    expect: expectState({ view: "search", playing: true }),
  },
  {
    label: "playing-nowplaying",
    setup: "Same track still playing. Open the Now Playing view (artwork + lyrics).",
    isolates: "In-window compositing worst case: backdrop blur, artwork, lyrics.",
    drive: async () => { await probeLink(stateQuery({ view: "nowplaying", play: true })); },
    expect: expectState({ view: "nowplaying", playing: true }),
  },
  {
    label: "playing-fullscreen",
    setup: "Same track still playing. Enter fullscreen (Cmd+F) and leave the pointer still.",
    isolates: "Full-screen compositing — the whole display recomposited every frame.",
    drive: async () => {
      await probeLink(stateQuery({ view: "nowplaying", play: true, fullscreen: true }));
    },
    expect: expectState({ view: "nowplaying", playing: true, fullscreen: true }),
  },
  {
    label: "playing-mini",
    setup: "Same track still playing. Switch to the mini player and leave the pointer off it.",
    isolates: "Mini player window: compact bar render + the cycling Now Playing info line.",
    drive: async () => { await probeLink(stateQuery({ play: true, mini: true })); },
    expect: expectState({ view: "nowplaying", playing: true, miniMode: true }),
  },
  {
    label: "playing-video",
    setup: "Play a video in the theater.",
    isolates: "mpv hardware decode + video presentation path.",
    optional: true,
    // Automatable, but only against a file this machine actually has — hence
    // --video rather than a checked-in fixture. Skipped when not supplied.
    needsArg: "video",
    drive: async (args) => {
      // Full reset first: this runs after playing-mini, so without it the
      // "theater" would be the mini player.
      await probeLink(stateQuery({ view: "nowplaying" }));
      await probeLink(`open=${encodeURIComponent(args.video)}`);
    },
    expect: expectState({ view: "nowplaying", playing: true }),
  },
  {
    label: "collection-sync",
    setup: "Trigger a collection sync / rescan and leave it running for the whole window.",
    isolates: "Scan burst: CPU, disk, DB writes.",
    // Deliberately no `drive`: a rescan is a library mutation, which is exactly
    // what the probe route is not allowed to trigger. Guided mode only.
    optional: true,
  },
  {
    label: "waveform",
    setup: "Open a local track under 15 MB so its waveform generates.",
    isolates: "Waveform decode pass.",
    optional: true,
    needsArg: "waveform",
    drive: async (args) => {
      await probeLink(stateQuery({ view: "nowplaying" }));
      await probeLink(`open=${encodeURIComponent(args.waveform)}`);
    },
    expect: expectState({ view: "nowplaying", playing: true }),
  },
];

/* ---------------------------------------------------------------- utilities */

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
    if (a.startsWith("--")) {
      // A following token that is itself a flag is the *next* flag, not this
      // one's value — otherwise `--auto --settle 5` swallows `--settle`.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
      else flags[a.slice(2)] = argv[++i];
    } else positional.push(a);
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

/**
 * Unattended walk. Each scenario's `drive` puts the app in the state, then we
 * wait `settle` seconds before sampling — without that pause the launch, view
 * switch or window animation lands inside the window and, e.g., idle-home
 * absorbs the whole cost of starting the app. (The guided mode gets this for
 * free: the human only presses Enter once things look calm.)
 *
 * A scenario is run when it has a `drive` and, if it declares `needsArg`, the
 * matching `--video` / `--waveform` path was supplied. Those two can't ship a
 * fixture — they need real media on *this* machine — so they stay opt-in rather
 * than silently sampling nothing. `collection-sync` has no `drive` at all: a
 * rescan is a library mutation, which is exactly what the probe route is not
 * allowed to trigger.
 */
/**
 * Ask the app what state it is in and compare against what the scenario wanted.
 *
 * The stale-file delete matters for the same reason it does in app-smoke: the
 * dump lands at a fixed path, so last scenario's file would "verify" this one.
 */
async function readDump() {
  const dumpPath = probeDumpPath();
  // The dump lands at a fixed path, so last scenario's file would "verify" this
  // one. Same reasoning as app-smoke.
  rmSync(dumpPath, { force: true });
  await probeLink("dump=on");
  await waitFor(() => existsSync(dumpPath), 15000, "the app to answer with its state");
  return JSON.parse(readFileSync(dumpPath, "utf8"));
}

async function verifyState(expected) {
  let dump;
  try {
    dump = await readDump();
  } catch (e) {
    return `app did not answer a dump request (${e.message})`;
  }
  return compareState(dump, expected);
}

async function cmdRunAuto(seconds, settle, paths = {}) {
  const bundle = resolveAppBundle();
  if (!bundle) {
    throw new Error(`No application named "${APP_NAME}" is registered — --auto cannot launch it.`);
  }
  console.log(`\nDriving: ${bundle}`);
  if (!bundle.startsWith("/Applications/")) {
    console.warn("  ! Not in /Applications — this is probably a dev build. Profile the release build.");
  }

  // Ask the app what it has rather than requiring the caller to know. Without
  // this `--artist` is a name a human has to look up first, which is not much
  // of an unattended run. An explicit --artist still wins.
  if (!paths.artist) {
    try {
      await launchApp();
      const discovered = (await readDump())?.library?.artistNames?.[0];
      if (discovered) {
        paths = { ...paths, artist: discovered };
        console.log(`\nDiscovered artist for detail-hero: ${discovered}`);
      }
    } catch (e) {
      console.warn(`  ! Could not ask the app what it has (${e.message}); detail-hero may skip.`);
    }
  }

  const runnable = (sc) => sc.drive && (!sc.needsArg || paths[sc.needsArg]);
  const drivable = SCENARIOS.filter(runnable);
  const skipped = SCENARIOS.filter((sc) => !runnable(sc)).map(
    (sc) => `${sc.label}${sc.needsArg ? ` (pass --${sc.needsArg})` : ""}`,
  );
  const results = [];

  console.log(
    `\nUnattended run: ${drivable.length} scenarios × (${settle}s settle + ${seconds}s sample) ` +
      `≈ ${Math.ceil((drivable.length * (settle + seconds)) / 60)} min.\n` +
      `Do not use the machine while it runs — foreground state is part of what is measured.\n` +
      (skipped.length ? `Skipping: ${skipped.join(", ")}\n` : ""),
  );

  for (const scenario of drivable) {
    console.log(`\n=== ${scenario.label}`);
    console.log(`    ${scenario.setup}`);
    try {
      await scenario.drive(paths);
    } catch (e) {
      console.error(`    ! could not reach this state: ${e.message}`);
      continue;
    }
    // The baseline has no app to verify, and quitApp already proved it is gone.
    if (scenario.label !== BASELINE_LABEL) assertProbeProfile();
    // Confirm the drive actually landed before spending a minute measuring it.
    // Without this every state gap is a plausible number rather than an error:
    // an empty queue makes every "playing" scenario silently sample an idle app.
    if (scenario.expect) {
      const mismatch = await verifyState(scenario.expect);
      if (mismatch) {
        console.error(`    ! state not reached, skipping: ${mismatch}`);
        continue;
      }
    }
    // Only now, after verification — a miniaturized webview is throttled and
    // may not answer a dump in time.
    if (scenario.after) await scenario.after();
    console.log(`    settling ${settle}s ...`);
    await sleep(settle * 1000);
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
  const settle = Number(flags.settle ?? DEFAULT_SETTLE_SECONDS);
  if (!Number.isFinite(settle) || settle < 0) {
    console.error("--settle must be a number >= 0.");
    process.exit(1);
  }
  // Optional inputs for the scenarios that can't ship a fixture — they need
  // real media, or a real artist, on *this* machine. Validated here, before
  // sudo: a typo should not cost a password prompt, and it must not surface
  // eight minutes later as an empty scenario.
  const mediaPaths = {};
  for (const [key, kind] of [["video", "path"], ["waveform", "path"], ["artist", "name"]]) {
    if (flags[key] === undefined) continue;
    if (typeof flags[key] !== "string" || !flags[key]) {
      console.error(`--${key} needs a value.`);
      process.exit(1);
    }
    if (kind === "path") {
      if (!flags[key].startsWith("/")) {
        console.error(`--${key} needs an absolute path.`);
        process.exit(1);
      }
      if (!existsSync(flags[key])) {
        console.error(`--${key}: no such file or folder: ${flags[key]}`);
        process.exit(1);
      }
    }
    mediaPaths[key] = flags[key];
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
  } else if (flags.auto) {
    results = await cmdRunAuto(seconds, settle, mediaPaths);
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
