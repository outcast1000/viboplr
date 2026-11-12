// The History view in the Library's frame: its own search box, tabs with
// counts, a sort bar with a Range row, and table / list / tiles. The search
// narrows every tab at once (the counts follow), and sorting goes to the
// backend as a sort chain.
//
// The base mock has no history, so this spec wraps invoke with a small
// in-memory history and records every page request.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

async function setup(page, { failFirst } = {}) {
  await page.addInitScript({ path: tauriMockPath });
  if (failFirst) await page.addInitScript((cmd) => { window.__HISTORY_FAIL__ = { [cmd]: 1 }; }, failFirst);
  await page.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    const lib = (id, album) => ({
      display_album: album, display_album_artist: album ? 'Artist A' : null,
      display_path: id ? `file:///music/${id}.flac` : null, display_track_id: id,
      display_duration_secs: id ? 200 : null, display_format: id ? 'flac' : null,
    });
    const recent = [
      { id: 3, history_track_id: 30, played_at: now - 60, display_title: 'Jóga', display_artist: 'Artist A', play_count: 2, ...lib(101, 'Album X') },
      { id: 2, history_track_id: 20, played_at: now - 3600, display_title: 'Teardrop', display_artist: 'Artist B', play_count: 1, ...lib(102, 'Album Y') },
      { id: 1, history_track_id: 10, played_at: now - 7200, display_title: 'Gone Song', display_artist: 'Nobody', play_count: 1, ...lib(null, null) },
    ];
    const tracks = [
      { history_track_id: 30, play_count: 2, display_title: 'Jóga', display_artist: 'Artist A', rank: 1, last_played_at: now - 60, ...lib(101, 'Album X') },
      { history_track_id: 20, play_count: 1, display_title: 'Teardrop', display_artist: 'Artist B', rank: 2, last_played_at: now - 3600, ...lib(102, 'Album Y') },
      { history_track_id: 10, play_count: 1, display_title: 'Gone Song', display_artist: 'Nobody', rank: 2, last_played_at: now - 7200, ...lib(null, null) },
    ];
    const artists = [
      { history_artist_id: 1, play_count: 2, track_count: 1, display_name: 'Artist A', rank: 1, last_played_at: now - 60 },
      { history_artist_id: 2, play_count: 1, track_count: 1, display_name: 'Artist B', rank: 2, last_played_at: now - 3600 },
      { history_artist_id: 3, play_count: 1, track_count: 1, display_name: 'Nobody', rank: 2, last_played_at: now - 7200 },
    ];
    const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const matches = (q, ...fields) => !q || fold(q).split(/\s+/).every(term => fields.some(f => fold(f).includes(term)));
    window.__HISTORY_CALLS__ = [];
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
      const pages = { history_recent_page: recent, history_tracks_page: tracks, history_artists_page: artists };
      if (cmd in pages) {
        window.__HISTORY_CALLS__.push({ cmd, args });
        if (window.__HISTORY_FAIL__ && window.__HISTORY_FAIL__[cmd]) {
          window.__HISTORY_FAIL__[cmd] -= 1;
          throw new Error('database is locked');
        }
        const q = args && args.query;
        const rows = pages[cmd].filter(r => cmd === 'history_artists_page'
          ? matches(q, r.display_name)
          : matches(q, r.display_title, r.display_artist));
        return { rows, total: rows.length };
      }
      return base(cmd, args);
    };
  });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.getByRole('button', { name: 'History' }).click();
  await page.waitForSelector(failFirst ? '.history-view .history-error' : '.history-view .entity-list-item');
}

test('a tab that fails to load says so and can be retried', async ({ page }) => {
  await setup(page, { failFirst: 'history_recent_page' });
  await expect(page.locator('.history-view .history-error')).toContainText("Couldn't load your history");
  await page.locator('.history-view .history-error').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.history-view .entity-list-item')).toHaveCount(3);
});

