// Driving the real, built Viboplr app from a script.
//
// Shared by `scripts/perf-probe.mjs` (unattended resource profiling) and
// `scripts/app-smoke.mjs` (post-build smoke test + startup series). Both need
// to launch, steer and quit the same app, so the mechanism lives here rather
// than being copied — the two would drift on the first fix.
//
// Every state change goes through the `viboplr://probe` deep link
// (src/utils/probeControl.ts) rather than scripted keystrokes: keystrokes need
// the terminal granted Accessibility, they land on whatever app is frontmost,
// and Cmd-M in this app is *mute* — scripting the obvious "minimize" chord
// would silently mute the audio the perf probe exists to measure.
//
// macOS only (osascript / pgrep / open).

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// The probe route is gated on this profile name; a default-profile app ignores
// the links entirely, which would silently produce a run of wrong results.
export const PROBE_PROFILE = "perf";
export const APP_NAME = "Viboplr";
export const BUNDLE_ID = "com.alex.viboplr";
// Time from "the process exists" to "the webview is listening for deep links".
export const LAUNCH_GRACE_MS = 8000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function run(cmd, args, { allowFailure = false, maxBuffer } = {}) {
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

export async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
}

/* ------------------------------------------------------- process attribution */

export function appPids() {
  // Both builds run a binary named `viboplr` — see classifyBuild in perf-probe.
  const res = run("pgrep", ["-i", "-x", "viboplr"], { allowFailure: true });
  return res.stdout
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function processPath(pid) {
  const res = run("ps", ["-p", String(pid), "-o", "comm="], { allowFailure: true });
  return res.ok ? res.stdout.trim() : "";
}

/** Launch argv of a running pid, for verifying which profile it came up under. */
export function processArgs(pid) {
  const res = run("ps", ["-p", String(pid), "-o", "args="], { allowFailure: true });
  return res.ok ? res.stdout.trim() : "";
}

/* --------------------------------------------------------------- lifecycle */

/** Non-throwing form of assertProbeProfile, for deciding how to quit. */
export function onProbeProfile() {
  const args = appPids().map(processArgs).join(" ");
  return new RegExp(`--profile[= ]${PROBE_PROFILE}\\b`).test(args);
}

export async function quitApp() {
  if (!appPids().length) return;
  // Prefer the probe route when it's available: it flushes the debounced store
  // before exiting (the perf profile's persisted queue is what the next run
  // replays, and store writes are debounced 500ms), and an open modal can
  // swallow Cmd-Q outright. Falls through to a normal quit if it doesn't take.
  if (onProbeProfile()) {
    await probeLink("quit=on");
    try {
      await waitFor(() => appPids().length === 0, 10000, "Viboplr to exit via probe");
      return;
    } catch {
      console.warn("  ! Probe quit did not take; falling back to a normal quit.");
    }
  }
  run("osascript", ["-e", `quit app "${APP_NAME}"`], { allowFailure: true });
  try {
    await waitFor(() => appPids().length === 0, 20000, "Viboplr to quit");
  } catch {
    // A hung webview helper must not abort the whole run — the caller just
    // needs the processes gone, and SIGTERM is the honest way to get there.
    console.warn("  ! Viboplr did not quit on request; sending SIGTERM.");
    run("pkill", ["-i", "-x", "viboplr"], { allowFailure: true });
    await waitFor(() => appPids().length === 0, 10000, "Viboplr to terminate");
  }
}

export async function launchApp() {
  if (appPids().length) return;
  // `open` cannot set env vars, but lib.rs also reads `--profile <name>` from
  // argv — and unlike VIBOPLR_PROFILE that leaves a trace in `ps` we can verify.
  run("open", ["-a", APP_NAME, "--args", "--profile", PROBE_PROFILE], { allowFailure: true });
  await waitFor(() => appPids().length > 0, 30000, "Viboplr to launch");
  assertProbeProfile();
  // A pid is not a mounted webview. The probe route stays closed until App.tsx's
  // `get_profile_info` resolves, so a link fired the instant the process appears
  // is dropped on the floor — give the frontend time to come up first.
  await sleep(LAUNCH_GRACE_MS);
}

/**
 * Fail loudly if the running app is not on the probe profile. Without this the
 * deep links would be silently ignored and every step would observe the same
 * state — a full run of plausible, wrong results.
 */
export function assertProbeProfile() {
  const pids = appPids();
  const args = pids.map(processArgs).join(" ");
  if (!new RegExp(`--profile[= ]${PROBE_PROFILE}\\b`).test(args)) {
    throw new Error(
      `Viboplr is running but not under the "${PROBE_PROFILE}" profile, so viboplr://probe ` +
        `links are ignored. Quit it and let the script launch it, or see CLAUDE.md for the ` +
        `one-time perf-profile setup.`,
    );
  }
}

/**
 * Which bundle `open -a` (and therefore the viboplr:// handler) will actually
 * hit. CLAUDE.md notes the process *name* cannot tell dev from release apart, so
 * a run that silently drives the wrong bundle is a real hazard — resolve it up
 * front and say so out loud.
 */
export function resolveAppBundle() {
  const res = run("osascript", ["-e", `POSIX path of (path to application "${APP_NAME}")`], {
    allowFailure: true,
  });
  return res.ok ? res.stdout.trim() : "";
}

/* ------------------------------------------------------------ deep link */

/**
 * Send one `viboplr://probe?...` command and give the app a beat to apply it.
 *
 * The `_n` nonce is required, not cosmetic: App.tsx's deep-link handler dedupes
 * by exact URL (a link can arrive twice — once via the event, once via
 * getCurrent), so without it the second step to need e.g. `play=on` would be
 * silently dropped and observed in the wrong state.
 */
let probeNonce = 0;
export async function probeLink(query) {
  run("open", [`viboplr://probe?${query}&_n=${++probeNonce}`], { allowFailure: true });
  await sleep(1200);
}

/**
 * Where `write_probe_dump` puts the state dump. Mirrors `PROBE_DUMP_FILE` and
 * the profile-dir layout in `commands/app.rs` / `lib.rs` — the URL deliberately
 * carries no path, so both sides compute this independently.
 */
export function probeDumpPath(profile = PROBE_PROFILE) {
  return join(
    homedir(),
    "Library",
    "Application Support",
    BUNDLE_ID,
    "profiles",
    profile,
    "probe-dump.json",
  );
}
