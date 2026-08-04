import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');

  // Wait for the app to finish restoring state (restore is async)
  // Then click Library to ensure we're on the right view
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Library' }).click();

  // Wait for track rows to appear (the mock returns test tracks)
  await page.locator('.entity-list-item').first().waitFor({ state: 'visible', timeout: 10000 });
});

test('tracks view renders mock tracks', async ({ page }) => {
  const rows = page.locator('.entity-list-item');
  await expect(rows).toHaveCount(4);
});

test.skip('double-clicking a track adds it to the queue and starts playback', async ({ page }) => {
  await page.locator('.entity-list-item').first().dblclick();

  const queueItems = page.locator('.queue-item');
  await expect(queueItems.first()).toBeVisible({ timeout: 10000 });

  await expect(queueItems.first().locator('.queue-item-title')).toContainText('First Song');
  await expect(queueItems.first().locator('.queue-item-artist')).toContainText('Artist A');
});

test('current track is highlighted in the queue', async ({ page }) => {
  await page.locator('.entity-list-item').first().dblclick();

  const currentItem = page.locator('.queue-item.queue-current');
  await expect(currentItem).toHaveCount(1);
  await expect(currentItem.locator('.queue-item-title')).toHaveText('First Song');
});

test('double-clicking another track replaces the queue', async ({ page }) => {
  // Play first track
  await page.locator('.entity-list-item').first().dblclick();
  await expect(page.locator('.queue-item')).toHaveCount(1);
  await expect(page.locator('.queue-item-title').first()).toHaveText('First Song');

  // Play third track — replaces the queue
  await page.locator('.entity-list-item').nth(2).dblclick();
  await expect(page.locator('.queue-item')).toHaveCount(1);
  await expect(page.locator('.queue-item-title').first()).toHaveText('Third Song');
});

test('queue header exposes the playlist options menu', async ({ page }) => {
  await page.locator('.entity-list-item').first().dblclick();
  await expect(page.locator('.queue-item')).toHaveCount(1);

  // "Clear playlist" used to be its own header button. Every queue-level action
  // now lives in one native OS menu behind this ⋯ trigger (showNativeMenu), and
  // native menus have no DOM — E2E drives the dev server, not a Tauri build, so
  // the menu items themselves are out of reach here (see testing.md). Assert the
  // trigger is present and that opening it doesn't throw; the clear behaviour
  // itself is not covered at this layer.
  const menuBtn = page.locator('.queue-header .queue-header-menu-btn');
  await expect(menuBtn).toBeVisible();
  await menuBtn.click();
  await expect(page.locator('.queue-item')).toHaveCount(1);
});

test('now playing bar updates when a track plays', async ({ page }) => {
  await page.locator('.entity-list-item').first().dblclick();

  await expect(page.locator('.now-title')).toContainText('First Song');
});

test('track url is stamped with file:// scheme', async ({ page }) => {
  // Double-click to play a track and add it to queue
  await page.locator('.entity-list-item').first().dblclick();
  await expect(page.locator('.queue-item')).toHaveCount(1);

  // The track's url should have been stamped (via stampUrl) with file:// scheme.
  // We can verify by checking the audio element's src — the mock convertFileSrc
  // returns a data URI, so if src is set the stamping + resolution chain worked.
  const audioSrc = await page.locator('audio').first().evaluate(el => el.src);
  expect(audioSrc).toContain('data:audio/wav');
});
