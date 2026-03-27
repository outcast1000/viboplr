#!/usr/bin/env node

// Usage: node scripts/bump.mjs [0.2.0] [--autocommit]
//
// Full release orchestrator:
//   1. Bumps version in package.json, Cargo.toml, tauri.conf.json
//   2. Updates static version badge + download URLs across docs/ pages
//   3. Generates changelog and prepends a new entry to docs/history.html
//   4. Regenerates docs/features.html from docs/features.json
//   5. Commits, tags, and pushes (with --autocommit)

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { generateChangelog } from "./lib/changelog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const autocommit = args.includes("--autocommit");
let version = args.find((a) => !a.startsWith("--"));

if (!version) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const parts = pkg.version.split(".").map(Number);
  parts[parts.length - 1] += 1;
  version = parts.join(".");
  console.log(`No version specified, bumping patch: ${pkg.version} -> ${version}`);
}

console.log(`\nBumping version to ${version}...\n`);

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/bump.mjs [version]  (e.g. 0.2.0)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO = "outcast1000/viboplr";
const DMG_URL = `https://github.com/${REPO}/releases/download/v${version}/Viboplr_${version}_aarch64.dmg`;
const MSI_URL = `https://github.com/${REPO}/releases/download/v${version}/Viboplr_${version}_x64_en-US.msi`;
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
// Step 1 — Bump version in source files
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Step 2 — Update static version badge + download URLs in docs/ pages
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
  html = html.replace(
    /https:\/\/github\.com\/outcast1000\/viboplr\/releases\/download\/v[^/]+\/Viboplr_[^"]*_aarch64\.dmg/g,
    DMG_URL
  );
  html = html.replace(
    /https:\/\/github\.com\/outcast1000\/viboplr\/releases\/download\/v[^/]+\/Viboplr_[^"]*_x64_en-US\.msi/g,
    MSI_URL
  );
  // Replace placeholder anchor links (first-time setup)
  html = html.replace(/href="download\.html#download-macos"/g, `href="${DMG_URL}"`);
  html = html.replace(/href="download\.html#download-windows"/g, `href="${MSI_URL}"`);
  html = html.replace(/(<a\b[^>]*?)href="#download-macos"/g, `$1href="${DMG_URL}"`);
  html = html.replace(/(<a\b[^>]*?)href="#download-windows"/g, `$1href="${MSI_URL}"`);
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
// Step 3 — Generate changelog and prepend entry to docs/history.html
// ---------------------------------------------------------------------------

console.log("\nGenerating changelog...\n");

let latestTag = null;
try {
  latestTag = git("describe --tags --abbrev=0");
} catch {
  // no tags yet
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
            <a href="${DMG_URL}" class="timeline-asset-link">${DOWNLOAD_ICON} Viboplr_${version}_aarch64.dmg</a>
            <a href="${MSI_URL}" class="timeline-asset-link">${DOWNLOAD_ICON} Viboplr_${version}_x64_en-US.msi</a>
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
// Step 4 — Regenerate docs/features.html from docs/features.json
// ---------------------------------------------------------------------------

console.log("\nRegenerating features page...\n");

const featuresJsonPath = resolve(docsDir, "features.json");
if (existsSync(featuresJsonPath)) {
  const features = JSON.parse(readFileSync(featuresJsonPath, "utf8"));

  const featureSections = features
    .map(
      (f) => `  <!-- Feature: ${f.label} -->
  <section class="feature-section">
    <div class="container">
      <div class="feature-row reveal">
        <div class="feature-content">
          <span class="feature-label">${f.label}</span>
          <h2>${f.heading}</h2>
          <p>${f.description}</p>
          <div class="feature-list">
${f.items.map((item) => `            <div class="feature-list-item">${item}</div>`).join("\n")}
          </div>
        </div>
        <div class="feature-image">
          <span>${f.label} screenshot &mdash; coming soon</span>
        </div>
      </div>
    </div>
  </section>`
    )
    .join("\n\n");

  const featuresHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Features — Viboplr</title>
  <meta name="description" content="Gapless playback, full-text search, server integration, mini player, keyboard shortcuts, and more.">
  <link rel="canonical" href="https://viboplr.com/features.html">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://viboplr.com/features.html">
  <meta property="og:title" content="Features — Viboplr">
  <meta property="og:description" content="Gapless playback, full-text search, server integration, mini player, keyboard shortcuts, and more.">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Features — Viboplr">
  <meta name="twitter:description" content="Gapless playback, full-text search, server integration, mini player, keyboard shortcuts, and more.">
  <link rel="icon" href="assets/icon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <!-- Navigation -->
  <nav class="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">
        <svg viewBox="0 0 512 512" width="34" height="34" aria-hidden="true">
          <defs><linearGradient id="navGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FF6B6B"/><stop offset="100%" stop-color="#E91E8A"/></linearGradient></defs>
          <path d="M 110,90 L 256,410 L 402,90" fill="none" stroke="url(#navGrad)" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="30" y1="165" x2="100" y2="165" stroke="#FF5C7A" stroke-width="16" stroke-linecap="round" opacity="0.85"/>
          <line x1="50" y1="230" x2="118" y2="230" stroke="#F63D88" stroke-width="14" stroke-linecap="round" opacity="0.55"/>
          <line x1="78" y1="295" x2="140" y2="295" stroke="#EE2690" stroke-width="11" stroke-linecap="round" opacity="0.3"/>
          <line x1="412" y1="165" x2="482" y2="165" stroke="#FF5C7A" stroke-width="16" stroke-linecap="round" opacity="0.85"/>
          <line x1="394" y1="230" x2="462" y2="230" stroke="#F63D88" stroke-width="14" stroke-linecap="round" opacity="0.55"/>
          <line x1="372" y1="295" x2="434" y2="295" stroke="#EE2690" stroke-width="11" stroke-linecap="round" opacity="0.3"/>
        </svg>
        Viboplr
      </a>
      <div class="nav-links" id="navLinks">
        <a href="index.html" class="nav-link">Home</a>
        <a href="features.html" class="nav-link active">Features</a>
        <a href="download.html" class="nav-link">Download</a>
        <a href="history.html" class="nav-link">History</a>
        <a href="download.html" class="nav-cta">Get Viboplr</a>
      </div>
      <button class="nav-hamburger" id="navHamburger" aria-label="Toggle menu">
        <span></span>
        <span></span>
        <span></span>
      </button>
    </div>
  </nav>

  <!-- Page Header -->
  <section class="page-header">
    <div class="container">
      <h1 class="animate-in">Everything you need.<br><span class="gradient-text">Nothing you don't.</span></h1>
      <p class="animate-in animate-delay-1">Built for speed, designed for music lovers, engineered to stay out of your way.</p>
    </div>
  </section>

${featureSections}

  <!-- Bottom CTA -->
  <section class="bottom-cta">
    <div class="container reveal">
      <h2>Ready to try <span class="gradient-text">Viboplr</span>?</h2>
      <p>Free, fast, and built for music lovers.</p>
      <div class="hero-buttons">
        <a href="${DMG_URL}" class="btn btn-primary btn-lg">Download Now</a>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="container">
      <div class="footer-inner">
        <div class="footer-left">&copy; 2026 Viboplr. All rights reserved.</div>
        <div class="footer-right">
          <a href="https://github.com/${REPO}" class="footer-link" target="_blank" rel="noopener">GitHub</a>
          <span class="footer-link">Built with Tauri + React</span>
        </div>
      </div>
    </div>
  </footer>

  <script src="js/main.js"></script>
  <!-- Cloudflare Web Analytics -->
  <script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "cbb978698d3744cca00a24f8cac8bc3c"}'></script>
</body>
</html>
`;

  writeFileSync(resolve(docsDir, "features.html"), featuresHtml);
  console.log("✓ docs/features.html");
} else {
  console.error("⚠ docs/features.json not found — skipping features page generation");
}

// ---------------------------------------------------------------------------
// Step 5 — Git operations
// ---------------------------------------------------------------------------

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
  run("Pushing to origin...", "git push origin main --tags");
  console.log(`Done! Released v${version}.`);
} else {
  console.log(`\nFiles updated. To commit and tag manually:\n`);
  console.log(`  git add -A`);
  console.log(`  git commit -m "release: v${version}"`);
  console.log(`  git tag v${version}`);
  console.log(`  git push origin main --tags`);
  console.log(`\nOr re-run with --autocommit to do this automatically.`);
}
