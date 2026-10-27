import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
});

test('Home is the first sidebar item and renders the home view', async ({ page }) => {
  const home = page.locator('.nav .nav-btn').filter({ hasText: 'Home' });
  await expect(home).toBeVisible();

  const firstBtn = page.locator('.nav .nav-btn').first();
  await expect(firstBtn).toContainText('Home');

  await home.click();

  await expect(page.locator('.home-view')).toBeVisible();
  await expect(page.locator('.home-view-header button').filter({ hasText: 'Refresh' })).toBeVisible();
  await expect(page.locator('.home-view-header button').filter({ hasText: 'Customize' })).toBeVisible();
});

test('Latest play shows a new play without a Home refresh', async ({ page }) => {
  // The shelf follows the live list (useHome's `recentPlays` effect), not the
  // 24h refresh — a cached copy named snapshot files a later play had deleted.
  await page.locator('.nav .nav-btn').filter({ hasText: 'Home' }).click();
  await expect(page.locator('.home-view')).toBeVisible();
  const latestPlay = page.locator('.home-shelf').filter({ has: page.locator('.home-shelf-title', { hasText: 'Latest play' }) });
  await expect(latestPlay).toHaveCount(0);

  // Play one track from the Library (lists render once a query has run, and
  // `.track-row` exists only in Table view — as in audio-fullscreen.test.js).
  await page.locator('.nav .nav-btn').filter({ hasText: 'Library' }).click();
  await page.locator('.search-view-input').fill('a');
  await page.locator('.ds-tab', { hasText: 'Tracks' }).first().click();
  const tableBtn = page.locator('button[title="Table view"]');
  if (await tableBtn.isVisible().catch(() => false)) await tableBtn.click();
  await page.locator('.track-row', { hasText: 'First Song' }).first().locator('.col-title').dblclick();

  await page.locator('.nav .nav-btn').filter({ hasText: 'Home' }).click();
  await expect(latestPlay.locator('.home-shelf-card .ds-card-title')).toHaveText(['First Song'], { timeout: 5000 });
});

test('Customize opens the shelf modal, and shelves render behind it', async ({ page }) => {
  // Shelf visibility/order used to be a native OS menu that Playwright couldn't
  // inspect. It is now CustomizeHomeModal — a real DOM modal — so assert its
  // contents rather than just that the trigger doesn't throw.
  await page.locator('.nav .nav-btn').filter({ hasText: 'Home' }).click();
  await expect(page.locator('.home-view')).toBeVisible();

  const customizeBtn = page.locator('.home-view-header button').filter({ hasText: 'Customize' });
  await expect(customizeBtn).toBeVisible();
  await customizeBtn.click();

  const modal = page.locator('.customize-home-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.ds-modal-title')).toHaveText('Customize Home');
  // One row per registered shelf, each with a visibility toggle.
  expect(await modal.locator('.customize-home-row').count()).toBeGreaterThan(0);
  await expect(modal.locator('.customize-home-row .ds-toggle').first()).toBeVisible();

  // Per the modal-dismiss convention, only the explicit action closes it.
  await modal.locator('button').filter({ hasText: 'Done' }).click();
  await expect(modal).not.toBeVisible();

  // At least one built-in shelf renders its title.
  await expect(page.locator('.home-shelf').first()).toBeVisible({ timeout: 5000 });
});
