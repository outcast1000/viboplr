#!/usr/bin/env node

// Usage: node scripts/bump.mjs [0.2.0] [--autocommit] [--screenshots]
//
// With no version argument: bumps patch (0.9.5 -> 0.9.6), or the prerelease
// counter when the current version is a beta (0.9.151-beta.1 -> 0.9.151-beta.2).
//
// Full release orchestrator:
//   0. Merges a waiting libmpv update PR once its tests + CI passed (no prompt), or
//      starts the update workflow when upstream is newer and no PR is open
//      (0b. offers to re-vendor libmpv when the vendored copy isn't the pinned one)
//      (0c. lists mpv master's commits past the pinned mpv, offers to run the
//       Build libmpv workflow on them, and asks whether to release on the
//       current mpv — a "no" stops before anything is changed)
//   1. Runs CI checks (typecheck, Rust tests, TS tests) — aborts on failure
//   2. Bumps version in package.json, Cargo.toml, tauri.conf.json
//   3. Updates static version badge + download URLs across docs/ pages
//   4. Generates changelog and prepends a new entry to docs/history.html
//   5. Regenerates screenshots (only with --screenshots, requires Vite dev server)
//   6. Regenerates docs/features.html from docs/features.json
//   7. Counts the code and appends to benchmarks/loc-history.json
//      (7b. warns when a bundled plugin kept in its own repo is behind its latest release)
//   8. Commits, tags, and pushes (with --autocommit)
//
// BETA releases: a hyphenated version (e.g. 0.9.152-beta.1) switches to beta
// mode automatically — the version files are bumped and the tag is pushed
// (release.yml publishes hyphenated tags as GitHub PRERELEASES, invisible to
// the stable updater channel), but ALL site updates (steps 3–6) are skipped
// so viboplr.com keeps advertising the current stable. Beta tags may be cut
// from any branch; stable releases must be cut from main.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { generateChangelog } from "./lib/changelog.mjs";
import { nextVersion } from "./lib/version.mjs";
import { renderFeaturesHtml } from "./lib/features.mjs";
import { locStep } from "./lib/locRepo.mjs";
// MIRROR_REPO is this repo: the libmpv workflow runs, mirrors and opens its PR here.
import { MIRROR_REPO, checkRunsArgs, hostPlatformKey, libmpvAction, requiredChecksState, vendorState } from "./lib/libmpvUpdate.mjs";
import { MPV_BRANCH, MPV_REPO, SHOWN_COMMITS, commitLine, compareUrl, furthestBehind, newestCommits, pinnedMpvCommits } from "./lib/mpvUpstream.mjs";
import { createInterface } from "readline/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const autocommit = args.includes("--autocommit");
const withScreenshots = args.includes("--screenshots");
let version = args.find((a) => !a.startsWith("--"));

if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error(`Invalid version "${version}" — expected x.y.z or x.y.z-suffix (e.g. 0.9.152-beta.1)`);
  process.exit(1);
}

// No version given: bump patch, or the prerelease counter when the current
// version is itself a prerelease (0.9.151-beta.1 -> 0.9.151-beta.2). Computed
// here, before isBeta, so an auto-bumped beta still skips the site steps.
if (!version) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  try {
    version = nextVersion(pkg.version);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  console.log(`No version specified, bumping ${version.includes("-") ? "prerelease" : "patch"}: ${pkg.version} -> ${version}`);
}

// Hyphen = prerelease = beta channel (mirrors the release.yml prerelease guard).
const isBeta = version.includes("-");
if (isBeta) {
  console.log(`BETA release ${version}: site updates (badge, download URLs, changelog, features) will be SKIPPED.\n`);
}

// ---------------------------------------------------------------------------
// Step 0 — A libmpv update waiting?
//
// The Update libmpv workflow re-pins, tests on real macOS + Windows runners,
// opens a PR, starts CI on it and merges it once that passes. This step is the
// fallback for a PR that run left open (CI hadn't reported, or a failure was
// fixed since), taken with no question asked (owner decision, 2026-10-23): a
// PR that is not a draft and has passed main's required checks is merged,
// pulled and vendored, so Step 1 tests the libmpv this release ships; anything
// else is reported and the release goes on without it. A newer upstream build
// with no PR starts the workflow. Before Step 1 on purpose. Fatal only when a
// merge it started fails half-way.
//
// Then (0b) the vendored copy is checked against the lock. The workflow merges
// on its own now, so a pull can move the pin while the gitignored vendor dir
// keeps the old build — and Step 1's engine tests would test that instead.
// Offered, not forced: it is a download. With no terminal to ask on, it says
// so and goes on (the release build vendors from the lock on CI regardless).
// ---------------------------------------------------------------------------

