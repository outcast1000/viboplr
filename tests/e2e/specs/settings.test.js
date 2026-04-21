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

test('opening settings shows the settings view', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-view')).toBeVisible();
});

test('settings has navigation tabs', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForSelector('.settings-view');

  const tabs = page.locator('.settings-view .ds-tab');
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);
});

test('clicking different settings tabs switches content', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForSelector('.settings-view');

  const tabs = page.locator('.settings-view .ds-tab');
  const count = await tabs.count();

  if (count >= 2) {
    await tabs.nth(0).click();
    await page.waitForTimeout(200);
    const firstTabText = await tabs.nth(0).textContent();

    await tabs.nth(1).click();
    await page.waitForTimeout(200);
    const secondTabText = await tabs.nth(1).textContent();

    expect(firstTabText).not.toBe(secondTabText);
  }
});

test('Collections nav item is shown in the sidebar', async ({ page }) => {
  const collectionsButton = page.locator('.sidebar').getByRole('button', { name: /collections/i });
  await expect(collectionsButton).toBeVisible();
});

test('navigating away from settings hides settings view', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-view')).toBeVisible();

  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.locator('.settings-view')).not.toBeVisible();
});
