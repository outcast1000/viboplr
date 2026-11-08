// The Now Playing About panel: song / artist / album prose in the side column,
// in the lyrics column's place. Turned on by the Artwork pick's "Show info"
// option, which lives in the visualizer picker — a native menu no test can
// click — so these specs seed the persisted option instead.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

const INFO_ON = { extraImages: false, extraImagesSet: false, info: true, fill: false };

/** Same route in as audio-fullscreen.test.js: play a library track, then open
 *  Now Playing. `withInfo` turns on the cached artist-bio fixture, `showInfo`
 *  the "Show info" option. */
async function setupNowPlaying(page, { withInfo, showInfo = true }) {
  await page.addInitScript({ path: tauriMockPath });
  if (withInfo) await page.addInitScript(() => { window.__E2E_INFO__ = true; });
  if (showInfo) {
    await page.addInitScript((opts) => {
      window.__E2E_STORE_SEED__ = { ...(window.__E2E_STORE_SEED__ || {}), nowPlayingArtwork: opts };
    }, INFO_ON);
  }
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

  await page.locator('.nav .nav-btn').filter({ hasText: 'Now Playing' }).click();
  await page.locator('.now-playing-view').waitFor({ state: 'visible', timeout: 10000 });
}

test('"Show info" puts the artist bio in the side column', async ({ page }) => {
  await setupNowPlaying(page, { withInfo: true });
  const view = page.locator('.now-playing-view');

  await expect(view.locator('.np-about-scroll')).toContainText('Mock artist bio');
  // It fills the side column, so the layout is the two-column one.
  await expect(view).not.toHaveClass(/np-audio--nolyrics/);
  // One text → no tab row; the tab word would just restate the only thing there.
  await expect(view.locator('.np-about-tabs')).toHaveCount(0);
  // No Lyrics / About buttons any more — they are picker options.
  await expect(view.locator('.np-action-btn[aria-label="About this track"]')).toHaveCount(0);
  await expect(view.locator('.np-action-btn[aria-label="Show lyrics"]')).toHaveCount(0);
});

test('off by default: the view opens on the art, not on text', async ({ page }) => {
  await setupNowPlaying(page, { withInfo: true, showInfo: false });
  await expect(page.locator('.now-playing-view .np-about')).toHaveCount(0);
});

test('with nothing to read the panel says so instead of staying blank', async ({ page }) => {
  await setupNowPlaying(page, { withInfo: false });
  const view = page.locator('.now-playing-view');
  await expect(view.locator('.np-about--empty')).toContainText('Nothing to read about this track');
});

test('the panel travels into fullscreen', async ({ page }) => {
  await setupNowPlaying(page, { withInfo: true });
  await page.locator('.np-action-btn[aria-label="Enter fullscreen"]').click();
  const overlay = page.locator('.audio-fs');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay.locator('.np-about-scroll')).toContainText('Mock artist bio');
});
