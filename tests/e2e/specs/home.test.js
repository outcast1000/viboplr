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
  await expect(page.locator('.home-view-header button', { hasText: 'Refresh' })).toBeVisible();
  await expect(page.locator('.home-view-header button', { hasText: 'Shelves' })).toBeVisible();
});

test('shelf visibility menu opens without error and shelves render', async ({ page }) => {
  // The shelf-visibility picker is now a native OS menu (showNativeMenu), not a
  // DOM popover — Playwright can't inspect native menus, so we assert the
  // trigger is present and clickable and that the Home shelves render. The
  // visibility-toggle logic itself is covered by unit tests, not E2E.
  await page.locator('.nav .nav-btn').filter({ hasText: 'Home' }).click();
  await expect(page.locator('.home-view')).toBeVisible();

  const shelvesBtn = page.locator('.home-view-header button', { hasText: 'Shelves' });
  await expect(shelvesBtn).toBeVisible();
  // Clicking opens a native menu (no DOM to assert); just confirm it doesn't throw.
  await shelvesBtn.click();

  // At least one built-in shelf renders its title (Recently played is fed by
  // get_history_recent, which the mock returns).
  await expect(page.locator('.home-shelf').first()).toBeVisible({ timeout: 5000 });
});
