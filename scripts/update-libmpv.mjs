#!/usr/bin/env node
// Finds newer libmpv builds than the ones pinned in scripts/libmpv.lock.json,
// checks them, mirrors them to our 'vendor-libmpv' release and re-pins the lock.
// Run weekly by .github/workflows/update-libmpv.yml, which then tests the new
// pins on real macOS and Windows runners and opens a pull request — merging
// stays a person's call (see the lock file's comment).
//
//   node scripts/update-libmpv.mjs                    # report only: what's newer?
//   node scripts/update-libmpv.mjs --write --mirror   # mirror + re-pin (needs `gh` auth)
//   node scripts/update-libmpv.mjs --summary pr.md    # also write the PR body
//   node scripts/update-libmpv.mjs --platform windows-x86_64
//
// The decisions live in scripts/lib/libmpvUpdate.mjs (unit-tested); this file
// does the network, the downloads and the lock write.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIRROR_REPO,
  MIRROR_TAG,
  UPSTREAMS,
  archiveProblems,
  lockEntryFor,
  parseClientApiVersion,
  pickAsset,
  prBody,
  sameCommit,
} from "./lib/libmpvUpdate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "scripts", "libmpv.lock.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const write = flag("--write");
const mirror = flag("--mirror");
const summaryPath = option("--summary");
const onlyPlatform = option("--platform");

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

async function github(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "viboplr-update-libmpv",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${pathname}`);
  return res.json();
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// bsdtar reads both .zip and .7z. On macOS that is plain `tar`; Linux runners
// need libarchive-tools for `bsdtar` (GNU tar can't read either).
function bsdtar(argv) {
  const failures = [];
  for (const tar of ["bsdtar", "tar"]) {
    try {
      return execFileSync(tar, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      failures.push(`${tar}: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error(`couldn't read the archive (${failures.join(" | ")}) — install bsdtar (libarchive-tools)`);
}

async function mirrorAssets() {
  const release = await github(`/repos/${MIRROR_REPO}/releases/tags/${MIRROR_TAG}`);
  if (!release) throw new Error(`the ${MIRROR_TAG} release is missing on ${MIRROR_REPO}`);
  return new Set(release.assets.map((a) => a.name));
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "libmpv-update-"));
const changes = [];
const mirrored = mirror ? await mirrorAssets() : null;

try {
  for (const [platform, upstream] of Object.entries(UPSTREAMS)) {
    if (onlyPlatform && platform !== onlyPlatform) continue;
    const current = lock.platforms[platform];
    const release = await github(`/repos/${upstream.repo}/releases/latest`);
    const asset = release && pickAsset(release, upstream);
    if (!asset) {
      throw new Error(`${platform}: ${upstream.repo}'s latest release has no asset matching ${upstream.asset} — upstream changed its file names`);
    }
    if (sameCommit(current?.mpvGitHash, asset.gitHash)) {
      console.log(`${platform}: up to date (mpv ${current.mpvGitHash}, upstream ${asset.tag})`);
      continue;
    }
    console.log(`${platform}: newer build ${asset.tag} — mpv ${current?.mpvGitHash ?? "none"} → ${asset.gitHash}`);

    const file = path.join(work, asset.name);
    await download(asset.url, file);
    const hash = sha256(file);
    const listing = bsdtar(["-tf", file]).split("\n");
    let header = "";
    try {
      header = bsdtar(["-xOf", file, upstream.header]);
    } catch {
      // archiveProblems reports the missing header (and the missing file) below.
    }
    const problems = archiveProblems(upstream, listing, header);
    if (problems.length) throw new Error(`${platform}: ${asset.name} — ${problems.join("; ")}`);
    const api = parseClientApiVersion(header);
    console.log(`  ${asset.name}  sha256=${hash}  client API ${api.major}.${api.minor}`);

    if (mirror) {
      if (mirrored.has(asset.name)) {
        // Same name already mirrored: it must be the same bytes, or the pin lies.
        const again = path.join(work, `mirror-${asset.name}`);
        await download(`https://github.com/${MIRROR_REPO}/releases/download/${MIRROR_TAG}/${asset.name}`, again);
        if (sha256(again) !== hash) throw new Error(`${platform}: the mirror already holds a different ${asset.name}`);
        console.log("  already mirrored (same bytes)");
      } else {
        execFileSync("gh", ["release", "upload", MIRROR_TAG, file, "-R", MIRROR_REPO], { stdio: "inherit" });
        mirrored.add(asset.name);
        console.log(`  mirrored to ${MIRROR_TAG}`);
      }
    }

    const entry = lockEntryFor(upstream, asset, hash);
    changes.push({ platform, from: current ?? null, to: entry, tag: asset.tag, api });
    if (write) lock.platforms[platform] = entry;
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (write && changes.length) {
  if (!mirror) console.warn("warning: --write without --mirror — the lock now names files the mirror doesn't have yet");
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log(`updated ${path.relative(root, lockPath)}`);
}
if (summaryPath && changes.length) fs.writeFileSync(summaryPath, prBody(changes) + "\n");
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${changes.length ? "true" : "false"}\nplatforms=${changes.map((c) => c.platform).join(" ")}\n`,
  );
}
if (!changes.length) console.log("nothing to update");
