#!/usr/bin/env node
// Pull a bundled plugin's release from its own repo into src-tauri/plugins/<id>/
// and pin it in scripts/bundled-plugins.lock.json.
//
//   node scripts/sync-bundled-plugins.mjs                 # every entry → its latest release
//   node scripts/sync-bundled-plugins.mjs lastfm          # one entry → its latest release
//   node scripts/sync-bundled-plugins.mjs lastfm 1.7.1    # one entry → that release
//   node scripts/sync-bundled-plugins.mjs --check         # report only: copy vs lock, lock vs latest
//
// The copy is the release's files UNCHANGED — manifest.json, index.js and
// signature.sig out of the zip. Never edit them here: change the plugin in its
// repo, release, and sync. The signature is what makes a hand edit obvious
// (src/__tests__/bundledPlugins.test.ts verifies it against the trusted key),
// and the manifest's updateUrl is what lets a newer release reach users before
// the next app release.
//
// A sync refuses a release whose manifest names another id or version, or whose
// signature doesn't verify, and touches nothing in that case.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_FILES,
  checkBundledCopy,
  compareVersions,
  hashBundledFiles,
  parseLatestTag,
  releaseAssetUrl,
} from "./lib/bundledPlugins.mjs";
import { verifyDir } from "./plugin-signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "scripts", "bundled-plugins.lock.json");
const pluginsDir = path.join(root, "src-tauri", "plugins");

const args = process.argv.slice(2);
const check = args.includes("--check");
const [onlyId, pinVersion] = args.filter((a) => !a.startsWith("--"));

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

/**
 * The newest release's version, from the `releases/latest` redirect — never
 * api.github.com, whose 60 req/h per-IP budget is routinely spent on a shared
 * NAT (backend.md "External Binary Dependencies").
 */
async function latestVersion(entry) {
  const res = await fetch(`https://github.com/${entry.repo}/releases/latest`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const version = parseLatestTag(res.headers.get("location"));
  if (!version) throw new Error(`no release tag in the redirect for ${entry.repo} (HTTP ${res.status})`);
  return version;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function sync(id, entry, version) {
  const url = releaseAssetUrl(entry, version);
  console.log(`${id}: downloading v${version} — ${url}`);
  const zip = await download(url);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `viboplr-bundled-${id}-`));
  try {
    const zipPath = path.join(work, entry.asset);
    const out = path.join(work, "out");
    fs.writeFileSync(zipPath, zip);
    fs.mkdirSync(out);
    execFileSync("unzip", ["-q", zipPath, "-d", out]);

    for (const name of BUNDLED_FILES) {
      if (!fs.existsSync(path.join(out, name))) throw new Error(`the release zip has no ${name}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    if (manifest.id !== id) throw new Error(`the release is plugin "${manifest.id}", not "${id}"`);
    if (manifest.version !== version) throw new Error(`the v${version} release says version ${manifest.version}`);
    if (!verifyDir(out)) throw new Error("the release's signature.sig does not verify against a trusted key");

    const dest = path.join(pluginsDir, id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const name of BUNDLED_FILES) fs.copyFileSync(path.join(out, name), path.join(dest, name));

    entry.version = version;
    entry.files = hashBundledFiles(dest);
    console.log(`${id}: src-tauri/plugins/${id}/ is now release v${version}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const ids = onlyId ? [onlyId] : Object.keys(lock.plugins);
  let failed = false;
  for (const id of ids) {
    const entry = lock.plugins[id];
    if (!entry) throw new Error(`${id} is not in scripts/bundled-plugins.lock.json`);

    if (check) {
      const problems = checkBundledCopy(path.join(pluginsDir, id), entry);
      for (const p of problems) console.error(`✗ ${id}: ${p}`);
      if (problems.length) failed = true;
      try {
        const latest = await latestVersion(entry);
        if (compareVersions(entry.version, latest) < 0) {
          console.warn(`⚠ ${id}: bundles v${entry.version}, but v${latest} is released — run: node scripts/sync-bundled-plugins.mjs ${id}`);
        } else if (!problems.length) {
          console.log(`✓ ${id}: v${entry.version}, the latest release`);
        }
      } catch (e) {
        console.warn(`⚠ ${id}: couldn't look up the latest release: ${e.message}`);
      }
      continue;
    }

    await sync(id, entry, pinVersion ?? (await latestVersion(entry)));
  }
  if (!check) fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
