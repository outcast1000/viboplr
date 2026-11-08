#!/usr/bin/env node

// Usage: node scripts/bump.mjs [0.2.0] [--autocommit] [--screenshots]
//
// With no version argument: bumps patch (0.9.5 -> 0.9.6), or the prerelease
// counter when the current version is a beta (0.9.151-beta.1 -> 0.9.151-beta.2).
//
// Full release orchestrator:
//   0. libmpv: offers to re-vendor when the vendored copy isn't the pinned one (0a),
//      refuses the release when the downloadable engine component isn't the
//      pinned libmpv (0b), and reports a newer build or mpv master commits past
//      the pinned mpv with the two commands that adopt them (0c — report only)
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
import { ENGINE_COMPONENTS_REPO, ENGINE_COMPONENTS_TAG, LIBMPV_BUILD_REPO, engineComponentMismatches, hostPlatformKey, newestBuild, pinnedBuild, unpublishedComponents, vendorState } from "./lib/libmpvPin.mjs";
import { MPV_BRANCH, MPV_REPO, commitLine, compareUrl, furthestBehind, pinnedMpvCommits } from "./lib/mpvUpstream.mjs";
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
// Step 0 — libmpv
//
// libmpv is our own build (outcast1000/viboplr-libmpv), adopted by hand with
// `npm run libmpv:adopt`. These checks make sure the release ships the pinned
// build, tested, with a matching engine component — and say when a newer one
// is waiting. Before Step 1 on purpose: its engine tests run the vendored copy.
// ---------------------------------------------------------------------------

await vendorStep();
engineComponentStep();
await libmpvBuildsStep();

// ---------------------------------------------------------------------------
// Step 0b — Is the downloadable engine component the libmpv this release bundles?
//
// src-tauri/engine-component.lock.json is baked into the binary, and it is what
// Settings → Playback → "Try a replacement copy" installs. `npm run libmpv:adopt`
// moves it with the pin, but a hand edit can leave it behind: cd123f3b moved
// libmpv to the macOS 27 fix and kept the component on the build without it.
// Its zips must also really be on the release: the packager writes the lock
// before anything is uploaded, so a failed publish (or `--no-publish`) leaves a
// lock that reads as complete and a download that 404s. Fatal, before anything
// changes: the fix is one command and a commit. Only an unreadable release
// list is let through, with a warning.
// ---------------------------------------------------------------------------

