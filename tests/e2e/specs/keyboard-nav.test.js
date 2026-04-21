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

test('pressing Cmd+K focuses the central search input', async ({ page }) => {
  await page.keyboard.press('Meta+k');

  const searchInput = page.locator('.central-search-container input');
  await expect(searchInput).toBeFocused();
});

test('typing in search and pressing Escape clears the input', async ({ page }) => {
  const searchInput = page.locator('.central-search-container input');
  await searchInput.click();
  await searchInput.fill('test');
  await expect(searchInput).toHaveValue('test');

  await page.keyboard.press('Escape');
  await expect(searchInput).toHaveValue('');
});
