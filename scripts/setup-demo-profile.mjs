#!/usr/bin/env node
// Load the generated demo library (scripts/make-demo-library.mjs) into its own
// profile, ready for the website captures — `npm run demo:setup -- --music <dir>`.
//
// The profile is `perf-demo`: the `viboplr://probe` route (which can add a
// collection and dismiss onboarding) only answers on `perf` / `perf-*`
// profiles, and keeping the demo out of `perf` itself leaves the perf series'
// library alone.
//
// What a fresh profile lacks, and how each is supplied:
//   onboarding          probe `onboarding=dismiss`
//   the collection      probe `collection=<dir>`, then wait for the scan
//   control API         store key `controlApiEnabled`, written with the app stopped
//   listening history   SQL into the history tables, app stopped (there is no
//                       write route for history; it is keyed by artist/title,
//                       so it needs no track ids — demoCatalog.historySql)
//   likes, a queue      control API (`/v1/likes`, `/v1/radio`)
//
// This QUITS any running Viboplr first (whatever its profile) and relaunches
// it under `perf-demo`. Re-running is safe: the collection is added once, the
// history is replaced, likes are idempotent.
//
// Usage:
//   node scripts/setup-demo-profile.mjs --music <demo library dir>

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

process.env.VIBOPLR_PROBE_PROFILE ??= "perf-demo";
const { quitApp, launchApp, probeLink, probeDumpPath, waitFor, sleep, PROBE_PROFILE } = await import("./lib/appControl.mjs");
const { catalogTracks, historyPlan, historySql, likePlan } = await import("./lib/demoCatalog.mjs");

const PROFILE_DIR = dirname(probeDumpPath(PROBE_PROFILE));
const STORE_PATH = join(PROFILE_DIR, "app-state.json");
const DB_PATH = join(PROFILE_DIR, "viboplr.db");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function askApp() {
  const dumpPath = probeDumpPath(PROBE_PROFILE);
  rmSync(dumpPath, { force: true });
  await probeLink("dump=on");
  await waitFor(() => existsSync(dumpPath), 20000, "the app to answer with its state");
  await sleep(200); // the file appears before the write finishes
  return JSON.parse(readFileSync(dumpPath, "utf8"));
}

