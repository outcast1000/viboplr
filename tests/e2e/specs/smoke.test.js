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
  const expected = ['Library', 'History', 'Playlists', 'Collections', 'Extensions', 'Settings'];

  for (const name of expected) {
    await expect(page.locator('.nav-btn-label', { hasText: name })).toBeVisible();
  }
});

test.skip('switching views via sidebar navigation', async ({ page }) => {
  await page.waitForTimeout(500);

  // Click History in the sidebar
  await page.locator('.sidebar .nav-btn-label', { hasText: 'History' }).click();
  await page.waitForTimeout(300);
  // Verify the History button is now active
  const historyBtn = page.locator('.sidebar .nav-btn:has(.nav-btn-label:text("History"))');
  await expect(historyBtn).toHaveClass(/active/, { timeout: 5000 });

  // Switch back to Library
  await page.locator('.sidebar .nav-btn-label', { hasText: 'Library' }).click();
  await page.waitForTimeout(300);
  const libraryBtn = page.locator('.sidebar .nav-btn:has(.nav-btn-label:text("Library"))');
  await expect(libraryBtn).toHaveClass(/active/, { timeout: 5000 });
});

test('central search bar accepts input', async ({ page }) => {
  const searchInput = page.locator('.central-search-container input');
  await expect(searchInput).toBeVisible();

  await searchInput.fill('test query');
  await expect(searchInput).toHaveValue('test query');
});

test('settings view opens via sidebar', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-view')).toBeVisible();

  // Navigate away closes settings
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.locator('.settings-view')).not.toBeVisible();
});