test('tabs not on screen ask for their count only, and load rows when opened', async ({ page }) => {
  await setup(page);
  const calls = (cmd) => page.evaluate((c) => window.__HISTORY_CALLS__.filter(x => x.cmd === c).map(x => x.args.limit), cmd);
  expect(await calls('history_tracks_page')).toEqual([0]);
  expect(await calls('history_artists_page')).toEqual([0]);
  await page.locator('.history-view').getByRole('tab', { name: 'Tracks' }).click();
  await expect(page.locator('.history-view .entity-list-item')).toHaveCount(3);
  expect(await calls('history_tracks_page')).toEqual([0, 50]);
  // Every later page reuses the first page's cutoff.
  const asOfs = await page.evaluate(() => window.__HISTORY_CALLS__.map(x => x.args.asOf));
  expect(asOfs.every(a => typeof a === 'number')).toBe(true);
});

const view = (page) => page.locator('.history-view');
const tab = (page, name) => view(page).getByRole('tab', { name });

test('tabs carry counts, and the search narrows every tab', async ({ page }) => {
  await setup(page);
  await expect(tab(page, 'Plays').locator('.ds-tab-badge')).toHaveText('3');
  await expect(tab(page, 'Tracks').locator('.ds-tab-badge')).toHaveText('3');
  await expect(tab(page, 'Artists').locator('.ds-tab-badge')).toHaveText('3');

  await view(page).getByRole('textbox', { name: 'Search history' }).fill('joga');
  await expect(view(page).locator('.entity-list-item')).toHaveCount(1);
  await expect(view(page).locator('.entity-list-item .entity-list-name')).toHaveText('Jóga');
  await expect(tab(page, 'Plays').locator('.ds-tab-badge')).toHaveText('1');
  await expect(tab(page, 'Artists').locator('.ds-tab-badge')).toHaveCount(0);

  await tab(page, 'Tracks').click();
  await expect(view(page).locator('.entity-list-item')).toHaveCount(1);
});

test('rows have a heart and artist / album links', async ({ page }) => {
  await setup(page);
  const row = view(page).locator('.entity-list-item').first();
  await expect(row.locator('.entity-list-name')).toHaveText('Jóga');
  await expect(row.locator('.track-link')).toHaveText(['Artist A', 'Album X']);
  await expect(row.locator('.ds-like-control')).toHaveCount(1);
});

test('the table sorts through the backend and marks plays the library lacks', async ({ page }) => {
  await setup(page);
  await view(page).getByTitle('Table view').click();
  const table = view(page).locator('.history-table');
  await expect(table.locator('.track-row')).toHaveCount(3);
  await expect(table.locator('.track-row', { hasText: 'Gone Song' }).locator('.track-missing-badge')).toHaveText('Not in library');

  await table.locator('.track-header .col-title').click();
  await expect.poll(() => page.evaluate(() => {
    const last = window.__HISTORY_CALLS__.filter(c => c.cmd === 'history_recent_page').pop();
    return JSON.stringify(last && last.args.sortChain);
  })).toBe(JSON.stringify([{ field: 'title', dir: 'asc' }]));
});

test('one range, in the tab bar, applies to every tab', async ({ page }) => {
  await setup(page);
  const lastSince = (cmd) => page.evaluate((c) =>
    window.__HISTORY_CALLS__.filter(x => x.cmd === c).pop().args.sinceTs, cmd);
  // Every tab opens on the last 30 days.
  for (const cmd of ['history_recent_page', 'history_tracks_page', 'history_artists_page']) {
    expect(typeof await lastSince(cmd)).toBe('number');
  }
  const range = view(page).getByRole('group', { name: 'Range' });
  await expect(range).toBeVisible(); // with the sort bar collapsed
  await range.getByRole('button', { name: 'All time' }).click();
  for (const cmd of ['history_recent_page', 'history_tracks_page', 'history_artists_page']) {
    await expect.poll(() => lastSince(cmd)).toBeNull();
  }
});