function engineComponentStep() {
  const read = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
  const lock = read("scripts/libmpv.lock.json");
  const component = read("src-tauri/engine-component.lock.json");
  const problems = engineComponentMismatches(lock, component)
    .map((m) => `${m.platform}: component ${m.actual ?? "(not published)"}, libmpv pin ${m.expected}`);
  try {
    const names = execSync(`gh release view ${ENGINE_COMPONENTS_TAG} --repo ${ENGINE_COMPONENTS_REPO} --json assets --jq '.assets[].name'`,
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const published = new Set(names.split("\n").filter(Boolean));
    for (const u of unpublishedComponents(component, published)) {
      problems.push(`${u.platform}: ${u.name} isn't on the ${ENGINE_COMPONENTS_TAG} release`);
    }
  } catch (e) {
    console.error(`⚠ Couldn't list the ${ENGINE_COMPONENTS_TAG} release, so whether the component is published is unchecked:\n${(e.stderr || e.message).toString().trim()}\n`);
  }
  if (problems.length === 0) {
    console.log("✓ engine component matches the pinned libmpv, published\n");
    return;
  }
  console.error("✗ The downloadable engine component isn't the libmpv this release bundles, published:");
  for (const p of problems) console.error(`    ${p}`);
  const build = pinnedBuild(lock);
  console.error("\n  Repackage and publish it from the pinned libmpv, then commit the component lock:");
  if (build) {
    console.error(`    npm run libmpv:adopt -- ${build}`);
  } else {
    console.error("    node scripts/fetch-libmpv.mjs --all");
    console.error("    node scripts/package-engine-component.mjs");
    console.error("    node scripts/publish-engine-components.mjs");
  }
  console.error("    git commit -m \"chore(libmpv): repackage the engine component\" src-tauri/engine-component.lock.json\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 0c — Is a newer libmpv waiting?
//
// Two questions, both report only (never a prompt, never fatal — a failed
// lookup is reported and the release goes on with the pinned build):
//   - Is the build repo's newest build one this release doesn't pin?
//     Built but not adopted: `npm run libmpv:adopt` takes it.
//   - Is mpv master ahead of the pinned mpv? Shows the commit this release
//     ships, how many master has after it, the newest, and the compare link,
//     then the build command; adopting the result is the same one command.
// Adopting can't finish inside a release (a person has to listen to it), so
// the commands are printed for afterwards.
// ---------------------------------------------------------------------------

async function libmpvBuildsStep() {
  // Generous buffer, and --jq everywhere: a compare across a release's worth of
  // commits carries every changed file and runs to megabytes — past execSync's
  // 1 MB default, which turned this step into a silent warning.
  const gh = (cmd) => execSync(`gh ${cmd}`, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const errText = (e) => (e.stderr || e.stdout || e.message).toString().trim();
  const commitJq = "{sha, commit: {message: .commit.message, committer: {date: .commit.committer.date}}}";
  const lock = JSON.parse(readFileSync(resolve(root, "scripts/libmpv.lock.json"), "utf8"));
  const pinned = pinnedBuild(lock);

  console.log("Checking for a newer libmpv...\n");
  try {
    const newest = newestBuild(JSON.parse(gh(`api "repos/${LIBMPV_BUILD_REPO}/releases?per_page=100"`)));
    if (newest && newest !== pinned) {
      console.log(`  ${LIBMPV_BUILD_REPO}'s newest build is ${newest}; this release pins ${pinned ?? "a mix of builds"}.`);
      console.log(`  This release goes on with the pin. To adopt it afterwards: npm run libmpv:adopt -- ${newest}\n`);
    } else {
      console.log(`✓ the pinned libmpv is ${LIBMPV_BUILD_REPO}'s newest build\n`);
    }
  } catch (e) {
    console.error(`⚠ Couldn't read ${LIBMPV_BUILD_REPO}'s builds (release continues):\n${errText(e)}\n`);
  }

  const commits = pinnedMpvCommits(lock);
  if (commits.length === 0) return;
  let base, baseCommit, headCommit;
  try {
    const compares = commits.map((p) => ({
      ...p,
      aheadBy: Number(gh(`api repos/${MPV_REPO}/compare/${p.hash}...${MPV_BRANCH} --jq .ahead_by`)) || 0,
    }));
    base = furthestBehind(compares);
    if (!base) {
      console.log(`✓ mpv ${MPV_BRANCH} has nothing past the pinned mpv\n`);
      return;
    }
    baseCommit = JSON.parse(gh(`api repos/${MPV_REPO}/commits/${base.hash} --jq '${commitJq}'`));
    headCommit = JSON.parse(gh(`api repos/${MPV_REPO}/commits/${MPV_BRANCH} --jq '${commitJq}'`));
  } catch (e) {
    console.error(`⚠ Couldn't compare with mpv ${MPV_BRANCH} (release continues):\n${errText(e)}\n`);
    return;
  }

  const others = commits.filter((p) => p.hash !== base.hash)
    .map((p) => `${p.platforms.join(", ")} pins ${p.hash}`);
  console.log(`  This release's mpv (${base.platforms.join(", ")}): ${commitLine(baseCommit)}`);
  if (others.length) console.log(`  (${others.join("; ")})`);
  console.log(`  mpv ${MPV_BRANCH} has ${base.aheadBy} commit${base.aheadBy === 1 ? "" : "s"} after it; newest: ${commitLine(headCommit)}`);
  console.log(`  ${compareUrl(base.hash)}\n`);
  console.log(`  This release goes on with the pinned mpv. To move to mpv ${MPV_BRANCH} afterwards:`);
  console.log(`    1. gh workflow run build-libmpv.yml --repo ${LIBMPV_BUILD_REPO} -f publish=true -f mpv_ref=${headCommit.sha}`);
  console.log(`       It builds, runs this repo's engine tests and publishes a release. In its log, check every`);
  console.log(`       "patched mpv: …" line: "not applied (doesn't fit this mpv)" usually means upstream fixed it.`);
  console.log(`    2. npm run libmpv:adopt   (re-pins, vendors, repackages the engine component; prints the play-test)\n`);
}

// Step 0a — Is the vendored libmpv the pinned one? A pull can move the pin
// while the gitignored vendor dir keeps the old build, and Step 1's engine
// tests would test that instead. Offered, not forced: it is a download. With no
// terminal to ask on, it says so and goes on (the release build vendors from
// the lock on CI regardless).
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
