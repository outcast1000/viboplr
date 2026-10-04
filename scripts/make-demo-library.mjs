#!/usr/bin/env node
// Generate the music library the website is captured from —
// `npm run demo:library -- --out ~/ViboplrDemo`.
//
// Why it exists: the site's screenshots and videos used to come from a real
// profile, which published its owner's collection. This writes well-known
// albums as synthesised audio tagged like a real rip (see
// scripts/lib/demoCatalog.mjs) — the app then fetches their covers, photos
// and bios itself — plus one invented album with procedural folder art and
// sidecar .lrc lyrics for the lyrics scenes.
//
// Layout (what the scanner and the folder image provider expect):
//   <out>/<Artist>/<Year> - <Album>/NN - <Title>.mp3|flac  (+ .lrc)
//   <out>/<Artist>/artist.png, <Album dir>/cover.png   — invented album only
//   <out>/demo-library.json   — manifest read by setup-demo-profile and
//                               capture-site-media --demo
//
// Needs ffmpeg with libmp3lame on PATH. Re-running skips files that already
// exist (pass --force to rebuild); everything is deterministic, so a rebuild
// produces the same library.
//
// Usage:
//   node scripts/make-demo-library.mjs --out <dir> [--jobs 6] [--force]
//     [--max-tracks N]   cap tracks per album (quick test libraries)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join, resolve } from "node:path";
import { encodePng, paint } from "./lib/demoArt.mjs";
import { ALBUMS, ARTISTS, SHOWCASE, catalogTracks, lrcText, synthExpression } from "./lib/demoCatalog.mjs";

function parseArgs(argv) {
  const o = { out: null, jobs: Math.max(2, Math.min(8, cpus().length - 1)), force: false, maxTracks: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--jobs") o.jobs = Number(argv[++i]);
    else if (a === "--force") o.force = true;
    else if (a === "--max-tracks") o.maxTracks = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.out) throw new Error("pass --out <dir> (e.g. --out ~/ViboplrDemo)");
  o.out = resolve(o.out.replace(/^~(?=$|\/)/, homedir()));
  return o;
}

function ffmpeg(args) {
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    p.on("error", rej);
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(err.trim().split("\n").slice(-2).join(" ")))));
  });
}

function trackMeta(t) {
  return {
    title: t.title, artist: t.artist, album_artist: t.artist, album: t.album,
    date: String(t.year), track: `${t.trackNumber}/${t.trackTotal}`, genre: t.tags[0],
  };
}

const metaArgs = (t) => Object.entries(trackMeta(t)).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);

function audioArgs(t, dest) {
  const fadeOut = Math.max(0, t.durationSecs - 6);
  const codec = t.format === "flac"
    ? ["-c:a", "flac", "-sample_fmt", "s16"]
    : ["-c:a", "libmp3lame", "-b:a", "160k", "-id3v2_version", "3"];
  return [
    "-f", "lavfi", "-i", `aevalsrc=exprs='${synthExpression(t)}':s=44100:d=${t.durationSecs}`,
    "-af", `afade=t=in:d=3,afade=t=out:st=${fadeOut}:d=6,alimiter=limit=0.9,aformat=channel_layouts=stereo`,
    ...codec,
    ...metaArgs(t),
    dest,
  ];
}

/** Does an existing file carry the catalogue's current tags? A catalogue edit
 *  (a regrouped genre, a renamed album) then costs a remux, not a re-synth. */
function tagsCurrent(t, path) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", path], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const tags = Object.fromEntries(Object.entries(JSON.parse(r.stdout).format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const want = trackMeta(t);
  return ["title", "artist", "album", "genre"].every((k) => tags[k] === want[k]);
}

async function retag(t, path) {
  const tmp = path.replace(/(\.[^.]+)$/, ".retag$1");
  await ffmpeg(["-i", path, "-map", "0", "-c", "copy", ...(t.format === "mp3" ? ["-id3v2_version", "3"] : []), ...metaArgs(t), tmp]);
  renameSync(tmp, path);
}

async function pool(items, jobs, fn) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
      done++;
      process.stdout.write(`\r  audio ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  process.stdout.write("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tracks = catalogTracks().filter((t) => t.trackNumber <= opts.maxTracks);
  mkdirSync(opts.out, { recursive: true });
  console.log(`Demo library → ${opts.out} (${tracks.length} tracks)`);

  for (const t of tracks) mkdirSync(join(opts.out, t.dir), { recursive: true });
  // Folder art for the invented album only: real albums get theirs from the
  // app's image providers, like any user's library.
  for (const album of ALBUMS.filter((a) => a.art)) {
    const first = tracks.find((t) => t.artist === album.artist && t.album === album.title);
    if (!first) continue;
    const portrait = join(opts.out, first.dir.split("/")[0], "artist.png");
    if (opts.force || !existsSync(portrait)) writeFileSync(portrait, encodePng(paint("portrait", `artist|${album.artist}`)));
    const cover = join(opts.out, first.dir, "cover.png");
    if (opts.force || !existsSync(cover)) writeFileSync(cover, encodePng(paint("auto", `album|${album.artist}|${album.title}`)));
  }

  for (const t of tracks) {
    if (!t.lyrics) continue;
    writeFileSync(join(opts.out, t.dir, t.file.replace(/\.[^.]+$/, ".lrc")), lrcText(t.lyrics));
  }

  const todo = tracks.filter((t) => opts.force || !existsSync(join(opts.out, t.dir, t.file)));
  await pool(todo, opts.jobs, (t) => ffmpeg(audioArgs(t, join(opts.out, t.dir, t.file))));
  const stale = tracks.filter((t) => !todo.includes(t) && !tagsCurrent(t, join(opts.out, t.dir, t.file)));
  for (const t of stale) await retag(t, join(opts.out, t.dir, t.file));
  if (stale.length) console.log(`  retagged ${stale.length} existing files`);

  const manifest = {
    generator: "scripts/make-demo-library.mjs",
    showcase: SHOWCASE,
    artists: ARTISTS,
    albums: ALBUMS.map(({ artist, title }) => ({ artist, title })),
    tracks: tracks.map(({ artist, album, title, durationSecs, dir, file }) => ({ artist, album, title, durationSecs, path: `${dir}/${file}` })),
  };
  writeFileSync(join(opts.out, "demo-library.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Done. Next: npm run demo:setup -- --music ${opts.out}`);
}

main().catch((e) => {
  console.error(`make-demo-library: ${e.message}`);
  process.exit(1);
});
