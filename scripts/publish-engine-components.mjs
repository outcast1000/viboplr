#!/usr/bin/env node
// Publishes the zips scripts/package-engine-component.mjs built
// (dist/engine-component/) to the 'engine-components' release, and makes
// src-tauri/engine-component.lock.json pin exactly what was published.
//
//   node scripts/package-engine-component.mjs
//   node scripts/publish-engine-components.mjs      # needs `gh` auth
//
// NEVER OVERWRITES. Packaging is not reproducible (file times, the macOS
// re-sign), so re-packaging an unchanged libmpv produces different bytes under
// the SAME file name — and a released app has that name's old hash baked in.
// Clobbering it would fail every such app's component download. So a zip
// whose name is already published is not uploaded; the lock adopts the
// published file's hash instead. New names are uploaded.
//
// The release is created on first use as a prerelease, never "latest", with
// its tag on the repository's ROOT commit: release.yml's manual run picks its
// tag with `git describe --tags`, which a tag on main would win.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "outcast1000/viboplr";
const TAG = "engine-components";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist", "engine-component");
const lockPath = path.join(root, "src-tauri", "engine-component.lock.json");

const gh = (argv, opts = {}) => execFileSync("gh", [...argv, "-R", REPO], { encoding: "utf8", ...opts });
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sizeMb = (file) => Math.round((fs.statSync(file).size / 1e6) * 10) / 10;

function releaseAssets() {
  try {
    return new Set(JSON.parse(gh(["release", "view", TAG, "--json", "assets"])).assets.map((a) => a.name));
  } catch {
    return null; // no release yet
  }
}

let published = releaseAssets();
if (!published) {
  const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();
  gh([
    "release", "create", TAG, "--target", rootCommit, "--prerelease", "--latest=false",
    "--title", "Engine components",
    "--notes", "Runtime-downloadable libmpv engine components (Settings > Playback), hash-pinned by the app in src-tauri/engine-component.lock.json. Files are never replaced once published. Not an app release.",
  ], { stdio: "inherit" });
  published = new Set();
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const zips = fs.existsSync(distDir) ? fs.readdirSync(distDir).filter((f) => f.endsWith(".zip")) : [];
if (!zips.length) throw new Error(`no zips in ${path.relative(root, distDir)} — run scripts/package-engine-component.mjs first`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "engine-components-"));
try {
  for (const name of zips) {
    const m = /^engine-libmpv-(.+)-([0-9a-f]+)\.zip$/.exec(name);
    const entry = m && lock.platforms[m[1]];
    if (!entry) {
      console.warn(`${name}: no matching platform in the lock — skipped`);
      continue;
    }
    let file = path.join(distDir, name);
    if (published.has(name)) {
      file = path.join(work, name);
      gh(["release", "download", TAG, "--pattern", name, "--dir", work, "--clobber"]);
      console.log(`${name}: already published — keeping those bytes`);
    } else {
      gh(["release", "upload", TAG, file], { stdio: "inherit" });
      console.log(`${name}: published`);
    }
    entry.version = m[2];
    entry.url = `https://github.com/${REPO}/releases/download/${TAG}/${name}`;
    entry.sha256 = sha256(file);
    entry.size_mb = sizeMb(file);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log(`updated ${path.relative(root, lockPath)}`);
