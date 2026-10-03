// The local filter on a detail page's track list: shown only once the list has
// more than 10 rows, case/accent-insensitive, and cleared on leaving the page.
//
// The base fixture gives Artist A two tracks, below the threshold, so this spec
// wraps the mock's invoke to hand the artist page a bigger list — without
// changing the shared fixtures other specs assert counts on.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

async function setup(page, trackCount) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((count) => {
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
      if (cmd === 'get_tracks_by_artist' && args && args.artistId === 1) {
        return Array.from({ length: count }, (_, i) => ({
          id: 1000 + i, path: `file:///music/Artist A/Album X/${i}.flac`,
          title: i === 0 ? 'Jóga' : i % 3 === 0 ? `Song ${i} (Live)` : `Song ${i}`,
          artist_id: 1, artist_name: 'Artist A', album_id: 1, album_title: 'Album X',
          year: 2020, track_number: i + 1, duration_secs: 200, format: 'flac', file_size: 1000,
          collection_id: 1, collection_name: 'Music', liked: 0, added_at: 1700000000, modified_at: 1700000000,
        }));
      }
      return base(cmd, args);
    };
  }, trackCount);
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

const rows = (page) => page.locator('.track-list [role="option"]');
const filterInput = (page) => page.locator('.detail-track-filter input');

test('no filter box at 10 tracks or fewer', async ({ page }) => {
  await setup(page, 10);
  await openArtistA(page);
  await expect(rows(page)).toHaveCount(10);
  await expect(filterInput(page)).toHaveCount(0);
});

test('filters the artist track list, accent-insensitively, and clears on Escape', async ({ page }) => {
  await setup(page, 14);
  await openArtistA(page);
  await expect(rows(page)).toHaveCount(14);
  await expect(filterInput(page)).toHaveAttribute('placeholder', 'Filter 14 tracks');

  await filterInput(page).fill('live');
  await expect(rows(page)).toHaveCount(4); // 3, 6, 9, 12
  await expect(page.locator('.detail-track-filter-count')).toHaveText('4 of 14');

  await filterInput(page).fill('JOGA');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Jóga');

  await filterInput(page).fill('nothing like this');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('.track-list')).toContainText('No tracks match the filter.');

  await filterInput(page).press('Escape');
  await expect(rows(page)).toHaveCount(14);
});

test('the filter does not follow you to the next page', async ({ page }) => {
  await setup(page, 14);
  await openArtistA(page);
  await filterInput(page).fill('live');
  await expect(rows(page)).toHaveCount(4);

  await page.locator('.detail-hero').getByRole('button', { name: /back/i }).click();
  await openArtistA(page);
  await expect(filterInput(page)).toHaveValue('');
  await expect(rows(page)).toHaveCount(14);
});
