#!/usr/bin/env node
// Capture the website's persona-page media (docs/for/*.html) from the real,
// running app — `npm run capture:media`.
//
// Drives the app through the control API's UI verbs (navigate / ui action /
// window geometry, see src/utils/uiControl.ts) and captures with the macOS
// tools the terminal already has permission for: `screencapture -l<windowId>`
// for stills, ffmpeg's avfoundation screen grab cropped to the window for
// videos. The app never captures itself (see control_api.rs / backend.md).
//
// The window is brought to the front for EVERY scene, stills included: macOS
// stops painting a WKWebView whose window is covered, so `screencapture -l`
// of a background window returns its last composited frame — measured: every
// still came back showing the page from before the navigation.
//
// Every scene is verified before it is captured (GET /v1/ui against the
// scene's `expect`), so a page that didn't land is skipped, not saved. The
// app's state — window, skin, hero look, volume, playback — is restored at the
// end, also on failure.
//
// Needs: macOS, Viboplr running with Settings → General → AI control on,
// ffmpeg (libx264 + libvpx-vp9) and cwebp on PATH. The run takes the front of
// the screen while it works — don't type into other apps meanwhile.
//
// Usage:
//   npm run capture:media -- [--profile default] [--only home,lyrics] [--list]
//     [--out docs/assets/media] [--width 1440 --height 900] [--settle 2500]
//     [--no-video] [--keep-volume] [--artist "Name"]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANUAL_CAPTURES,
  SCENES,
  checkExpect,
  cropRect,
  encodeArgs,
  missingNeeds,
  parseScreenDevice,
  resolveRefs,
} from "./lib/captureScenes.mjs";

const BUNDLE_ID = "com.alex.viboplr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = {
    profile: "default", only: null, list: false, out: "docs/assets/media",
    width: 1440, height: 900, x: 40, y: 60, settle: 2500, video: true, keepVolume: false, artist: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--profile") o.profile = next();
    else if (a === "--only") o.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--list") o.list = true;
    else if (a === "--out") o.out = next();
    else if (a === "--width") o.width = Number(next());
    else if (a === "--height") o.height = Number(next());
    else if (a === "--settle") o.settle = Number(next());
    else if (a === "--no-video") o.video = false;
    else if (a === "--keep-volume") o.keepVolume = true;
    else if (a === "--artist") o.artist = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

// --- control API --------------------------------------------------------

