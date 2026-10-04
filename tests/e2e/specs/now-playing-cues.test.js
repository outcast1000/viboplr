// Now Playing cue cards: an assistant-written cue sheet plays over the art
// column, with a corner button that only exists for a song that has one.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

const SHEET = {
  title: 'mock', artistName: null, source: 'Claude', updatedAt: 0,
  // At 0 and long-lived, so it is on screen whatever the mock audio's clock does.
  sheet: { cues: [{ at: 0, until: 3600, kind: 'quote', text: 'Mock lyric line', caption: 'What it means', label: 'Meaning' }] },
};

/** Same route in as now-playing-about.test.js. */
async function setupNowPlaying(page, { withCues }) {
  await page.addInitScript({ path: tauriMockPath });
  if (withCues) await page.addInitScript((sheet) => { window.__E2E_CUES__ = sheet; }, SHEET);
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

test('a cue sheet plays its card over the art, and the button hides it', async ({ page }) => {
  await setupNowPlaying(page, { withCues: true });
  const view = page.locator('.now-playing-view');

  const card = view.locator('.np-art-col .np-cue');
  await expect(card).toContainText('Mock lyric line');
  await expect(card).toContainText('What it means');
  await expect(card.locator('.np-cue-label')).toHaveText('Meaning');
  await expect(card.locator('.np-cue-source')).toHaveText('Claude');

  await view.locator('.np-action-btn[aria-label="Hide cue cards"]').click();
  await expect(view.locator('.np-cue')).toHaveCount(0);
  await view.locator('.np-action-btn[aria-label="Show cue cards"]').click();
  await expect(view.locator('.np-cue')).toHaveCount(1);
});

test('without a cue sheet there is no card and no button', async ({ page }) => {
  await setupNowPlaying(page, { withCues: false });
  const view = page.locator('.now-playing-view');
  await expect(view.locator('.np-action-btn[aria-label="About this track"]')).toBeVisible();
  await expect(view.locator('.np-cue')).toHaveCount(0);
  await expect(view.locator('.np-action-btn[aria-label*="cue cards"]')).toHaveCount(0);
});

test('the cards travel into fullscreen', async ({ page }) => {
  await setupNowPlaying(page, { withCues: true });
  await page.locator('.np-action-btn[aria-label="Enter fullscreen"]').click();
  const overlay = page.locator('.audio-fs');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay.locator('.np-cue')).toContainText('Mock lyric line');
});
