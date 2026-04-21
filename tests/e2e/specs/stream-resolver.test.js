import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Library' }).click();
  await page.locator('.entity-list-item').first().waitFor({ state: 'visible', timeout: 10000 });
});

test('local file plays and shows in now playing bar', async ({ page }) => {
  await page.locator('.entity-list-item').first().dblclick();
  await expect(page.locator('.now-title')).toContainText('First Song', { timeout: 10000 });
});

test('source icon appears for playing track', async ({ page }) => {
  await page.locator('.entity-list-item').first().dblclick();
  await expect(page.locator('.now-title')).toContainText('First Song', { timeout: 10000 });
  await expect(page.locator('.now-source-icon')).toBeVisible();
});

test('track list renders all mock tracks including tidal', async ({ page }) => {
  const items = page.locator('.entity-list-item');
  await expect(items).toHaveCount(4);
});
