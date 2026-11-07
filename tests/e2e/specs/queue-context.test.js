import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  // Default landing view is now "home"; navigate to Library so existing
  // tests that rely on .search-view-input continue to work.
  await page.locator('.nav .nav-btn').filter({ hasText: 'Library' }).click();
  await page.waitForTimeout(500);
});

test('no context banner when no tracks are playing', async ({ page }) => {
  await expect(page.locator('.queue-context-banner')).not.toBeVisible();
});

test('album play from search shows context banner with artist and album name', async ({ page }) => {
  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);

  await page.locator('button').filter({ hasText: /^Albums/ }).first().click();
  await page.waitForTimeout(500);

  await expect(page.locator('.album-card')).toHaveCount(2);

  // Hover to reveal play button, then click
  const firstCard = page.locator('.album-card').first();
  await firstCard.hover();
  await firstCard.locator('.ds-card-play').click({ force: true });

  await expect(page.locator('.queue-context-banner')).toBeVisible({ timeout: 5000 });
  // An album reads "Artist – Album" (playlistContextTitle, mainPlaylist.ts).
  await expect(page.locator('.queue-context-name')).toHaveText('Artist A – Album X');
});

test('artist play from search shows context banner with artist name', async ({ page }) => {
  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);

  await page.locator('button').filter({ hasText: /^Artists/ }).first().click();
  await page.waitForTimeout(500);

  await expect(page.locator('.artist-card')).toHaveCount(2);

  const firstCard = page.locator('.artist-card').first();
  await firstCard.hover();
  await firstCard.locator('.ds-card-play').click({ force: true });

  await expect(page.locator('.queue-context-banner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.queue-context-name')).toHaveText('Artist A');
});

test('album detail Play All shows context banner', async ({ page }) => {
  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);

  await page.locator('button').filter({ hasText: /^Albums/ }).first().click();
  await page.waitForTimeout(500);

  // Navigate to album detail. The card's art area is the navigation affordance;
  // clicking the body multi-selects instead.
  await page.locator('.album-card .album-card-art-wrapper').first().click();
  await page.waitForTimeout(1000);

  // Click Play in the shared DetailHero (the old .detail-art-play button is now
  // the hero's primary action button).
  await page.locator('.detail-hero-actions .ds-btn--primary').click({ force: true });

  await expect(page.locator('.queue-context-banner')).toBeVisible({ timeout: 5000 });
  // An album reads "Artist – Album" (playlistContextTitle, mainPlaylist.ts).
  await expect(page.locator('.queue-context-name')).toHaveText('Artist A – Album X');
});

test('single track double-click does not show context banner', async ({ page }) => {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.locator('.entity-list-item').first().waitFor({ state: 'visible', timeout: 10000 });

  await page.locator('.entity-list-item').first().dblclick();
  await page.waitForTimeout(1000);

  // Single track play should not produce a context banner
  await expect(page.locator('.queue-context-banner')).not.toBeVisible();
});

// Queue history (queue.md "Queue History"): a play that replaces the queue
// can be undone with Back, which puts the old queue back with its banner, and
// Forward returns. There is no Clear any more — this is how a queue is undone.
test('queue Back / Forward step between replaced queues', async ({ page }) => {
  const back = page.locator('.queue-header [aria-label^="Back"]');
  const forward = page.locator('.queue-header [aria-label^="Forward"]');
  // Nothing played yet: no history, and the buttons are disabled, not hidden.
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);
  await page.locator('button').filter({ hasText: /^Albums/ }).first().click();
  await page.waitForTimeout(500);
  const firstCard = page.locator('.album-card').first();
  await firstCard.hover();
  await firstCard.locator('.ds-card-play').click({ force: true });
  const banner = page.locator('.queue-context-banner');
  await expect(banner).toBeVisible({ timeout: 5000 });
  const albumName = (await banner.locator('.queue-context-name').textContent())?.trim();

  // A single-track play replaces the album queue (no banner).
  await page.locator('button').filter({ hasText: /^Tracks/ }).first().click();
  await page.locator('.entity-list-item').first().dblclick();
  await expect(banner).not.toBeVisible({ timeout: 5000 });

  // The button names the card it goes to (the album's Latest play name).
  await expect(back).toBeEnabled({ timeout: 5000 });
  await expect(back).toHaveAttribute('aria-label', /^Back to Album X/);
  await back.click({ force: true });
  await expect(banner).toBeVisible({ timeout: 5000 });
  await expect(banner.locator('.queue-context-name')).toHaveText(albumName ?? '');

  await expect(forward).toBeEnabled({ timeout: 5000 });
  await forward.click({ force: true });
  await expect(banner).not.toBeVisible({ timeout: 5000 });
});