function discovery(profile) {
  const file = join(homedir(), "Library", "Application Support", BUNDLE_ID, "profiles", profile, "control-api.json");
  if (!existsSync(file)) {
    throw new Error(`No control API for profile "${profile}" — start Viboplr and turn on Settings → General → AI control.`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function makeApi(profile) {
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

async function runStep(api, step, facts) {
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
  const queue = await api("GET", "/queue");
  const index = queue.tracks.findIndex((t, i) => i > queue.index && t.libraryId === trackId);
  if (index < 0) throw new Error(`track ${trackId} didn't land in the queue`);
  await api("POST", "/queue/jump", { index });
  await api("POST", "/playback", { play: true });
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
function parkPointer() {
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
async function waitForExpect(api, expect, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let problems = [];
  while (Date.now() < end) {
    problems = checkExpect(await api("GET", "/ui"), expect);
    if (problems.length === 0) return [];
    await sleep(300);
  }
  return problems;
}

// --- capture --------------------------------------------------------------

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return r;
}

async function captureStill(api, out, scene) {
  const id = scene.id;
  const win = await api("GET", "/window");
  if (!win.windowId) throw new Error("the app reported no window id (macOS only)");
  const png = join(tmpdir(), `viboplr-${id}.png`);
  run("screencapture", ["-x", "-o", `-l${win.windowId}`, png]);
  const crop = [];
  if (scene.cropBottom) {
    const dims = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png]).stdout;
    const w = Number(/pixelWidth: (\d+)/.exec(dims)[1]);
    const h = Number(/pixelHeight: (\d+)/.exec(dims)[1]);
    crop.push("-crop", "0", "0", String(w), String(Math.round(h * (1 - scene.cropBottom))));
  }
  run("cwebp", ["-quiet", "-q", "90", ...crop, png, "-o", join(out, `${id}.webp`)]);
  rmSync(png, { force: true });
  return [`${id}.webp`];
}

function screenInfo() {
  const listing = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8" }).stderr;
  const device = parseScreenDevice(listing);
  if (device === null) throw new Error("ffmpeg sees no screen to record (Screen Recording permission?)");
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-i", `${device}:none`, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const m = /, (\d{3,5})x(\d{3,5})/.exec(probe);
  if (!m) throw new Error("couldn't read the screen size from ffmpeg");
  return { device, width: Number(m[1]), height: Number(m[2]) };
}

async function captureVideo(api, out, scene, facts, screen) {
  await api("POST", "/window", { focus: true });
  await sleep(600);
  const win = await api("GET", "/window");
  const rect = cropRect(win.frame, win.scaleFactor, screen, scene.region?.pad ?? 0);
  const raw = join(tmpdir(), `viboplr-${scene.id}.mp4`);
  const ff = spawn("ffmpeg", [
    "-y", "-hide_banner", "-f", "avfoundation", "-capture_cursor", "0", "-framerate", "30",
    "-i", `${screen.device}:none`, "-t", String(scene.seconds),
    "-vf", `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", raw,
  ]);
  let log = "";
  const started = new Promise((res) => ff.stderr.on("data", (c) => { log += c; if (/frame=\s*\d+/.test(log)) res(); }));
  const exited = new Promise((res) => ff.on("close", res));
  await Promise.race([started, exited]);
  // `during` timings count from the first recorded frame, not from spawn.
  const timers = (scene.during ?? []).map((step) =>
    sleep(step.at).then(() => runStep(api, step, facts).catch((e) => console.error(`  during step failed: ${e.message}`))),
  );
  const code = await exited;
  await Promise.all(timers);
  if (code !== 0) throw new Error(`ffmpeg recording failed: ${log.trim().split("\n").slice(-2).join(" ")}`);
  const base = join(out, scene.id);
  const args = encodeArgs(raw, base);
  run("ffmpeg", args.mp4);
  run("ffmpeg", args.webm);
  run("ffmpeg", args.poster);
  run("cwebp", ["-quiet", "-q", "85", `${base}-poster.png`, "-o", `${base}-poster.webp`]);
  rmSync(`${base}-poster.png`, { force: true });
  rmSync(raw, { force: true });
  return [`${scene.id}.mp4`, `${scene.id}.webm`, `${scene.id}-poster.webp`];
}

// --- main -----------------------------------------------------------------

async function discoverFacts(api, opts) {
  const facts = { artist: opts.artist, albumTrackIds: null, lyricsTrackId: null, skin0: null, undo: [] };
  if (!facts.artist) {
    const r = await api("POST", "/query", {
      sql: "SELECT ar.name FROM artists ar JOIN tracks t ON t.artist_id = ar.id GROUP BY ar.id ORDER BY COUNT(*) DESC LIMIT 1",
    });
    facts.artist = r.rows?.[0]?.[0] ?? null;
  }
  // The biggest real album: placeholder titles ("[Unknown Album]", empty)
  // collect every untagged file and make a meaningless bulk-edit shot.
  const albums = await api("POST", "/query", {
    sql: "SELECT id FROM tracks WHERE album_id = (SELECT t.album_id FROM tracks t JOIN albums al ON al.id = t.album_id "
      + "WHERE al.title <> '' AND al.title NOT LIKE '[%' GROUP BY t.album_id ORDER BY COUNT(*) DESC LIMIT 1) LIMIT 40",
  });
  const ids = (albums.rows ?? []).map((row) => row[0]);
  facts.albumTrackIds = ids.length ? ids : null;
  // A library track whose synced lyrics are already cached, so the lyrics
  // video doesn't depend on a provider answering mid-recording. Cached keys
  // keep their original case, hence normalising both sides.
  const lyrics = await api("POST", "/query", {
    sql: "SELECT t.id FROM information_values iv JOIN information_types it ON it.id = iv.information_type_id "
      + "JOIN tracks t JOIN artists ar ON ar.id = t.artist_id WHERE it.type_id = 'lyrics' AND iv.value LIKE '%synced%' "
      + "AND strip_diacritics(unicode_lower(iv.entity_key)) = 'track:' || strip_diacritics(unicode_lower(ar.name)) "
      + "|| ':' || strip_diacritics(unicode_lower(t.title)) LIMIT 1",
  });
  facts.lyricsTrackId = lyrics.rows?.[0]?.[0] ?? null;
  return facts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let scenes = SCENES.filter((s) => !opts.only || opts.only.includes(s.id));
  if (!opts.video) scenes = scenes.filter((s) => s.kind !== "video");

  if (opts.list) {
    for (const s of SCENES) console.log(`${s.id.padEnd(18)} ${s.kind.padEnd(6)} ${s.page.padEnd(13)} ${s.slot}`);
    console.log("\nRecord by hand:");
    for (const m of MANUAL_CAPTURES) console.log(`  ${m.page.padEnd(13)} ${m.slot} — ${m.why}`);
    return;
  }
  if (process.platform !== "darwin") throw new Error("capture-site-media is macOS-only (screencapture + avfoundation)");

  const api = makeApi(opts.profile);
  await api("GET", "/health");
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });

  // Snapshot what we change, to put it back afterwards.
  const [ui0, win0, status0, ext0] = await Promise.all([
    api("GET", "/ui"), api("GET", "/window"), api("GET", "/status"), api("GET", "/extensions"),
  ]);
  const skin0 = (ext0.skins ?? []).find((s) => s.active)?.id;
  const pluginIds = (ext0.plugins ?? []).filter((p) => p.enabled).map((p) => p.id);
  const hasTrack = Boolean(status0.currentTrack);
  const facts = await discoverFacts(api, opts);
  facts.skin0 = skin0 ?? null;
  const screen = scenes.some((s) => s.kind === "video") ? screenInfo() : null;

  const results = [];
  try {
    await api("POST", "/window", { fullscreen: false, mini: false, maximized: false, width: opts.width, height: opts.height, x: opts.x, y: opts.y });
    await api("POST", "/ui/action", { action: "showcase", on: true });
    await api("POST", "/ui/action", { action: "heroLook", look: "aurora-drift" });
    // Silent capture. Bit-perfect mode refuses a volume change; then it plays aloud.
    if (!opts.keepVolume) await api("POST", "/playback", { volume: 0 }).catch((e) => console.error(`couldn't mute: ${e.message}`));
    await sleep(1500);

    for (const scene of scenes) {
      const missing = missingNeeds(scene, { hasTrack, hasLyricsTrack: facts.lyricsTrackId !== null, pluginIds });
      if (missing.length) {
        results.push({ scene, status: "skipped", why: missing.join("; ") });
        continue;
      }
      process.stdout.write(`• ${scene.id} … `);
      try {
        await api("POST", "/window", { focus: true });
        parkPointer();
        for (const step of scene.steps ?? []) await runStep(api, step, facts);
        const problems = await waitForExpect(api, scene.expect);
        if (problems.length) throw new Error(`page didn't land: ${problems.join("; ")}`);
        await sleep(scene.settleMs ?? opts.settle);
        const files = scene.kind === "still"
          ? await captureStill(api, out, scene)
          : await captureVideo(api, out, scene, facts, screen);
        results.push({ scene, status: "saved", files });
        console.log(`saved ${files.join(", ")}`);
      } catch (e) {
        results.push({ scene, status: "skipped", why: e.message });
        console.log(`skipped — ${e.message}`);
      } finally {
        for (const step of scene.after ?? []) await runStep(api, { ...step, optional: true }, facts);
        while (facts.undo.length) {
          await facts.undo.pop()().catch((e) => console.error(`  undo failed: ${e.message}`));
        }
      }
    }
  } finally {
    // Put the app back the way we found it.
    const restore = async (fn) => { try { await fn(); } catch (e) { console.error(`restore: ${e.message}`); } };
    await restore(() => api("POST", "/ui/action", { action: "showcase", on: false }));
    await restore(() => api("POST", "/ui/action", { action: "heroLook", look: ui0.heroLook }));
    if (skin0) await restore(() => api("POST", "/skins/apply", { id: skin0 }));
    await restore(() => api("POST", "/window", { width: win0.frame.width, height: win0.frame.height, x: win0.frame.x, y: win0.frame.y }));
    if (win0.mini) await restore(() => api("POST", "/window", { mini: true }));
    if (!opts.keepVolume) await restore(() => api("POST", "/playback", { volume: status0.volume }));
    await restore(() => api("POST", "/playback", { play: status0.playing }));
    await restore(() => api("POST", "/ui/navigate", { view: "home" }));
  }

  console.log(`\nMedia in ${out}:`);
  for (const r of results) {
    const where = `${r.scene.page} → ${r.scene.slot}`;
    console.log(r.status === "saved" ? `  ✓ ${r.scene.id.padEnd(18)} ${where}` : `  – ${r.scene.id.padEnd(18)} skipped: ${r.why}`);
  }
  console.log("\nStill to record by hand:");
  for (const m of MANUAL_CAPTURES) console.log(`  ${m.page} → ${m.slot} (${m.why})`);
  console.log("\nReview the files before committing: they show this profile's library.");
}

main().catch((e) => {
  console.error(`capture-site-media: ${e.message}`);
  process.exit(1);
});
