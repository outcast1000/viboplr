#!/usr/bin/env node
// Adopts a libmpv build from outcast1000/viboplr-libmpv: re-pins
// scripts/libmpv.lock.json to it, vendors it, and repackages + publishes the
// downloadable engine component from it, so the two locks always move together.
//
//   npm run libmpv:adopt                         # the build repo's newest published build
//   npm run libmpv:adopt -- vibo-git-<mpv>-<recipe>
//   npm run libmpv:adopt -- <tag> --no-publish   # stop before publishing the component
//
// macOS only (vendoring and packaging read and re-sign the macOS dylib), and
// needs `gh` signed in. Everything the lock needs comes from the release itself:
// each platform's archive, and its build-info JSON (sha256, mpv_ref, recipe).
// The archive's sha256 must match GitHub's own asset digest, and fetch-libmpv.mjs
// checks the download against the new pin.
//
// All or nothing: if vendoring, packaging or publishing fails, both locks are
// put back as they were, so a half-adopted build can't be committed or shipped.
// (`--no-publish` keeps them, on purpose; `npm run bump` refuses the release
// until the component is published.)
//
// It does not commit, and it can't play anything: the build workflow ran the
// engine tests, but only a person listening catches what they can't (the
// macOS 27 output, the Bit-perfect reload loop) — the checklist is printed last.
//
// The decisions live in scripts/lib/libmpvPin.mjs (unit-tested).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINE_COMPONENTS_REPO,
  ENGINE_COMPONENTS_TAG,
  LIBMPV_BUILD_REPO,
  buildAssetNames,
  buildProblems,
  engineComponentMismatches,
  isMissingRefError,
  lockEntryFromBuild,
  newestBuild,
  samePin,
  unpublishedComponents,
} from "./lib/libmpvPin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "scripts", "libmpv.lock.json");
const componentLockPath = path.join(root, "src-tauri", "engine-component.lock.json");

const args = process.argv.slice(2);
const noPublish = args.includes("--no-publish");
const tagArg = args.find((a) => !a.startsWith("--"));

