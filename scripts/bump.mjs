#!/usr/bin/env node

// Usage: node scripts/bump.mjs [0.2.0] [--autocommit] [--screenshots]
//
// With no version argument: bumps patch (0.9.5 -> 0.9.6), or the prerelease
// counter when the current version is a beta (0.9.151-beta.1 -> 0.9.151-beta.2).
//
// Full release orchestrator:
//   1. Runs CI checks (typecheck, Rust tests, TS tests) — aborts on failure
//   2. Bumps version in package.json, Cargo.toml, tauri.conf.json
//   3. Updates static version badge + download URLs across docs/ pages
//   4. Generates changelog and prepends a new entry to docs/history.html
//   5. Regenerates screenshots (only with --screenshots, requires Vite dev server)
//   6. Regenerates docs/features.html from docs/features.json
//   7. Commits, tags, and pushes (with --autocommit)
//
// BETA releases: a hyphenated version (e.g. 0.9.152-beta.1) switches to beta
// mode automatically — the version files are bumped and the tag is pushed
// (release.yml publishes hyphenated tags as GitHub PRERELEASES, invisible to
// the stable updater channel), but ALL site updates (steps 3–6) are skipped
// so viboplr.com keeps advertising the current stable. Beta tags may be cut
// from any branch; stable releases must be cut from main.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { generateChangelog } from "./lib/changelog.mjs";
import { nextVersion } from "./lib/version.mjs";
import { renderFeaturesHtml } from "./lib/features.mjs";

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
// Step 7 — Git operations
// ---------------------------------------------------------------------------

// Stable releases ship the site and MUST come from main; betas may be cut
// from any branch (e.g. a feature branch under test) and push that branch.
const currentBranch = git("rev-parse --abbrev-ref HEAD");
if (!isBeta && currentBranch !== "main") {
  console.error(`\n✗ Stable releases must be cut from main (currently on "${currentBranch}").`);
  console.error(`  Use a hyphenated version (e.g. ${version}-beta.1) for a branch beta.`);
  process.exit(1);
}
const pushCmd = `git push origin ${currentBranch} --tags`;

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
} else {
  console.log(`\nFiles updated. To commit and tag manually:\n`);
  console.log(`  git add -A`);
  console.log(`  git commit -m "release: v${version}"`);
  console.log(`  git tag v${version}`);
  console.log(`  ${pushCmd}`);
  console.log(`\nOr re-run with --autocommit to do this automatically.`);
}
