#!/usr/bin/env node
// Fetches all GitHub releases and generates the history page content.
// Usage: node scripts/generate-history.mjs
// Requires: GITHUB_TOKEN env var (optional, increases rate limit)

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = 'outcast1000/viboplr';
const HISTORY_PATH = join(__dirname, '..', 'docs', 'history.html');
async function fetchAllReleases() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const releases = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.length === 0) break;
    releases.push(...data);
    page++;
  }

  return releases.filter(r => !r.draft).sort((a, b) =>
    new Date(b.published_at) - new Date(a.published_at)
  );
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToHtml(body) {
  if (!body) return '';
  const lines = body.trim().split('\n');
  const htmlParts = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { htmlParts.push('</ul>'); inList = false; }
      continue;
    }

    const listMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      if (!inList) { htmlParts.push('<ul>'); inList = true; }
      htmlParts.push(`<li>${escapeHtml(listMatch[1])}</li>`);
    } else if (trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
      if (inList) { htmlParts.push('</ul>'); inList = false; }
      // Skip headings that just repeat the version name
    } else {
      if (inList) { htmlParts.push('</ul>'); inList = false; }
      htmlParts.push(`<p>${escapeHtml(trimmed)}</p>`);
    }
  }
  if (inList) htmlParts.push('</ul>');

  return htmlParts.join('\n          ');
}

function formatDate(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function buildAssetLinks(assets) {
  const downloadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  return assets
    .filter(a => a.name.endsWith('.dmg') || a.name.endsWith('.msi'))
    .map(a => `<a href="${escapeHtml(a.browser_download_url)}" class="timeline-asset-link">${downloadIcon} ${escapeHtml(a.name)}</a>`)
    .join('\n            ');
}

function generateTimeline(releases) {
  if (releases.length === 0) {
    return '<div class="timeline-empty">No releases yet. Stay tuned!</div>';
  }

  return releases.map((r) => {
    const version = escapeHtml(r.tag_name);
    const name = r.name ? escapeHtml(r.name) : version;
    const date = formatDate(r.published_at);
    const body = markdownToHtml(r.body);
    const assets = buildAssetLinks(r.assets || []);
    const assetsHtml = assets
      ? `\n        <div class="timeline-assets">\n            ${assets}\n        </div>`
      : '';

    return `<div class="timeline-entry reveal">
        <div class="timeline-header">
          <span class="timeline-version">${name}</span>
          <span class="timeline-date">${date}</span>
        </div>
        <div class="timeline-body">
          ${body}
        </div>${assetsHtml}
      </div>`;
  }).join('\n      ');
}

async function main() {
  console.log('Fetching releases from GitHub...');
  const releases = await fetchAllReleases();
  console.log(`Found ${releases.length} release(s).`);

  const html = readFileSync(HISTORY_PATH, 'utf-8');
  const timelineHtml = generateTimeline(releases);

  const timelineOpen = '<div class="timeline" id="timeline">';
  const openIdx = html.indexOf(timelineOpen);
  if (openIdx === -1) {
    throw new Error('Could not find timeline container in history.html');
  }
  const contentStart = openIdx + timelineOpen.length;

  // Find matching closing </div> by counting nested divs
  let depth = 1;
  let i = contentStart;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) {
        i = nextClose;
      } else {
        i = nextClose + 6;
      }
    }
  }

  const newHtml =
    html.slice(0, contentStart) +
    '\n        ' + timelineHtml + '\n      ' +
    html.slice(i);

  writeFileSync(HISTORY_PATH, newHtml, 'utf-8');
  console.log('Updated docs/history.html');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