const gh = (argv) =>
  execFileSync("gh", argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const errText = (e) => (e.stderr || e.stdout || e.message).toString().trim();
const run = (script, extra = []) => execFileSync("node", [path.join("scripts", script), ...extra], { cwd: root, stdio: "inherit" });

// Set once the lock is rewritten: puts both locks back as they were.
let rollback = null;

function fail(message) {
  console.error(`✗ ${message}`);
  if (rollback) rollback();
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("libmpv:adopt runs on macOS only — vendoring and packaging the engine component read and re-sign the macOS dylib (otool, install_name_tool, codesign).");
}

// The mpv commit a build's mpv_ref names, as the lock writes it (10 hex chars).
// mpv_ref is a commit for a master build and a tag (0.41.0 / v0.41.0) for a
// release build, so it is resolved rather than copied. Only "no such ref" moves
// on to the next spelling; any other gh failure (signed out, rate limit,
// network) is shown as itself.
const resolvedRefs = new Map();
function mpvCommit(ref) {
  if (!resolvedRefs.has(ref)) {
    let sha = null;
    for (const candidate of [ref, `v${ref}`]) {
      try {
        sha = gh(["api", `repos/mpv-player/mpv/commits/${candidate}`, "--jq", ".sha"]);
        break;
      } catch (e) {
        if (!isMissingRefError(errText(e))) fail(`couldn't look up mpv ref "${candidate}":\n${errText(e)}`);
      }
    }
    if (!sha) fail(`mpv ref "${ref}" names no commit or tag in mpv-player/mpv`);
    resolvedRefs.set(ref, sha.slice(0, 10));
  }
  return resolvedRefs.get(ref);
}

// The asset names on the engine-components release (empty when it doesn't exist yet).
function publishedComponentNames() {
  try {
    return new Set(gh(["release", "view", ENGINE_COMPONENTS_TAG, "--repo", ENGINE_COMPONENTS_REPO, "--json", "assets", "--jq", ".assets[].name"]).split("\n").filter(Boolean));
  } catch (e) {
    if (/release not found/i.test(errText(e))) return new Set();
    fail(`couldn't list the ${ENGINE_COMPONENTS_TAG} release:\n${errText(e)}`);
  }
}

// What's wrong with the engine component for the current libmpv lock, as lines; empty = current.
function componentProblems() {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const component = JSON.parse(fs.readFileSync(componentLockPath, "utf8"));
  return [
    ...engineComponentMismatches(lock, component).map((m) => `${m.platform}: component ${m.actual ?? "(not published)"}, libmpv pin ${m.expected}`),
    ...unpublishedComponents(component, publishedComponentNames()).map((u) => `${u.platform}: ${u.name} isn't on the ${ENGINE_COMPONENTS_TAG} release`),
  ];
}

// 1. The release.
let release;
try {
  const wanted = tagArg ?? newestBuild(JSON.parse(gh(["api", `repos/${LIBMPV_BUILD_REPO}/releases?per_page=100`])));
  if (!wanted) fail(`${LIBMPV_BUILD_REPO} has no published build`);
  release = JSON.parse(gh(["api", `repos/${LIBMPV_BUILD_REPO}/releases/tags/${wanted}`]));
} catch (e) {
  fail(`couldn't read ${tagArg ?? "the newest build"} of ${LIBMPV_BUILD_REPO}:\n${errText(e)}`);
}
const tag = release.tag_name;
console.log(`Build ${tag} (${release.html_url})\n`);

// 2. Each platform's build info, checked, as a new lock entry.
const lockText = fs.readFileSync(lockPath, "utf8");
const componentText = fs.readFileSync(componentLockPath, "utf8");
const lock = JSON.parse(lockText);
const platforms = Object.keys(lock.platforms);
const entries = {};
const problems = [];
for (const platform of platforms) {
  const names = buildAssetNames(tag, platform);
  const infoAsset = release.assets.find((a) => a.name === names.info);
  let info = null;
  if (infoAsset) {
    try {
      const res = await fetch(infoAsset.browser_download_url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = JSON.parse(await res.text());
    } catch (e) {
      problems.push(`${platform}: couldn't read ${names.info} (${e.message})`);
    }
  }
  const found = buildProblems(release, platform, info);
  problems.push(...found);
  if (info && found.length === 0) entries[platform] = lockEntryFromBuild(release, platform, info, mpvCommit(info.mpv_ref));
}
if (problems.length) fail(`${tag} can't be adopted:\n  ${problems.join("\n  ")}`);

// 3. The lock.
// A platform already on these exact bytes keeps its entry as written — its
// `source` line may say more than the derived one (a patch named by hand).
const unchanged = platforms.every((p) => samePin(lock.platforms[p], entries[p]));
if (unchanged) {
  console.log(`✓ scripts/libmpv.lock.json already pins ${tag}`);
} else {
  for (const p of platforms) {
    if (samePin(lock.platforms[p], entries[p])) continue;
    const from = lock.platforms[p]?.build ?? lock.platforms[p]?.mpvGitHash ?? "none";
    console.log(`  ${p}: ${from} → ${tag} (mpv ${entries[p].mpvGitHash})`);
    lock.platforms[p] = entries[p];
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log("✓ re-pinned scripts/libmpv.lock.json\n");
}
rollback = () => {
  fs.writeFileSync(lockPath, lockText);
  fs.writeFileSync(componentLockPath, componentText);
  console.error("  Both locks are back as they were; nothing was adopted.");
};

// 4. Vendor every platform: the component is packaged from the vendor dirs.
try {
  run("fetch-libmpv.mjs", ["--all"]);
} catch {
  fail("fetch-libmpv failed (output above).");
}

// A dev build loads target/Frameworks/libmpv.2.dylib ahead of the vendored copy
// and only refreshes it on a rebuild — remove it so the next run picks up this one.
const devFrameworkCopy = path.join(root, "src-tauri", "target", "Frameworks", "libmpv.2.dylib");
if (fs.existsSync(devFrameworkCopy)) {
  fs.rmSync(devFrameworkCopy);
  console.log(`removed ${path.relative(root, devFrameworkCopy)} (the dev build's stale copy)`);
}

// 5. The engine component — current only when bump's check passes AND every zip
// the lock names is really on the release (the packager writes the lock before
// anything is uploaded). Publishing never overwrites, so re-running it is safe.
if (componentProblems().length === 0) {
  console.log(`\n✓ the engine component is already ${tag}, published`);
} else {
  try {
    run("package-engine-component.mjs");
  } catch {
    fail("packaging the engine component failed (output above).");
  }
  if (noPublish) {
    rollback = null;
    console.log("\n--no-publish: packaged, not published. Run `node scripts/publish-engine-components.mjs` before committing —");
    console.log("`npm run bump` refuses a release whose component isn't the pinned libmpv, published.");
  } else {
    try {
      run("publish-engine-components.mjs");
    } catch {
      fail("publishing the engine component failed (output above).");
    }
    const left = componentProblems();
    if (left.length) fail(`the engine component still isn't right after publishing:\n  ${left.join("\n  ")}`);
  }
}
rollback = null;

// 6. What's left is a person's.
console.log(`
Adopted ${tag}. Before committing, play it on real hardware — the engine tests can't hear it:
  macOS:   shared output, a device switch mid-track, Bit-perfect on → off (then play again)
  Windows: one audio and one video track
  Check viboplr.log says the libmpv came from "(vendored)".

Then:
  git commit -m "chore(libmpv): adopt ${tag}" scripts/libmpv.lock.json src-tauri/engine-component.lock.json
`);
