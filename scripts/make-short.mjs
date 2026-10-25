#!/usr/bin/env node
// Make a YouTube Short from the running app — `npm run short`.
//
// Records the whole window while a scenario's timed beats drive the app
// (scripts/lib/shorts.mjs → SHORTS), then turns the recording into a 9:16
// video: a virtual camera follows the element each beat names, captions are
// burned in, an end card is appended. Scenarios per persona are in
// docs/brainstorms/2026-10-24-youtube-shorts-scenarios-requirements.md.
//
// Rules it inherits from the site capture (capture-site-media.mjs), for the
// same reasons: record from the demo library, never a real profile (`--demo`,
// profile `perf-demo`); the window is brought to the front and the real
// pointer parked off it; the app's state is put back afterwards. The real
// pointer is not recorded — the app draws its own cursor for every click and
// keystroke (generic input, `POST /v1/ui/input`), which needs the profile's
// **Settings → AI control → Click and type** switch.
//
// The output is silent unless `--music <file>` is given: add sound in the
// platform's own editor, or pass a track you have the rights to (see the
// scenarios doc on audio).
//
// Needs: macOS (Windows untested), Viboplr running on the demo profile with
// AI control on (plus Click and type for a short that clicks or types —
// `usesInput`), ffmpeg (libx264), and Playwright's
// Chromium (`npx playwright install chromium`, already there for the e2e
// suite) to render captions — this ffmpeg has no drawtext.
//
// Usage:
//   npm run short -- --demo ~/ViboplrDemo [--only tinkerers-skins]
//     [--out ~/ViboplrShorts] [--music bed.mp3] [--keep-raw] [--list]

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grabInputArgs } from "./lib/capturePlatform.mjs";
import { SHOWCASE } from "./lib/demoCatalog.mjs";
import {
  PLATFORM, discovery, makeApi, parkPointer, run, runStep, screenInfo, screenLocked,
  setSystemMuted, sleep, systemMuted, windowRect,
} from "./lib/captureRunner.mjs";
import {
  SHORTS, canvasFor, captionHtml, captionWindows, composeArgs, endCardHtml, frameRegion, toVideoRect, usesInput,
} from "./lib/shorts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const o = { profile: null, only: null, list: false, demo: null, out: join(homedir(), "ViboplrShorts"), music: null, keepRaw: false, x: 40, y: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--profile") o.profile = next();
    else if (a === "--only") o.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--list") o.list = true;
    else if (a === "--demo") o.demo = next();
    else if (a === "--out") o.out = next();
    else if (a === "--music") o.music = resolve(next());
    else if (a === "--keep-raw") o.keepRaw = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  const home = (p) => resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
  if (o.demo) o.demo = home(o.demo);
  o.out = home(o.out);
  o.profile ??= o.demo ? "perf-demo" : "default";
  return o;
}

async function query(api, sql, params = []) {
  return (await api("POST", "/query", { sql, params })).rows ?? [];
}

/** The compilation in its mis-tagged state — one album row per performer —
 *  is what the collectors' short repairs. A previous take left it fixed, so
 *  regenerate its tags (make-demo-library rewrites any file whose tags drifted,
 *  ALBUMARTIST included) and rescan until the library shows the split again. */