function editStore(fn) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const store = existsSync(STORE_PATH) ? JSON.parse(readFileSync(STORE_PATH, "utf8")) : {};
  fn(store);
  writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function controlApi() {
  const file = join(PROFILE_DIR, "control-api.json");
  return async (method, path, body, { raw = false } = {}) => {
    const { port, token } = JSON.parse(readFileSync(file, "utf8"));
    const res = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) {
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
      return res.arrayBuffer();
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

async function main() {
  if (process.platform !== "darwin") throw new Error("setup-demo-profile runs on macOS (it needs sqlite3 and the probe links)");
  const musicArg = arg("music");
  if (!musicArg) throw new Error("pass --music <demo library dir> (made by npm run demo:library)");
  const music = resolve(musicArg.replace(/^~(?=$|\/)/, homedir()));
  const manifestPath = join(music, "demo-library.json");
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found — run npm run demo:library -- --out ${music} first`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tracks = catalogTracks().filter((t) => manifest.tracks.some((m) => m.artist === t.artist && m.title === t.title));

  console.log(`Demo profile "${PROBE_PROFILE}" at ${PROFILE_DIR}`);
  console.log("Quitting any running Viboplr…");
  await quitApp();
  editStore((s) => {
    s.controlApiEnabled = true;
    // The Library opens on its Albums tab (tiles) — the `library` screenshot.
    s.searchSettings = { ...(s.searchSettings ?? {}), activeTab: "albums" };
  });

  await launchApp();
  await probeLink("onboarding=dismiss");
  let dump = await askApp();
  if (!dump.library.trackCount) {
    await probeLink(`collection=${encodeURIComponent(music)}`);
    console.log("✓ collection added — waiting for the scan");
  }
  const deadline = Date.now() + 10 * 60000;
  while (dump.library.trackCount < tracks.length && Date.now() < deadline) {
    await sleep(3000);
    dump = await askApp();
    process.stdout.write(`\r  ${dump.library.trackCount}/${tracks.length} tracks`);
  }
  process.stdout.write("\n");
  if (dump.library.trackCount < tracks.length) console.warn(`  ! only ${dump.library.trackCount} of ${tracks.length} tracks after 10 minutes`);
  await quitApp();

  // History + "recently added" order, written with the app stopped.
  const now = Math.floor(Date.now() / 1000);
  const plays = historyPlan(tracks, now);
  const sqlFile = join(PROFILE_DIR, "demo-history.sql");
  writeFileSync(sqlFile, historySql(plays, tracks, now));
  // On stdin: `.read <file>` splits on spaces, and the profile lives under
  // "Application Support".
  const r = spawnSync("sqlite3", [DB_PATH], { input: readFileSync(sqlFile, "utf8"), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  console.log(`✓ ${plays.length} plays of history written`);
  // Home caches its shelves for 24h; the copy built during the scan launch
  // predates the history and would show an almost empty page.
  editStore((s) => { delete s.homeSnapshot; });

  await launchApp();
  const api = controlApi();
  await waitFor(() => existsSync(join(PROFILE_DIR, "control-api.json")), 20000, "the control API to start");
  await api("GET", "/health");
  const likes = likePlan(tracks);
  for (const t of likes.tracks) await api("POST", "/likes", { kind: "track", likeState: 1, ...t });
  for (const a of likes.albums) await api("POST", "/likes", { kind: "album", likeState: 1, ...a });
  for (const name of likes.artists) await api("POST", "/likes", { kind: "artist", likeState: 1, name });
  console.log(`✓ ${likes.tracks.length} tracks, ${likes.albums.length} albums, ${likes.artists.length} artists liked`);

  // Real songs' lyrics are copyrighted: switch the online lyrics providers
  // off, so the only lyrics on screen are the invented album's sidecar .lrc
  // (the local provider needs no plugin).
  const installed = (await api("GET", "/extensions")).plugins ?? [];
  for (const id of ["lrclib", "lyrics-ovh", "genius"]) {
    if (installed.some((p) => p.id === id && p.enabled)) await api("POST", `/extensions/${id}/enabled`, { enabled: false });
  }
  console.log("✓ online lyrics providers off");

  // Covers and artist photos come from the app's own providers; ask for them
  // now (queued on the image worker) so the captures don't race the network.
  // Spaced out: a burst of 45 got one album rate-limited, and a failed lookup
  // is remembered (image_fetch_failures) and not retried for a while.
  for (const name of manifest.artists) { await api("POST", "/images/artist", { name }); await sleep(500); }
  for (const a of manifest.albums) { await api("POST", "/images/album", { name: a.title, artistName: a.artist }); await sleep(500); }
  await sleep(20000);
  const missing = [];
  for (const a of manifest.albums) {
    // 404 until a cover is cached; the body is the image itself otherwise.
    await api("GET", `/images/album?name=${encodeURIComponent(a.title)}&artistName=${encodeURIComponent(a.artist)}`, undefined, { raw: true })
      .catch(() => missing.push(a.title));
  }
  console.log(`✓ images requested for ${manifest.artists.length} artists, ${manifest.albums.length} albums`
    + (missing.length ? ` — no cover yet for: ${missing.join(", ")} (retried on display)` : ""));

  const seed = manifest.showcase.radioSeed;
  await api("POST", "/radio", { title: seed.title, artistName: seed.artist });
  await sleep(4000);
  await api("POST", "/playback", { seekSecs: 40 });
  await api("POST", "/playback", { play: false });
  console.log(`✓ queue: Radio: ${seed.title}`);

  await quitApp();
  // Forget failed image lookups, so a cover that missed above is fetched again
  // the first time a capture shows it.
  spawnSync("sqlite3", [DB_PATH], { input: "DELETE FROM image_fetch_failures;\n", encoding: "utf8" });
  console.log(`\nReady. Launch it with:  open -a Viboplr --args --profile ${PROBE_PROFILE}`);
  console.log(`then:  npm run capture:media -- --demo ${music}`);
}

main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
});
