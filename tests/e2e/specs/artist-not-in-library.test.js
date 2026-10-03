// An artist with no library tracks gets its Top Songs as the page's track
// table — the same TrackList a library artist's All Tracks uses, every song a
// "Not in library" row — in a "Top Songs" tab placed first, sortable by column,
// with hero Play + Radio (Enqueue in the ⋯ menu) and a by-name like.
//
// "Artist A" is made to read as not-in-library by answering find_artist_by_name
// with null, and its Top Songs come from the real debug-only mock-info plugin
// (twelve invented songs for a non-library artist), loaded through the
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
    window.__likeWrites = [];
    window.__radioCalls = [];
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
      if (cmd === 'find_artist_by_name' && args && args.name === 'Artist A') return null;
      if (cmd === 'info_get_types_for_entity' && args && args.entity === 'artist') {
        return [['artist_top_tracks', 'Top Songs', 'ranked_list', 60, 0, [['mock-info', 1]], '']];
      }
      if (cmd === 'get_entity_like_state') return 0;
      if (cmd === 'set_entity_like_state') { window.__likeWrites.push(args); return null; }
      if (cmd === 'build_radio_station') { window.__radioCalls.push(args); return { seedInLibrary: false, tracks: [] }; }
      return base(cmd, args);
    };
  }, PLUGIN);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

async function openArtistA(page) {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.search-view .ds-tabs .ds-tab');
  await page.locator('.search-view .ds-tab', { hasText: 'Artists' }).click();
  await page.locator('.search-view .artist-card', { hasText: 'Artist A' }).click();
  await expect(page.locator('.detail-hero-title')).toHaveText('Artist A');
}

const rows = (page) => page.locator('.track-list .track-row--missing');
const header = (page, label) => page.locator('.track-header .col-header-label', { hasText: label }).first();

test('Top Songs render as the library table, first, and sort', async ({ page }) => {
  await setup(page);
  await openArtistA(page);
  await expect(page.locator('.detail-hero')).toContainText('Not in your library');

  // The table replaces the plugin's own Top Songs tab — one tab of that name,
  // first in the bar, holding the TrackList.
  const tabs = page.locator('.artist-detail .info-sections-tab');
  await expect(tabs.filter({ hasText: 'Top Songs' })).toHaveCount(1);
  await expect(tabs.first()).toContainText('Top Songs');
  await expect(rows(page)).toHaveCount(12);
  await expect(page.locator('.track-header')).toBeVisible();
  await expect(rows(page).locator('.track-missing-badge')).toHaveCount(12);

  // Twelve rows clears the filter threshold.
  await expect(page.locator('.detail-track-filter input')).toHaveAttribute('placeholder', 'Filter 12 tracks');

  const titleCells = rows(page).locator('.col-title-text');
  const rankOrder = await titleCells.allInnerTexts();
  await header(page, 'Title').click();
  await expect(titleCells).toHaveText([...rankOrder].sort((a, b) => a.localeCompare(b)));
});

test('the hero plays the Top Songs, starts a radio from one, and likes the artist by name', async ({ page }) => {
  await setup(page);
  await openArtistA(page);
  await expect(rows(page)).toHaveCount(12);

  const hero = page.locator('.detail-hero');
  await expect(hero.getByRole('button', { name: /^Play/ }).first()).toBeVisible();
  // Radio took Enqueue's place in the hero (Enqueue moved into the ⋯ menu).
  await expect(hero.getByRole('button', { name: /Enqueue/ })).toHaveCount(0);
  const topSongs = await rows(page).locator('.col-title-text').allInnerTexts();
  await hero.getByRole('button', { name: /Radio/ }).click();
  await expect.poll(() => page.evaluate(() => window.__radioCalls.length)).toBe(1);
  const radio = await page.evaluate(() => window.__radioCalls[0]);
  expect(radio.seedArtist).toBe('Artist A');
  expect(topSongs).toContain(radio.seedTitle);

  await hero.getByRole('button', { name: 'Rate artist' }).click();
  await expect(hero.getByRole('button', { name: 'Liked artist' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__likeWrites.length)).toBe(1);
  const write = await page.evaluate(() => window.__likeWrites[0]);
  expect(write.kind).toBe('artist');
  expect(write.likeState).toBe(1);
});