async function ensureCompilationMessy(api, opts) {
  const title = SHOWCASE.compilation.title;
  const forks = async () => Number((await query(api,
    "SELECT COUNT(DISTINCT t.album_id) FROM tracks t JOIN albums al ON al.id = t.album_id WHERE al.title = ?1", [title]))[0]?.[0] ?? 0);
  const performers = async () => Number((await query(api,
    "SELECT COUNT(DISTINCT t.artist_id) FROM tracks t JOIN albums al ON al.id = t.album_id WHERE al.title = ?1", [title]))[0]?.[0] ?? 0);
  const n = await performers();
  if (n > 1 && (await forks()) === n) return;
  console.log("• resetting the compilation's tags …");
  const r = spawnSync(process.execPath, [join(REPO, "scripts/make-demo-library.mjs"), "--out", opts.demo], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("make-demo-library failed");
  const collections = await api("GET", "/collections");
  const coll = collections.find((c) => c.kind === "local" && c.path && resolve(c.path) === opts.demo);
  if (!coll) throw new Error(`no local collection at ${opts.demo} in profile ${opts.profile} — run npm run demo:setup first`);
  await api("POST", `/collections/${coll.id}/rescan`, { full: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const p = await performers();
    if (p > 1 && (await forks()) === p) return;
  }
  throw new Error("the rescan didn't split the compilation back into one album per artist");
}

async function discoverFacts(api, opts) {
  const facts = { undo: [], artist: opts.demo ? SHOWCASE.heroArtist : null };
  if (opts.demo) {
    const rows = await query(api,
      "SELECT t.id FROM tracks t JOIN albums al ON al.id = t.album_id WHERE al.title = ?1 ORDER BY t.track_number", [SHOWCASE.compilation.title]);
    facts.compilationTrackIds = rows.map((r) => r[0]);
  }
  return facts;
}

/** Where a beat's focus is on screen right now, in viewport CSS px (null =
 *  the whole window). A target that isn't on screen keeps the camera where
 *  it was, with a warning — a missing element shouldn't sink the take. */
async function resolveFocus(api, focus) {
  if (!focus || focus.full) return { rect: null, pad: 0 };
  if (focus.rect) return { rect: focus.rect, pad: focus.pad ?? 0 };
  const res = await api("POST", "/ui/query", { target: focus.target, limit: 1 });
  const m = res.matches?.[0];
  if (!m) {
    console.warn(`  focus target not on screen: ${JSON.stringify(focus.target)}`);
    return undefined;
  }
  return { rect: [m.rect.x, m.rect.y, m.rect.width, m.rect.height], pad: focus.pad ?? 0 };
}

async function record(api, scene, facts, screen) {
  await api("POST", "/window", { focus: true });
  await sleep(500);
  parkPointer();
  const { rect } = await windowRect(api, {}, screen);
  const raw = join(tmpdir(), `viboplr-short-${scene.id}.mp4`);
  const grab = grabInputArgs(PLATFORM, rect, { device: screen.device, seconds: scene.seconds });
  const ff = spawn("ffmpeg", [
    "-y", "-hide_banner", ...grab.input, ...(grab.filter ? ["-vf", grab.filter] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-pix_fmt", "yuv420p", raw,
  ]);
  let log = "";
  const started = new Promise((res) => ff.stderr.on("data", (c) => { log += c; if (/frame=\s*\d+/.test(log)) res(); }));
  const exited = new Promise((res) => ff.on("close", res));
  await Promise.race([started, exited]);
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;

  const beats = [];
  const keys = [];
  for (const beat of scene.beats) {
    const wait = beat.at - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    const startedAt = elapsed();
    for (const step of beat.steps ?? []) {
      await runStep(api, step, facts).catch((e) => console.error(`  step failed at ${beat.at}ms: ${e.message}`));
    }
    if (beat.focus) {
      await sleep(beat.settle ?? 350);
      const focus = await resolveFocus(api, beat.focus).catch((e) => { console.error(`  focus failed: ${e.message}`); return undefined; });
      // A fixed rect is known before the action, so the camera moves with
      // it; an element is measured after, once it is on screen.
      if (focus) keys.push({ t: beat.focus.target ? elapsed() : startedAt, ...focus });
    }
    beats.push({ caption: beat.caption, until: beat.until, startedAt });
  }
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg recording failed: ${log.trim().split("\n").slice(-2).join(" ")}`);
  return { raw, beats, keys };
}

/** Caption and end-card PNGs from HTML, through the e2e suite's Chromium. */
async function renderPngs(pages, dir) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    const files = [];
    for (const [i, html] of pages.entries()) {
      // The web font is a nicety: offline, the system fallback stands in.
      await page.setContent(html, { waitUntil: "networkidle", timeout: 8000 }).catch(() => page.setContent(html, { waitUntil: "load" }));
      // Runs in the page, where `document` exists.
      await page.evaluate("document.fonts.ready");
      const file = join(dir, `page-${i}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      files.push(file);
    }
    return files;
  } finally {
    await browser.close();
  }
}

function videoSize(file) {
  const out = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).stdout.trim();
  const [width, height] = out.split(",").map(Number);
  return { width, height };
}

