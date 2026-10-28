// The runner half shared by the two scripts that drive the running app for
// recordings: `capture-site-media.mjs` (the website's stills and clips) and
// `make-short.mjs` (YouTube Shorts). Control-API client, scene steps, the
// pointer, the screen. The pure decisions stay in `captureScenes.mjs` /
// `capturePlatform.mjs` / `shorts.mjs`, which are unit-tested; this is I/O.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWS_PARK_POINTER, profilesDir } from "./capturePlatform.mjs";
import { checkExpect, cropRect, parseScreenDevice, resolveRefs } from "./captureScenes.mjs";

export const PLATFORM = process.platform;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- control API --------------------------------------------------------

export function discovery(profile) {
  const file = join(profilesDir(PLATFORM, process.env, homedir()), profile, "control-api.json");
  if (!existsSync(file)) {
    throw new Error(`No control API for profile "${profile}" — start Viboplr and turn on Settings → General → AI control.`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function makeApi(profile) {
  return async function api(method, path, body) {
    const { port, token } = discovery(profile); // re-read: a restart rotates both
    const res = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error ?? text}`);
    return data;
  };
}

export async function runStep(api, step, facts) {
  const s = resolveRefs(step, facts);
  try {
    if (s.navigate) await api("POST", "/ui/navigate", s.navigate);
    else if (s.action) await api("POST", "/ui/action", s.action);
    else if (s.window) await api("POST", "/window", s.window);
    else if (s.playback) await api("POST", "/playback", s.playback);
    else if (s.skin) await api("POST", "/skins/apply", { name: s.skin });
    else if (s.wait) await sleep(s.wait);
    else if (s.seekSecs !== undefined) await api("POST", "/playback", { seekSecs: s.seekSecs });
    else if (s.seekFromEnd) {
      // The top-level duration is the decoder's and can still be null right
      // after a track loads; the queue entry's own duration is always there.
      const status = await api("GET", "/status");
      const duration = status.durationSecs ?? status.currentTrack?.durationSecs;
      if (!duration) throw new Error("the current track reports no duration");
      await api("POST", "/playback", { seekSecs: Math.max(0, duration - s.seekFromEnd) });
    } else if (s.playTemp) {
      await playTemp(api, s.playTemp, facts);
    } else if (s.click) {
      // Generic input (POST /v1/ui/input): needs the profile's "Click and
      // type" assistant permission. The cursor glides there on camera.
      await api("POST", "/ui/input", { kind: "click", target: s.click, moveMs: s.moveMs });
    } else if (s.type) {
      await api("POST", "/ui/input", { kind: "type", ...s.type });
    } else if (s.key) {
      await api("POST", "/ui/input", { kind: "key", keys: s.key });
    } else if (s.createSkin) {
      // What an assistant's manage_extensions create_skin sends (POST /v1/skins).
      await api("POST", "/skins", { skin: s.createSkin });
    } else if (s.check === "bitPerfect") {
      // The gem is green only once the engine verified exclusive access at
      // the file's rate; anything else would be a take that shows a claim
      // the app itself didn't make. Warn, don't abort: the take may still
      // be usable for timing.
      const bp = (await api("GET", "/status")).bitPerfect;
      if (bp?.state === "bit-perfect") console.log(`  bit-perfect verified on "${bp.device}" (shown on camera)`);
      else console.warn(`  bit-perfect NOT verified: ${JSON.stringify(bp)}`);
    }
  } catch (e) {
    if (!step.optional) throw e;
  }
}

/** Insert a library track after the current one and play it, remembering
 *  how to undo that (`facts.undo`, drained after the scene). */
async function playTemp(api, trackId, facts) {
  const before = await api("GET", "/status");
  await api("POST", "/queue/tracks", { trackIds: [trackId], mode: "next", allowDuplicates: true });
  // The add lands through React state, so the first read can predate it.
  let index = -1;
  for (let tries = 0; tries < 15 && index < 0; tries++) {
    if (tries) await sleep(200);
    const queue = await api("GET", "/queue");
    index = queue.tracks.findIndex((t, i) => i > queue.index && t.libraryId === trackId);
  }
  if (index < 0) throw new Error(`track ${trackId} didn't land in the queue`);
  await api("POST", "/queue/jump", { index });
  // The jump starts the track itself. A stream (a Subsonic server) takes a
  // moment to open, and a play sent before it has would resume the track
  // being replaced — so wait for it to be the current one first.
  let landed = false;
  for (let tries = 0; tries < 50 && !landed; tries++) {
    const status = await api("GET", "/status");
    landed = status.currentTrack?.libraryId === trackId;
    if (landed && !status.playing) await api("POST", "/playback", { play: true });
    if (!landed) await sleep(200);
  }
  if (!landed) console.warn(`  track ${trackId} didn't start within 10s — the take shows whatever is playing`);
  facts.undo.push(async () => {
    const q = await api("GET", "/queue");
    const at = q.tracks.findIndex((t) => t.libraryId === trackId);
    if (at >= 0) await api("DELETE", "/queue/tracks", { indices: [at] });
    if (before.queueIndex !== undefined && before.queueIndex !== null) {
      await api("POST", "/queue/jump", { index: before.queueIndex });
      if (before.positionSecs) await api("POST", "/playback", { seekSecs: before.positionSecs });
    }
  });
}

/** Move the pointer to the right edge of the main display. It is left over
 *  the window otherwise, where it shows in videos and leaves a hover effect
 *  on whatever it rests on (both seen on the first run). */
export function parkPointer() {
  if (PLATFORM === "win32") {
    run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PARK_POINTER]);
    return;
  }
  const bin = join(tmpdir(), "viboplr-park-pointer");
  if (!existsSync(bin)) {
    const src = `${bin}.swift`;
    writeFileSync(src, [
      "import CoreGraphics",
      "let b = CGDisplayBounds(CGMainDisplayID())",
      "CGWarpMouseCursorPosition(CGPoint(x: b.maxX - 2, y: b.midY))",
    ].join("\n"));
    run("swiftc", ["-O", src, "-o", bin]);
  }
  run(bin, []);
}

/** Poll the UI until it matches the scene's expectation (or give up). */
export async function waitForExpect(api, expect, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let problems = [];
  while (Date.now() < end) {
    problems = checkExpect(await api("GET", "/ui"), expect);
    if (problems.length === 0) return [];
    await sleep(300);
  }
  return problems;
}

/** macOS output mute state, or null when it can't be read. */
export function systemMuted() {
  const r = spawnSync("osascript", ["-e", "output muted of (get volume settings)"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() === "true" : null;
}

export function setSystemMuted(on) {
  spawnSync("osascript", ["-e", `set volume output muted ${on}`]);
}

export function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return r;
}

/** The window's painted rectangle in the pixels the grabber uses. `client`,
 *  not `frame`: on Windows the outer frame carries an invisible resize border,
 *  and cropping to it grabbed a strip of desktop. `frame` is the fallback for
 *  an app build that predates `client`. */
export async function windowRect(api, opts, screen, pad = 0) {
  const win = await api("GET", "/window");
  return { win, rect: cropRect(win.client ?? win.frame, opts.grabScale ?? win.scaleFactor, screen, pad) };
}

export function screenInfo() {
  // gdigrab takes the rectangle directly and needs no device; the window is
  // placed well inside the primary screen, so there is nothing to clamp to.
  if (PLATFORM === "win32") return { device: null, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };
  const listing = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8" }).stderr;
  const device = parseScreenDevice(listing);
  if (device === null) throw new Error("ffmpeg sees no screen to record (Screen Recording permission?)");
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-i", `${device}:none`, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const m = /, (\d{3,5})x(\d{3,5})/.exec(probe);
  if (!m) throw new Error("couldn't read the screen size from ffmpeg");
  return { device, width: Number(m[1]), height: Number(m[2]) };
}

/** macOS: is the login session's screen locked? caffeinate keeps the display
 *  awake but cannot keep it unlocked, and a locked Mac neither paints the
 *  app's web content nor shows its window to a grab — measured: a whole run
 *  "verified" every scene against GET /v1/ui and saved blank panes and the
 *  lock screen. Windows has no equivalent probe here; it reports false. */
export function screenLocked() {
  if (PLATFORM !== "darwin") return false;
  const r = spawnSync("ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" });
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(r.stdout ?? "");
}
