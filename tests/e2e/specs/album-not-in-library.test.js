// An album that isn't in the library shows the provider's tracklist in the same
// TrackList table a library album uses — column header, # = album position,
// "Not in library" rows — and its column headers sort it.
//
// "Album X" is made to read as not-in-library by answering find_album_by_name
// with null, and its tracklist comes from the real debug-only mock-info plugin
// (ten invented tracks for a non-library album), loaded through the
// `__E2E_PLUGINS__` fixture with its one permission pre-approved.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');
const pluginDir = path.resolve(__dirname, '..', '..', '..', 'src-tauri', 'plugins', 'mock-info');

const PLUGIN = {
  id: 'mock-info',
  manifest: JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')),
  code: fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8'),
};

async function setup(page) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((plugin) => {
    window.__E2E_PLUGINS__ = [plugin];
    window.__E2E_STORE_SEED__ = {
      enabledPlugins: [plugin.id],
      onboardingComplete: true,
      debugMode: true,
      pluginPermissionGrants: { [plugin.id]: plugin.manifest.permissions },
    };
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
      if (cmd === 'find_album_by_name' && args && args.title === 'Album X') return null;
      if (cmd === 'info_get_types_for_entity' && args && args.entity === 'album') {
        return [['album_track_popularity', 'Track Popularity', 'ranked_list', 60, 0, [['mock-info', 1]], '']];
      }
      return base(cmd, args);
    };
  }, PLUGIN);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

async function openAlbumX(page) {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.search-view .ds-tabs .ds-tab');
  await page.locator('.search-view .ds-tab', { hasText: 'Albums' }).click();
  await page.locator('.search-view .album-card', { hasText: 'Album X' }).click();
  await expect(page.locator('.detail-hero-title')).toHaveText('Album X');
}

const rows = (page) => page.locator('.track-list .track-row--missing');
const nums = (page) => rows(page).locator('.col-num');
const header = (page, label) => page.locator('.track-header .col-header-label', { hasText: label }).first();
const ONE_TO_TEN = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

test('the provider tracklist renders as the library table, and sorts', async ({ page }) => {
  await setup(page);
  await openAlbumX(page);
  await expect(page.locator('.detail-hero')).toContainText('Not in your library');

  // Same table as a library album: a column header and ten rows numbered by
  // album position, each carrying the "Not in library" badge.
  await expect(rows(page)).toHaveCount(10);
  await expect(page.locator('.track-header')).toBeVisible();
  await expect(nums(page)).toHaveText(ONE_TO_TEN);
  await expect(rows(page).locator('.track-missing-badge')).toHaveCount(10);

  // Clicking # sorts by album position, ascending first, then flips.
  await header(page, '#').click();
  await expect(nums(page)).toHaveText(ONE_TO_TEN);
  await header(page, '#').click();
  await expect(nums(page)).toHaveText([...ONE_TO_TEN].reverse());

  // Title sorts alphabetically (and # no longer runs in order).
  const titleCells = rows(page).locator('.col-title-text');
  const before = await titleCells.allInnerTexts(); // read while still sorted by # desc
  await header(page, 'Title').click();
  await expect(titleCells).toHaveText([...before].sort((a, b) => a.localeCompare(b)));
});
