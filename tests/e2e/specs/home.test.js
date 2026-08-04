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

  // At least one built-in shelf renders its title (Recently played is fed by
  // get_history_recent, which the mock returns).
  await expect(page.locator('.home-shelf').first()).toBeVisible({ timeout: 5000 });
});
