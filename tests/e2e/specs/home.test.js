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

test('shelf visibility toggle hides shelves in the same session', async ({ page }) => {
  await page.locator('.nav .nav-btn').filter({ hasText: 'Home' }).click();
  await expect(page.locator('.home-view')).toBeVisible();

  // Open shelves popover
  await page.locator('.home-view-header button', { hasText: 'Shelves' }).click();
  const popover = page.locator('.home-shelves-popover');
  await expect(popover).toBeVisible();

  // All built-in shelves listed
  for (const title of [
    'Recently played',
    'Most played · 30 days',
    'Most played artists · 30 days',
    'Recently added',
    'Liked albums',
    'Liked artists',
    'Jump back in',
  ]) {
    await expect(popover.locator('.home-shelves-popover-row', { hasText: title })).toBeVisible();
  }

  // Uncheck "Recently played"
  const recentlyPlayed = popover
    .locator('.home-shelves-popover-row', { hasText: 'Recently played' })
    .locator('input');
  await recentlyPlayed.uncheck();
  await expect(recentlyPlayed).not.toBeChecked();

  // Close popover
  await page.locator('.home-shelves-popover-backdrop').click();
  await expect(popover).not.toBeVisible();

  // Re-open and confirm the unchecked state survived within this session
  await page.locator('.home-view-header button', { hasText: 'Shelves' }).click();
  const recentlyPlayed2 = page
    .locator('.home-shelves-popover-row', { hasText: 'Recently played' })
    .locator('input');
  await expect(recentlyPlayed2).not.toBeChecked();
});
