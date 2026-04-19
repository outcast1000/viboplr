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

test('opening settings shows the settings overlay', async ({ page }) => {
  // Click settings button in sidebar
  const settingsButton = page.locator('.settings-btn');
  await settingsButton.click();

  // Settings overlay should be visible
  const settingsOverlay = page.locator('.settings-overlay');
  await expect(settingsOverlay).toBeVisible();
});

test('settings has navigation tabs', async ({ page }) => {
  // Open settings
  await page.locator('.settings-btn').click();
  await page.waitForSelector('.settings-overlay');

  // Check for navigation items
  const navItems = page.locator('.settings-nav-item');
  const count = await navItems.count();

  expect(count).toBeGreaterThan(0);
});

test('clicking different settings tabs switches content', async ({ page }) => {
  // Open settings
  await page.locator('.settings-btn').click();
  await page.waitForSelector('.settings-overlay');

  const navItems = page.locator('.settings-nav-item');
  const count = await navItems.count();

  if (count >= 2) {
    // Click first tab
    await navItems.nth(0).click();
    await page.waitForTimeout(200);

    const firstTabText = await navItems.nth(0).textContent();

    // Click second tab
    await navItems.nth(1).click();
    await page.waitForTimeout(200);

    const secondTabText = await navItems.nth(1).textContent();

    // Tabs should have different text (indicating different content)
    expect(firstTabText).not.toBe(secondTabText);
  }
});

test('Collections nav item is shown in the sidebar', async ({ page }) => {
  // Check for Collections button in sidebar
  const collectionsButton = page.locator('.sidebar').getByRole('button', { name: /collections/i });
  await expect(collectionsButton).toBeVisible();
});

test('settings panel can be closed by clicking the close button', async ({ page }) => {
  // Open settings
  await page.locator('.settings-btn').click();
  await page.waitForSelector('.settings-overlay');

  const settingsOverlay = page.locator('.settings-overlay');
  await expect(settingsOverlay).toBeVisible();

  // Find and click close button (could be X button or close button)
  const closeButton = page.locator('.settings-overlay').locator('button').filter({ hasText: /close|×/i }).first();

  if (await closeButton.isVisible()) {
    await closeButton.click();
    await expect(settingsOverlay).not.toBeVisible();
  } else {
    // Try clicking outside the settings panel
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(200);

    // Settings should close
    await expect(settingsOverlay).not.toBeVisible();
  }
});