libmpvStep();
await vendorStep();
await mpvMasterStep();

// ---------------------------------------------------------------------------
// Step 0c — Is mpv master ahead of the mpv this release ships?
//
// Compares each platform's pinned mpv commit (the lock's mpvGitHash) with mpv
// master and lists what is new. When it is ahead, offers to start the Build
// libmpv workflow on that master commit (it builds, tests and publishes to
// vendor-libmpv; nothing is re-pinned), and then asks whether this release
// should go on with the mpv it already has — a "no" stops before Step 1, so
// nothing has been changed. Never fatal: a failed lookup is reported and the
// release goes on. With no terminal it only reports.
// ---------------------------------------------------------------------------

async function mpvMasterStep() {
  const gh = (cmd) => execSync(`gh ${cmd}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const errText = (e) => (e.stderr || e.stdout || e.message).toString().trim();
  const lock = JSON.parse(readFileSync(resolve(root, "scripts/libmpv.lock.json"), "utf8"));
  const pinned = pinnedMpvCommits(lock);
  if (pinned.length === 0) return;

  console.log("Checking mpv master against the pinned mpv...\n");
  let base, head, shown, more;
  try {
    const compares = pinned.map((p) => {
      const cmp = JSON.parse(gh(`api repos/${MPV_REPO}/compare/${p.hash}...${MPV_BRANCH}`));
      return { ...p, aheadBy: cmp.ahead_by ?? 0, commits: cmp.commits ?? [] };
    });
    base = furthestBehind(compares);
    if (!base) {
      console.log(`✓ mpv ${MPV_BRANCH} has nothing past the pinned mpv\n`);
      return;
    }
    head = JSON.parse(gh(`api repos/${MPV_REPO}/commits/${MPV_BRANCH}`)).sha;
    const recent = base.commits.length === base.aheadBy
      ? []
      : JSON.parse(gh(`api "repos/${MPV_REPO}/commits?sha=${MPV_BRANCH}&per_page=${SHOWN_COMMITS}"`));
    ({ shown, more } = newestCommits({ aheadBy: base.aheadBy, compareCommits: base.commits, recent }));
  } catch (e) {
    console.error(`⚠ Couldn't compare with mpv ${MPV_BRANCH} (release continues):\n${errText(e)}\n`);
    return;
  }

  const others = pinned.filter((p) => p.hash !== base.hash)
    .map((p) => `${p.platforms.join(", ")} pins ${p.hash}`);
  console.log(`mpv ${MPV_BRANCH} is ${base.aheadBy} commit${base.aheadBy === 1 ? "" : "s"} ahead of ${base.hash} (${base.platforms.join(", ")})` +
    (others.length ? `; ${others.join("; ")}` : "") + ":");
  for (const c of shown) console.log(`  ${commitLine(c)}`);
  if (more > 0) console.log(`  …and ${more} more`);
  console.log(`  ${compareUrl(base.hash)}\n`);

  const dispatch = `workflow run build-libmpv.yml --repo ${MIRROR_REPO} -f publish=true -f mpv_ref=${head}`;
  if (!process.stdin.isTTY) {
    console.log(`  To build it: gh ${dispatch}\n`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim().toLowerCase();
  const build = await ask(`  Run the Build libmpv workflow on mpv ${MPV_BRANCH} ${head.slice(0, 10)} (builds, tests, publishes; re-pins nothing)? [y/N] `);
  if (build !== "y" && build !== "yes") {
    rl.close();
    console.log("  Not built — going on with the pinned mpv.\n");
    return;
  }
  try {
    gh(dispatch);
    console.log(`  Started: gh run list --workflow build-libmpv.yml --repo ${MIRROR_REPO}`);
  } catch (e) {
    console.error(`  ⚠ Couldn't start the workflow: ${errText(e)}`);
  }
  const goOn = await ask(`  Go on with this release on the current mpv (${base.hash})? [Y/n] `);
  rl.close();
  if (goOn === "n" || goOn === "no") {
    console.log("\nRelease stopped before any change. Re-pin to the new build once it passes, then run bump again.");
    process.exit(0);
  }
  console.log("  Going on with the current mpv.\n");
}

async function vendorStep() {
  const platform = hostPlatformKey();
  const lock = JSON.parse(readFileSync(resolve(root, "scripts/libmpv.lock.json"), "utf8"));
  const stampPath = resolve(root, "src-tauri/vendor/libmpv", platform, ".stamp");
  const state = vendorState(lock.platforms?.[platform], existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null);
  if (state === "current" || state === "unpinned") return;

  const what = state === "missing"
    ? `No libmpv is vendored for ${platform}`
    : `The vendored libmpv (${platform}) isn't the one scripts/libmpv.lock.json pins`;
  console.log(`⚠ ${what} — Step 1's engine tests would ${state === "missing" ? "skip" : "test the old build"}.`);
  if (!process.stdin.isTTY) {
    console.log("  Run `node scripts/fetch-libmpv.mjs` to vendor it. Going on without it.\n");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("  Vendor it now (node scripts/fetch-libmpv.mjs)? [Y/n] ")).trim().toLowerCase();
  rl.close();
  if (answer && answer !== "y" && answer !== "yes") {
    console.log("  Skipped — going on with what is vendored.\n");
    return;
  }
  try {
    execSync("node scripts/fetch-libmpv.mjs", { cwd: root, stdio: "inherit" });
  } catch {
    console.error("\n✗ fetch-libmpv failed (output above) — not releasing on a half-vendored libmpv.");
    process.exit(1);
  }
  console.log("✓ libmpv vendored from the lock\n");
}

function libmpvStep() {
  const gh = (cmd) => execSync(`gh ${cmd}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const errText = (e) => (e.stderr || e.stdout || e.message).toString().trim();

  console.log("Checking for a libmpv update...\n");
  let pr = null;
  let checks = null;
  try {
    const open = JSON.parse(gh(`pr list --repo ${MIRROR_REPO} --head bot/libmpv-update --state open --json number,title,url,isDraft,headRefOid`));
    pr = open[0] ?? null;
    if (pr) {
      checks = requiredChecksState(JSON.parse(gh(checkRunsArgs(MIRROR_REPO, pr.headRefOid))));
    }
  } catch (e) {
    console.error(`⚠ Couldn't read the libmpv update PR (is gh signed in?) — skipping this step:\n${errText(e)}\n`);
    return;
  }
  let behind = false;
  if (!pr) {
    try {
      execSync("node scripts/update-libmpv.mjs --check", { cwd: root, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      if (e.status === 3) behind = true;
      else console.error(`⚠ libmpv check reported a problem (release continues):\n${errText(e)}`);
    }
  }

  const onMain = git("rev-parse --abbrev-ref HEAD") === "main";
  const { action, reason } = libmpvAction({ pr, checks, behind, onMain });
  switch (action) {
    case "none":
      console.log(`✓ ${reason}\n`);
      return;
    case "skip":
      console.log(`⚠ ${reason}\n  Releasing without it.\n`);
      return;
    case "run":
      console.log(`${reason}...`);
      try {
        gh(`workflow run update-libmpv.yml --repo ${MIRROR_REPO}`);
        console.log("  Started — its PR is taken by the next bump once CI passes on it.\n");
      } catch (e) {
        console.error(`⚠ Couldn't start the workflow (release continues): ${errText(e)}\n`);
      }
      return;
    case "merge":
      console.log(`${reason}...`);
      // Once the merge lands, main has the new pin whether or not this release
      // goes on, so every failure from here stops the release instead of shipping
      // on a half-applied state.
      try {
        gh(`pr merge ${pr.number} --repo ${MIRROR_REPO} --merge`);
        console.log("  Pulling main...");
        git("pull --ff-only origin main");
      } catch (e) {
        console.error(`\n✗ ${errText(e)}`);
        console.error("  If the merge went through, pull main yourself (git pull origin main) and re-run bump.");
        process.exit(1);
      }
      console.log("  Vendoring the new libmpv...");
      try {
        execSync("node scripts/fetch-libmpv.mjs", { cwd: root, stdio: "inherit" });
      } catch {
        console.error("\n✗ fetch-libmpv failed with the new pin (output above) — not releasing on it.");
        process.exit(1);
      }
      console.log(`✓ libmpv update #${pr.number} merged — this release ships it, and the checks below test it\n`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Run CI checks
// ---------------------------------------------------------------------------

console.log("Running CI checks...\n");

const checks = [
  { label: "TypeScript typecheck", cmd: "npx tsc --noEmit" },
  { label: "Rust tests", cmd: "cargo test", cwd: resolve(root, "src-tauri") },
  { label: "TypeScript tests", cmd: "npm test" },
];

for (const check of checks) {
  console.log(`  ${check.label}...`);
  try {
    execSync(check.cmd, { cwd: check.cwd || root, encoding: "utf-8", stdio: "pipe" });
    console.log(`  ✓ ${check.label} passed`);
  } catch (e) {
    console.error(`\n✗ ${check.label} failed:\n`);
    console.error(e.stdout || e.stderr || e.message);
    process.exit(1);
  }
}

console.log("\n✓ All checks passed\n");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO = "outcast1000/viboplr";
// NOTE: computed lazily (see urls()) — `version` may still be undefined here
// when the patch-number default in Step 2 hasn't run yet. Building these
// eagerly is what once wrote "vundefined" URLs into the site.
// Windows ships an NSIS installer (bundle targets: nsis/dmg/app) — not MSI.
function urls() {
  return {
    dmg: `https://github.com/${REPO}/releases/download/v${version}/Viboplr_${version}_aarch64.dmg`,
    exe: `https://github.com/${REPO}/releases/download/v${version}/Viboplr_${version}_x64-setup.exe`,
  };
}
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8" }).trim();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMd(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function markdownToHtml(body) {
  if (!body) return "";
  const lines = body.trim().split("\n");
  const htmlParts = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      continue;
    }

    const listMatch = trimmed.match(/^[-*]\s+(.+)/);
    const headingMatch = trimmed.match(/^###\s+(.+)/);
    if (listMatch) {
      if (!inList) { htmlParts.push("<ul>"); inList = true; }
      htmlParts.push(`<li>${inlineMd(listMatch[1])}</li>`);
    } else if (headingMatch) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      htmlParts.push(`<h4>${escapeHtml(headingMatch[1])}</h4>`);
    } else if (trimmed.startsWith("## ")) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
    } else {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      htmlParts.push(`<p>${inlineMd(trimmed)}</p>`);
    }
  }
  if (inList) htmlParts.push("</ul>");

  return htmlParts.join("\n          ");
}

// ---------------------------------------------------------------------------
// Step 2 — Bump version in source files
// ---------------------------------------------------------------------------

console.log(`\nBumping version to ${version}...\n`);

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("Usage: node scripts/bump.mjs [version]  (e.g. 0.2.0, or 0.2.0-beta.1 for a beta prerelease)");
  process.exit(1);
}

const versionFiles = [
  { path: "package.json", replace: (s) => s.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`) },
  { path: "src-tauri/Cargo.toml", replace: (s) => s.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`) },
  { path: "src-tauri/tauri.conf.json", replace: (s) => s.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`) },
  // The e2e Tauri mock reports the app version, which bundled plugins'
  // `minAppVersion` is checked against — a stale one loaded Last.fm as incompatible.
  { path: "tests/e2e/tauri-mock.js", replace: (s) => s.replace(/(cmd === 'plugin:app\|version'\) return ')[^']*'/, `$1${version}'`) },
];

for (const { path, replace } of versionFiles) {
  const full = resolve(root, path);
  const before = readFileSync(full, "utf8");
  const after = replace(before);
  if (before === after) {
    console.error(`⚠ No version found to replace in ${path}`);
  } else {
    writeFileSync(full, after);
    console.log(`✓ ${path} → ${version}`);
  }
}

// Sync Cargo.lock with the bumped Cargo.toml. CI runs `cargo test --locked`,
// which refuses a stale lock — without this the release commit only passed
// CI when an editor's rust-analyzer happened to refresh the lock in time
// (this broke the first beta release).
console.log("  Syncing Cargo.lock...");
execSync("cargo update --workspace", { cwd: resolve(root, "src-tauri"), stdio: "pipe" });
console.log("✓ src-tauri/Cargo.lock");

// ---------------------------------------------------------------------------
// Steps 3–6 — site updates (badge/URLs, changelog, screenshots, features).
// Skipped entirely for BETA releases: the public site keeps pointing at the
// current stable; the beta exists only as a GitHub prerelease.
// ---------------------------------------------------------------------------

if (!isBeta) {

// ---------------------------------------------------------------------------
// Step 3 — Update static version badge + download URLs in docs/ pages
// ---------------------------------------------------------------------------

console.log("\nUpdating docs pages...\n");

const docsDir = resolve(root, "docs");

function updateVersionBadge(html) {
  return html.replace(
    /<span id="version-badge">[^<]*<\/span>/g,
    `<span id="version-badge">v${version}</span>`
  );
}

function updateDownloadUrls(html) {
  // Replace existing versioned GitHub release URLs
  const { dmg, exe } = urls();
  html = html.replace(
    /https:\/\/github\.com\/outcast1000\/viboplr\/releases\/download\/v[^/]+\/Viboplr_[^"]*_aarch64\.dmg/g,
    dmg
  );
  // Matches both the current NSIS name and the legacy (broken) MSI links.
  html = html.replace(
    /https:\/\/github\.com\/outcast1000\/viboplr\/releases\/download\/v[^/]+\/Viboplr_[^"]*_x64[^"]*\.(?:msi|exe)/g,
    exe
  );
  // Replace placeholder anchor links (first-time setup)
  html = html.replace(/href="download\.html#download-macos"/g, `href="${dmg}"`);
  html = html.replace(/href="download\.html#download-windows"/g, `href="${exe}"`);
  html = html.replace(/(<a\b[^>]*?)href="#download-macos"/g, `$1href="${dmg}"`);
  html = html.replace(/(<a\b[^>]*?)href="#download-windows"/g, `$1href="${exe}"`);
  return html;
}

// Update index.html
{
  const p = resolve(docsDir, "index.html");
  let html = readFileSync(p, "utf8");
  html = updateVersionBadge(html);
  html = updateDownloadUrls(html);
  writeFileSync(p, html);
  console.log("✓ docs/index.html");
}

// Update download.html
{
  const p = resolve(docsDir, "download.html");
  let html = readFileSync(p, "utf8");
  html = updateVersionBadge(html);
  html = updateDownloadUrls(html);
  writeFileSync(p, html);
  console.log("✓ docs/download.html");
}

// Update the per-platform install pages. Their buttons link here (not to the
// asset), but each carries a static fallback URL — in the manual-download link
// AND the JS FALLBACK_URL literal — that must track the release. The auto-
// download JS prefers the freshest asset from the GitHub API and only uses the
// fallback when the API is unavailable, so keeping it current still matters.
for (const page of ["install-mac.html", "install-windows.html"]) {
  const p = resolve(docsDir, page);
  if (!existsSync(p)) continue;
  let html = readFileSync(p, "utf8");
  html = updateVersionBadge(html);
  html = updateDownloadUrls(html);
  writeFileSync(p, html);
  console.log(`✓ docs/${page}`);
}

// Update history.html version badge (if present)
{
  const p = resolve(docsDir, "history.html");
  if (existsSync(p)) {
    let html = readFileSync(p, "utf8");
    const updated = updateVersionBadge(html);
    if (updated !== html) {
      writeFileSync(p, updated);
      console.log("✓ docs/history.html (version badge)");
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Generate changelog and prepend entry to docs/history.html
// ---------------------------------------------------------------------------

console.log("\nGenerating changelog...\n");

let latestTag = null;
try {
  // Exclude prerelease (beta) tags: a stable's public changelog must span
  // since the last STABLE, so commits shipped through betas aren't dropped.
  latestTag = git("describe --tags --abbrev=0 --exclude='*-*'");
} catch {
  // no stable tags yet
}

const range = latestTag ? `${latestTag}..HEAD` : "HEAD";
let commitMessages = [];
try {
  const log = git(`log ${range} --pretty=format:"%s"`);
  if (log) commitMessages = log.split("\n").filter(Boolean);
} catch {
  // empty log
}

console.log(`Found ${commitMessages.length} commit(s) since ${latestTag || "beginning"}`);

const changelogMd = generateChangelog(commitMessages);
const changelogHtml = markdownToHtml(changelogMd);
const releaseDate = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const timelineEntry = `<div class="timeline-entry reveal">
        <div class="timeline-header">
          <span class="timeline-version">Viboplr v${version}</span>
          <span class="timeline-date">${releaseDate}</span>
        </div>
        <div class="timeline-body">
          ${changelogHtml}
        </div>
        <div class="timeline-assets">
            <a href="${urls().dmg}" class="timeline-asset-link">${DOWNLOAD_ICON} Viboplr_${version}_aarch64.dmg</a>
            <a href="${urls().exe}" class="timeline-asset-link">${DOWNLOAD_ICON} Viboplr_${version}_x64-setup.exe</a>
        </div>
      </div>`;

{
  const historyPath = resolve(docsDir, "history.html");
  if (existsSync(historyPath)) {
    const html = readFileSync(historyPath, "utf8");
    const marker = '<div class="timeline" id="timeline">';
    const idx = html.indexOf(marker);
    if (idx === -1) {
      console.error("⚠ Could not find timeline container in history.html — skipping");
    } else {
      const insertPos = idx + marker.length;
      const newHtml =
        html.slice(0, insertPos) +
        "\n        " + timelineEntry + "\n      " +
        html.slice(insertPos);
      writeFileSync(historyPath, newHtml);
      console.log("✓ docs/history.html (new changelog entry)");
    }
  } else {
    console.error("⚠ docs/history.html not found — skipping");
  }
}

// ---------------------------------------------------------------------------
// Step 5 — Regenerate screenshots (only with --screenshots flag)
// ---------------------------------------------------------------------------

if (withScreenshots) {
  console.log("\nRegenerating screenshots...\n");

  try {
    execSync("npm run screenshots", { cwd: root, encoding: "utf-8", stdio: "inherit", timeout: 120_000 });
    console.log("✓ Screenshots regenerated");
  } catch {
    console.log("⚠ Screenshot generation failed (requires dev server on localhost:1420)");
  }
} else {
  console.log("\n⏭ Screenshots skipped (pass --screenshots to regenerate)");
}

// ---------------------------------------------------------------------------
// Step 6 — Regenerate docs/features.html from docs/features.json
// ---------------------------------------------------------------------------

console.log("\nRegenerating features page...\n");

const featuresJsonPath = resolve(docsDir, "features.json");
if (existsSync(featuresJsonPath)) {
  const features = JSON.parse(readFileSync(featuresJsonPath, "utf8"));
  writeFileSync(resolve(docsDir, "features.html"), renderFeaturesHtml(features, version));
  console.log("✓ docs/features.html");
} else {
  console.error("⚠ docs/features.json not found — skipping features page generation");
}

} // end !isBeta (site updates)

// ---------------------------------------------------------------------------
// Step 7 — Count the code and record it in benchmarks/loc-history.json
//
// Counted from the working tree, so the entry describes exactly what the
// release commit below is about to contain. Betas print the report but don't
// append: they may be cut from any branch, and a feature branch's numbers
// would make the series jump around instead of tracking shipped versions.
// Never fatal — a release must not fail over a metric.
// ---------------------------------------------------------------------------

console.log("\nCounting code size...\n");

try {
  const { report } = locStep({ version, ref: `v${version}`, save: !isBeta });
  console.log(report);
  console.log(
    isBeta
      ? "\n  (beta — not appended to benchmarks/loc-history.json)"
      : "\n✓ benchmarks/loc-history.json"
  );
} catch (e) {
  console.error("⚠ Code size step failed (release continues):", e.message);
}

// ---------------------------------------------------------------------------
// Step 7b — Are the bundled plugins kept in their own repo (Last.fm) current?
//
// The app ships a pinned release of each (scripts/bundled-plugins.lock.json).
// Users get newer releases through the update check anyway, but a fresh
// install starts from the pinned one, so say so when it is behind. Never
// fatal: the copy itself is held to the lock by bundledPlugins.test.ts, which
// Step 1 already ran.
// ---------------------------------------------------------------------------

console.log("\nChecking bundled plugins against their releases...\n");

try {
  console.log(execSync("node scripts/sync-bundled-plugins.mjs --check 2>&1", { cwd: root, encoding: "utf8" }).trim());
} catch (e) {
  console.error(`⚠ Bundled plugin check reported a problem (release continues):\n${(e.stdout || e.message).trim()}`);
}

// ---------------------------------------------------------------------------
// Step 8 — Git operations
// ---------------------------------------------------------------------------

// Stable releases ship the site and MUST come from main; betas may be cut
// from any branch (e.g. a feature branch under test) and push that branch.
const currentBranch = git("rev-parse --abbrev-ref HEAD");
if (!isBeta && currentBranch !== "main") {
  console.error(`\n✗ Stable releases must be cut from main (currently on "${currentBranch}").`);
  console.error(`  Use a hyphenated version (e.g. ${version}-beta.1) for a branch beta.`);
  process.exit(1);
}
// Push to the branch's upstream on origin when it has one. A worktree branch
// that tracks origin/main (worktree-1 does) must land its release commit on
// main: pushing it by its own name created — and once a stale copy existed,
// was rejected by — a remote branch nobody uses (v1.0.112-beta.10).
function originUpstreamBranch() {
  try {
    const upstream = git("rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null");
    return upstream.startsWith("origin/") ? upstream.slice("origin/".length) : null;
  } catch {
    return null; // no upstream configured
  }
}
const pushTarget = originUpstreamBranch() ?? currentBranch;
const pushCmd = pushTarget === currentBranch
  ? `git push origin ${currentBranch} --tags`
  : `git push origin HEAD:${pushTarget} --tags`;

if (autocommit) {
  console.log("\nCommitting and tagging...\n");
  const run = (label, cmd) => {
    console.log(`${label}`);
    console.log(`  $ ${cmd}`);
    // Redirect stderr to stdout so we capture all git output (e.g. git push writes to stderr)
    const output = execSync(`${cmd} 2>&1`, { cwd: root, encoding: "utf8" }).trim();
    if (output) console.log(`  ${output.replace(/\n/g, "\n  ")}`);
    console.log();
  };
  run("Staging changes...", "git add -A");
  run("Creating release commit...", `git commit -m "release: v${version}"`);
  run("Tagging release...", `git tag v${version}`);
  run("Pushing to origin...", pushCmd);
  console.log(`Done! Released v${version}${isBeta ? " (beta prerelease)" : ""}.`);
  if (!isBeta) {
    console.log(
      "Note: viboplr.com deploys AFTER both installers build — release.yml's deploy-site job\n" +
      "dispatches the Pages deploy once the macOS + Windows assets are uploaded."
    );
  }
  printSmokeReminder(version);
} else {
  console.log(`\nFiles updated. To commit and tag manually:\n`);
  console.log(`  git add -A`);
  console.log(`  git commit -m "release: v${version}"`);
  console.log(`  git tag v${version}`);
  console.log(`  ${pushCmd}`);
  console.log(`\nOr re-run with --autocommit to do this automatically.`);
  printSmokeReminder(version);
}

// ---------------------------------------------------------------------------
// Post-release — smoke-test the artifact CI is about to build
//
// Deliberately a printed reminder rather than a step above: the release build
// happens in the GitHub workflow (tauri-action, per-platform matrix) *after*
// this tag is pushed, so at this point there is no new bundle on this machine.
// Running the smoke test here would launch whatever stale app is in
// /Applications and pass — the precise flavour of meaningless green the smoke
// test exists to prevent. `--expect-version` is what makes the reminder safe to
// follow late: run it against the old build and it fails loudly.
// ---------------------------------------------------------------------------
function printSmokeReminder(v) {
  if (process.platform !== "darwin") return;
  console.log(`\nOnce CI publishes and you've installed v${v}, smoke-test the real bundle:`);
  console.log(`  npm run app:smoke -- --expect-version ${v}${v.includes("-") ? "" : " --save"}`);
}