async function makeShort(api, scene, opts, screen) {
  const facts = await discoverFacts(api, opts);
  for (const step of scene.setup ?? []) await runStep(api, step, facts);
  await sleep(1200);
  const viewport = (await api("POST", "/ui/query", { limit: 1 })).viewport;
  let take;
  try {
    take = await record(api, scene, facts, screen);
  } finally {
    for (const step of scene.after ?? []) await runStep(api, { ...step, optional: true }, facts);
  }

  const video = videoSize(take.raw);
  const scale = video.width / viewport.width;
  const canvas = canvasFor(video.width, video.height);
  const keys = take.keys.map((k) => ({
    t: Number(k.t.toFixed(2)),
    region: frameRegion(k.rect ? toVideoRect(k.rect, scale) : null, canvas, { pad: k.pad * scale }),
  }));
  if (keys.length === 0 || keys[0].t > 0) keys.unshift({ t: 0, region: keys[0]?.region ?? frameRegion(null, canvas) });
  keys[0].t = 0;
  const durationSecs = scene.seconds;
  const captions = captionWindows(take.beats, durationSecs);

  const work = join(tmpdir(), `viboplr-short-${scene.id}`);
  mkdirSync(work, { recursive: true });
  const icon = readFileSync(join(REPO, "docs/assets/icon.svg"), "utf8");
  const pngs = await renderPngs([...captions.map((c) => captionHtml(c.text, { top: scene.captionTop })), endCardHtml(icon)], work);
  mkdirSync(opts.out, { recursive: true });
  const out = join(opts.out, `${scene.id}.mp4`);
  run("ffmpeg", composeArgs({
    raw: take.raw, canvas, keys, captions, captionPngs: pngs.slice(0, -1), endCard: pngs[pngs.length - 1],
    out, durationSecs, music: opts.music,
  }));
  writeFileSync(join(opts.out, `${scene.id}.timeline.json`), `${JSON.stringify({ scene: scene.id, video, viewport, scale, keys, captions }, null, 2)}\n`);
  if (opts.keepRaw) run("cp", [take.raw, join(opts.out, `${scene.id}.raw.mp4`)]);
  rmSync(take.raw, { force: true });
  rmSync(work, { recursive: true, force: true });
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scenes = SHORTS.filter((s) => !opts.only || opts.only.includes(s.id));
  if (opts.list) {
    for (const s of SHORTS) console.log(`${s.id.padEnd(24)} ${s.persona.padEnd(13)} ${s.seconds}s  ${s.title}`);
    return;
  }
  if (PLATFORM !== "darwin") console.warn("make-short is built and tested on macOS; elsewhere it is untested");
  if (scenes.some((s) => s.needs?.includes("demo")) && !opts.demo) {
    throw new Error("these shorts are recorded from the demo library: pass --demo <dir> (see npm run demo:library)");
  }
  if (screenLocked()) throw new Error("the screen is locked — unlock it and stay at the Mac while the take runs");
  if (PLATFORM === "darwin") spawn("caffeinate", ["-d", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();

  const api = makeApi(opts.profile);
  const health = await api("GET", "/health");
  if (scenes.some(usesInput) && !health.writeScopes?.uiInput) {
    throw new Error(`turn on Settings → AI control → "Click and type" in the ${opts.profile} profile — the shorts click and type on camera`);
  }
  if (scenes.some((s) => s.needs?.includes("compilation"))) await ensureCompilationMessy(api, opts);

  const { port, token } = discovery(opts.profile);
  const redact = [
    { text: homedir(), replacement: "~" },
    { text: String(port), replacement: "•••••" },
    { text: `••••••••${String(token).slice(-4)}`, replacement: "••••••••••••" },
  ];
  const [ui0, win0, status0, ext0] = await Promise.all([api("GET", "/ui"), api("GET", "/window"), api("GET", "/status"), api("GET", "/extensions")]);
  const skin0 = (ext0.skins ?? []).find((s) => s.active)?.id;
  const screen = screenInfo();
  let muted0 = null;
  const made = [];
  try {
    muted0 = PLATFORM === "darwin" ? systemMuted() : null;
    if (muted0 !== null) setSystemMuted(true);
    await api("POST", "/ui/action", { action: "showcase", on: true, redact });
    for (const scene of scenes) {
      process.stdout.write(`• ${scene.id} … `);
      await api("POST", "/window", { fullscreen: false, mini: false, maximized: false, ...scene.window, x: opts.x, y: opts.y });
      await sleep(800);
      try {
        const out = await makeShort(api, scene, opts, screen);
        made.push(out);
        console.log(`saved ${out}`);
      } catch (e) {
        console.log(`failed — ${e.message}`);
      }
    }
  } finally {
    const restore = async (fn) => { try { await fn(); } catch (e) { console.error(`restore: ${e.message}`); } };
    await restore(() => api("POST", "/ui/action", { action: "showcase", on: false }));
    if (skin0) await restore(() => api("POST", "/skins/apply", { id: skin0 }));
    await restore(() => api("POST", "/ui/action", { action: "heroLook", look: ui0.heroLook }));
    await restore(() => api("POST", "/ui/action", { action: "queuePanel", open: !ui0.panels?.queueCollapsed }));
    await restore(() => api("POST", "/window", { width: win0.frame.width, height: win0.frame.height, x: win0.frame.x, y: win0.frame.y }));
    if (muted0 !== null) setSystemMuted(muted0);
    await restore(() => api("POST", "/playback", { play: status0.playing }));
    await restore(() => api("POST", "/ui/navigate", { view: "home" }));
  }
  if (made.length) console.log(`\nReview before uploading: ${made.join(", ")}`);
}

main().catch((e) => {
  console.error(`make-short: ${e.message}`);
  process.exit(1);
});
