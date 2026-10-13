// Bundled plugins whose source lives in their own repo (Last.fm). The app ships
// a pinned copy of one of that repo's RELEASES, files unchanged, recorded in
// scripts/bundled-plugins.lock.json. scripts/sync-bundled-plugins.mjs refreshes
// it; src/__tests__/bundledPlugins.test.ts holds the copy to the lock.
//
// Pure helpers only — no network, no process — so the test can use them.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The files a release zip carries and the app bundles, in that order. */
export const BUNDLED_FILES = ["manifest.json", "index.js", "signature.sig"];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of each bundled file in `dir`, keyed by name (missing → null). */
export function hashBundledFiles(dir) {
  const out = {};
  for (const name of BUNDLED_FILES) {
    const file = path.join(dir, name);
    out[name] = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
  }
  return out;
}

/**
 * Everything wrong with a bundled copy against its lock entry, as messages.
 * Empty = the folder holds exactly the pinned release's files. Collects every
 * problem rather than stopping at the first, so one run says what to fix.
 */
export function checkBundledCopy(dir, entry) {
  const problems = [];
  if (!fs.existsSync(dir)) return [`${dir} does not exist`];
  const extra = fs.readdirSync(dir).filter((n) => !BUNDLED_FILES.includes(n));
  if (extra.length) problems.push(`unexpected files (not part of the release): ${extra.join(", ")}`);
  const hashes = hashBundledFiles(dir);
  for (const name of BUNDLED_FILES) {
    if (hashes[name] === null) problems.push(`${name} is missing`);
    else if (hashes[name] !== entry.files?.[name]) problems.push(`${name} differs from release v${entry.version}`);
  }
  if (hashes["manifest.json"] !== null) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    if (manifest.version !== entry.version) {
      problems.push(`manifest.json says version ${manifest.version}, the lock pins ${entry.version}`);
    }
    const wantUrl = updateUrlFor(entry);
    if (manifest.updateUrl !== wantUrl) {
      problems.push(`manifest.json updateUrl is ${manifest.updateUrl ?? "missing"}, expected ${wantUrl}`);
    }
  }
  return problems;
}

/** The update endpoint a bundled copy must declare, or it is never offered updates. */
export function updateUrlFor(entry) {
  return `https://github.com/${entry.repo}/releases/latest/download/update.json`;
}

export function releaseAssetUrl(entry, version) {
  return `https://github.com/${entry.repo}/releases/download/v${version}/${entry.asset}`;
}

/** Version out of a `releases/latest` redirect's Location (`…/releases/tag/v1.7.0`). */
export function parseLatestTag(location) {
  const m = /\/releases\/tag\/v?(\d+\.\d+\.\d+)$/.exec(location || "");
  return m ? m[1] : null;
}

/** -1 / 0 / 1 for plain x.y.z versions. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
