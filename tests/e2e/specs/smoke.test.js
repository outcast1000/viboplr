import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  // Inject the Tauri IPC mock before any app code runs
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  // Wait for the app to render
  await page.waitForSelector('.sidebar');
});

test('app launches and sidebar is visible', async ({ page }) => {
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('sidebar renders all navigation items', async ({ page }) => {
  const expected = ['Tracks', 'Artists', 'Albums', 'Tags', 'Liked', 'History', 'Collections'];

  for (const name of expected) {
    await expect(page.locator('.nav-btn-label', { hasText: name })).toBeVisible();
  }
});

test('switching views via sidebar navigation', async ({ page }) => {
  const artistsBtn = page.locator('.nav-btn').nth(1);
  await artistsBtn.click();
  await expect(artistsBtn).toHaveClass(/active/);

  const tracksBtn = page.locator('.nav-btn').nth(0);
  await tracksBtn.click();
  await expect(tracksBtn).toHaveClass(/active/);
});

test('central search bar accepts input', async ({ page }) => {
  const searchInput = page.locator('.central-search-container input');
  await expect(searchInput).toBeVisible();

  await searchInput.fill('test query');
  await expect(searchInput).toHaveValue('test query');
});

test('settings panel opens and closes', async ({ page }) => {
  await page.locator('.settings-btn').click();
  await expect(page.locator('.settings-overlay')).toBeVisible();
  await expect(page.locator('.settings-nav-item').first()).toBeVisible();

  await page.locator('.settings-close').click();
  await expect(page.locator('.settings-overlay')).not.toBeVisible();
});
