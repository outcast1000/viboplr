// Album-artist support: a compilation is ONE album filed under "Various
// Artists" (an artist no track carries), the VA artist page shows library
// content but no external-metadata sections, and Collections offers the
// Full Rescan that converges pre-existing libraries.
//
// All of it runs against the opt-in VA fixtures in tauri-mock.js
// (`window.__E2E_VA__`) — several older specs hard-assert the base fixture
// counts, so the compilation must not leak into their runs.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

async function setup(page, storeSeed = {}) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((seed) => {
    window.__E2E_VA__ = true;
    window.__E2E_STORE_SEED__ = seed;
  }, storeSeed);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

// Match a collection card by its NAME element — a bare hasText on the card
// also matches incidental text (the server card's URL contains "music.").
function collectionCard(page, name) {
  return page.locator('.collections-view-card').filter({
    has: page.locator('.collections-view-card-name', { hasText: name }),
  });
}

async function openLibraryTab(page, tabName) {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.search-view .ds-tabs .ds-tab');
  await page.locator('.search-view .ds-tab', { hasText: tabName }).click();
}

test('a compilation is one album card, filed under Various Artists', async ({ page }) => {
  await setup(page);
  await openLibraryTab(page, 'Albums');

  // One card for the whole compilation — not one fork per track artist.
  const compCards = page.locator('.search-view .album-card', { hasText: 'Big Comp' });
  await expect(compCards).toHaveCount(1);
  await expect(compCards).toContainText('Various Artists');
});

test('Various Artists is a listed, navigable artist with zero tracks of its own', async ({ page }) => {
  await setup(page);
  await openLibraryTab(page, 'Artists');

  const vaCard = page.locator('.search-view .artist-card', { hasText: 'Various Artists' });
  await expect(vaCard).toHaveCount(1);
  await vaCard.click();
  await expect(page.locator('.detail-hero-title')).toHaveText('Various Artists');

  // It owns one album and performs on nothing, so the meta row names the album
  // and must not claim a track count — "0 tracks" is false about a row that is
  // only listed because it has an album with tracks in it.
  const meta = page.locator('.detail-hero-meta-row');
  await expect(meta).toContainText('1 album');
  await expect(meta).not.toContainText('tracks');
});

test('the VA artist page keeps library content but suppresses metadata sections', async ({ page }) => {
  await setup(page);

  // Control first: a real artist's page shows the mocked "About" info section.
  await openLibraryTab(page, 'Artists');
  await page.locator('.search-view .artist-card', { hasText: 'Artist A' }).click();
  await expect(page.locator('.detail-hero-title')).toHaveText('Artist A');
  await expect(page.locator('.info-sections-tab', { hasText: 'About' })).toBeVisible();

  // The VA page: same info type registered, but the collective gets no
  // external-metadata sections — only library-derived tabs (Albums).
  await openLibraryTab(page, 'Artists');
  await page.locator('.search-view .artist-card', { hasText: 'Various Artists' }).click();
  await expect(page.locator('.detail-hero-title')).toHaveText('Various Artists');
  await expect(page.locator('.info-sections-tab', { hasText: 'Albums' })).toBeVisible();
  await expect(page.locator('.info-sections-tab', { hasText: 'About' })).toHaveCount(0);
});

test('Full Rescan is offered on local collections only and sends full: true', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Collections' }).click();

  const localCard = collectionCard(page, 'Music');
  const serverCard = collectionCard(page, 'Server');
  await expect(localCard.getByRole('button', { name: 'Full Rescan' })).toBeVisible();
  await expect(serverCard.getByRole('button', { name: 'Full Rescan' })).toHaveCount(0);

  await localCard.getByRole('button', { name: 'Full Rescan' }).click();
  await expect
    .poll(() => page.evaluate(() => (window.__TEST_RESYNC_CALLS__ || []).at(-1)))
    .toEqual({ collectionId: 1, full: true });

  // The ordinary Resync stays incremental.
  await localCard.getByRole('button', { name: 'Resync', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window.__TEST_RESYNC_CALLS__ || []).at(-1)))
    .toEqual({ collectionId: 1, full: false });
});

test('the album-artist hint banner shows once and dismisses', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Collections' }).click();

  const hint = page.locator('.collections-view-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('Full Rescan');
  await hint.getByRole('button', { name: 'Dismiss' }).click();
  await expect(hint).toHaveCount(0);
});

test('a dismissed hint never comes back', async ({ page }) => {
  await setup(page, { albumArtistRescanHintDismissed: true });
  await page.getByRole('button', { name: 'Collections' }).click();

  // The cards render (the view is up), the hint does not.
  await expect(collectionCard(page, 'Music')).toBeVisible();
  await expect(page.locator('.collections-view-hint')).toHaveCount(0);
});
