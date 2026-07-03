#!/usr/bin/env node
// Assembles latest-mpv.json — the updater manifest for the "Viboplr Full"
// (mpv-engine) build variant — from the updater artifacts already uploaded to
// a GitHub release, and uploads it to that release.
//
// The lean build's latest.json is written by tauri-action as before; the full
// build runs tauri-action with includeUpdaterJson=false (two writers merging
// the same platform keys into one latest.json would clobber each other) and
// this script produces the variant manifest instead. Run once, after all
// variant build jobs, with GITHUB_TOKEN + GITHUB_REPOSITORY set:
//
//   node scripts/build-mpv-updater-manifest.mjs v0.9.151

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: build-mpv-updater-manifest.mjs <tag>");
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY || "outcast1000/viboplr";

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...opts });
}

const assets = JSON.parse(
  gh(["release", "view", tag, "--repo", repo, "--json", "assets"]),
).assets.map((a) => a.name);

// Updater artifacts for the FULL variant are recognizable by its productName.
const isFull = (name) => name.startsWith("Viboplr.Full") || name.startsWith("Viboplr Full");

function findAsset(suffix) {
  const match = assets.find((n) => isFull(n) && n.endsWith(suffix));
  if (!match) {
    throw new Error(`no "Viboplr Full" asset ending with ${suffix} on ${tag}; assets: ${assets.join(", ")}`);
  }
  return match;
}

function sigFor(assetName) {
  const sigName = `${assetName}.sig`;
  if (!assets.includes(sigName)) throw new Error(`missing signature asset ${sigName}`);
  gh(["release", "download", tag, "--repo", repo, "--pattern", sigName, "--output", "/tmp/mpv-updater.sig", "--clobber"]);
  return fs.readFileSync("/tmp/mpv-updater.sig", "utf8").trim();
}

const downloadUrl = (name) =>
  `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

const platforms = {};
// macOS updater artifact: the .app archive. Windows: the NSIS installer.
const macAsset = findAsset(".app.tar.gz");
platforms["darwin-aarch64"] = { signature: sigFor(macAsset), url: downloadUrl(macAsset) };
const winAsset = findAsset("-setup.exe");
platforms["windows-x86_64"] = { signature: sigFor(winAsset), url: downloadUrl(winAsset) };

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: "",
  pub_date: new Date().toISOString(),
  platforms,
};

const out = "/tmp/latest-mpv.json";
fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
gh(["release", "upload", tag, out, "--repo", repo, "--clobber"]);
console.log(`Uploaded latest-mpv.json for ${tag}:`);
console.log(JSON.stringify(manifest, null, 2));
