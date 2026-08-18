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
  // Scoped to the docked bar deliberately. `SourceIndicator` is mounted by BOTH
  // playback bars (see ui.md — it is self-contained on purpose, because inside
  // DOM `:fullscreen` the browser paints only the fullscreened subtree, so a
  // panel hoisted to the app root would never appear over fullscreen video). The
  // fullscreen bar is in the DOM but `display: none` until fullscreen, so an
  // unscoped `.now-source-icon` matches two nodes and trips Playwright's strict
  // mode — even though exactly one is visible. Assert the one this test means.
  await expect(page.locator('.now-playing .now-source-icon')).toBeVisible();
});

test('track list renders all mock tracks including tidal', async ({ page }) => {
  const items = page.locator('.entity-list-item');
  await expect(items).toHaveCount(4);
});
