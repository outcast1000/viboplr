// E2E coverage for the SearchView refactor (split into search/SearchEntityResults
// + search/searchShared). Verifies the extracted per-tab renderers and shared
// SortButton/LoadMoreSentinel still mount and behave through the real webview.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  // Land on the Library (SearchView) — startup view is Home.
  await page.locator('.sidebar .nav-btn-label', { hasText: 'Library' }).click();
  await page.waitForSelector('.search-view');
  // doSearch("") runs on mount, so the result tabs render without typing.
  await page.waitForSelector('.search-view .ds-tabs .ds-tab');
});

test('library tabs render (tracks/albums/artists/tags)', async ({ page }) => {
  const tabs = page.locator('.search-view .ds-tabs .ds-tab');
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toContainText('Tracks');
});

test('tracks tab shows track rows and the sort bar (SortButton)', async ({ page }) => {
  // Tracks is the default active tab; default tracks view mode is "list",
  // which renders rows as .entity-list-item.
  await expect(page.locator('.search-view .entity-list-item').first()).toBeVisible();
  // Reveal the sort bar (collapsed by default) and confirm SortButton renders.
  await page.locator('.sort-bar-toggle').click();
  await expect(page.locator('.sort-bar .sort-btn', { hasText: 'Title' }).first()).toBeVisible();
});

test('albums tab renders extracted SearchAlbumResults', async ({ page }) => {
  await page.locator('.search-view .ds-tab', { hasText: 'Albums' }).click();
  // tiles view -> entity-grid with album cards from TEST_ALBUMS (2 items)
  await expect(page.locator('.search-view .entity-grid').first()).toBeVisible();
  await expect(page.locator('.search-view .album-card')).toHaveCount(2);
  await expect(page.locator('.search-view').getByText('Album X')).toBeVisible();
});

test('artists tab renders extracted SearchArtistResults', async ({ page }) => {
  await page.locator('.search-view .ds-tab', { hasText: 'Artists' }).click();
  await expect(page.locator('.search-view .artist-card')).toHaveCount(2);
  await expect(page.locator('.search-view').getByText('Artist A')).toBeVisible();
});

test('switching tabs swaps the rendered entity component without errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.locator('.search-view .ds-tab', { hasText: 'Albums' }).click();
  await expect(page.locator('.search-view .album-card').first()).toBeVisible();

  await page.locator('.search-view .ds-tab', { hasText: 'Artists' }).click();
  await expect(page.locator('.search-view .artist-card').first()).toBeVisible();
  await expect(page.locator('.search-view .album-card')).toHaveCount(0);

  await page.locator('.search-view .ds-tab', { hasText: 'Tracks' }).click();
  await expect(page.locator('.search-view .entity-list-item').first()).toBeVisible();

  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});
