// The Now Playing About panel: song / artist / album prose behind one corner
// button, taking the lyrics column's place rather than adding clutter.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

/** Same route in as audio-fullscreen.test.js: play a library track, then open
 *  Now Playing. `withInfo` turns on the cached artist-bio fixture. */
async function setupNowPlaying(page, { withInfo }) {
  await page.addInitScript({ path: tauriMockPath });
  if (withInfo) await page.addInitScript(() => { window.__E2E_INFO__ = true; });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.locator('.nav .nav-btn').filter({ hasText: 'Library' }).click();
  await page.waitForTimeout(500);

  await page.locator('.search-view-input').fill('a');
  await page.waitForTimeout(700);
  await page.locator('.ds-tab', { hasText: 'Tracks' }).first().click();
  await page.waitForTimeout(400);
  const tableBtn = page.locator('button[title="Table view"]');
  if (await tableBtn.isVisible().catch(() => false)) {
    await tableBtn.click();
    await page.waitForTimeout(300);
  }

  await page.locator('.track-row').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.track-row .col-title').first().dblclick();
  await page.waitForTimeout(500);

  const cancelDupe = page.locator('.queue-duplicate-actions button', { hasText: 'Cancel' });
  if (await cancelDupe.isVisible().catch(() => false)) {
    await cancelDupe.click();
    await page.waitForTimeout(200);
  }

  await page.locator('.nav .nav-btn').filter({ hasText: 'Now Playing' }).click();
  await page.locator('.now-playing-view').waitFor({ state: 'visible', timeout: 10000 });
}

test('the About button opens the artist bio in the side column, and closes it again', async ({ page }) => {
  await setupNowPlaying(page, { withInfo: true });
  const view = page.locator('.now-playing-view');

  // Closed by default: a lean-back surface opens on the art, not on text.
  await expect(view.locator('.np-about')).toHaveCount(0);

  const btn = view.locator('.np-action-btn[aria-label="About this track"]');
  await btn.click();
  await expect(view.locator('.np-about-scroll')).toContainText('Mock artist bio');
  await expect(view.locator('.np-action-btn[aria-label="Hide info"]')).toHaveAttribute('aria-pressed', 'true');
  // It fills the side column, so the layout is the two-column one.
  await expect(view).not.toHaveClass(/np-audio--nolyrics/);
  // One text → no tab row; the tab word would just restate the only thing there.
  await expect(view.locator('.np-about-tabs')).toHaveCount(0);

  await view.locator('.np-action-btn[aria-label="Hide info"]').click();
  await expect(view.locator('.np-about')).toHaveCount(0);
});

test('with nothing to read the panel says so instead of staying blank', async ({ page }) => {
  await setupNowPlaying(page, { withInfo: false });
  const view = page.locator('.now-playing-view');
  await view.locator('.np-action-btn[aria-label="About this track"]').click();
  await expect(view.locator('.np-about--empty')).toContainText('Nothing to read about this track');
});

test('the panel travels into fullscreen', async ({ page }) => {
  await setupNowPlaying(page, { withInfo: true });
  await page.locator('.now-playing-view .np-action-btn[aria-label="About this track"]').click();
  await page.locator('.np-action-btn[aria-label="Enter fullscreen"]').click();
  const overlay = page.locator('.audio-fs');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay.locator('.np-about-scroll')).toContainText('Mock artist bio');
});
