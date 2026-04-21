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

test('right-clicking a track row shows context menu', async ({ page }) => {
  await page.locator('.entity-list-item').first().click({ button: 'right' });

  const contextMenu = page.locator('.context-menu');
  await expect(contextMenu).toBeVisible();
});

test('context menu has core track actions', async ({ page }) => {
  await page.locator('.entity-list-item').first().click({ button: 'right' });

  await page.waitForSelector('.context-menu');

  const playAction = page.locator('.context-menu-item', { hasText: 'Play' }).first();
  const enqueueAction = page.locator('.context-menu-item', { hasText: 'Enqueue' });

  await expect(playAction).toBeVisible();
  await expect(enqueueAction).toBeVisible();
});

test('clicking outside context menu closes it', async ({ page }) => {
  await page.locator('.entity-list-item').first().click({ button: 'right' });

  const contextMenu = page.locator('.context-menu');
  await expect(contextMenu).toBeVisible();

  // Click somewhere else in the app
  await page.locator('.main').click({ position: { x: 100, y: 100 } });

  await expect(contextMenu).not.toBeVisible();
});

test('context menu is positioned within viewport bounds', async ({ page }) => {
  await page.locator('.entity-list-item').first().click({ button: 'right' });

  const contextMenu = page.locator('.context-menu');
  await expect(contextMenu).toBeVisible();

  const bbox = await contextMenu.boundingBox();
  const viewport = page.viewportSize();

  // Verify context menu is within viewport
  expect(bbox.x).toBeGreaterThanOrEqual(0);
  expect(bbox.y).toBeGreaterThanOrEqual(0);
  expect(bbox.x + bbox.width).toBeLessThanOrEqual(viewport.width);
  expect(bbox.y + bbox.height).toBeLessThanOrEqual(viewport.height);
});
