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

// A clip: a full-view shape plus a positioned title. Long-lived for the same
// reason as SHEET.
const CLIP = {
  title: 'mock', artistName: null, source: 'Claude', updatedAt: 1,
  sheet: {
    mode: 'clip',
    cues: [
      { at: 0, until: 3600, kind: 'shape', box: { x: 0, y: 0, w: 100, h: 100 }, backgroundColor: '#000000' },
      {
        at: 0, until: 3600, kind: 'text', text: 'A VERY LONG TITLE THAT CANNOT FIT AT THIS SIZE', size: 40,
        box: { x: 10, y: 40, w: 80, h: 20 }, color: 'accent', weight: 'bold', layer: 2, dim: 0.5,
      },
    ],
  },
};

/** Same route in as now-playing-about.test.js. */
async function setupNowPlaying(page, { withCues, sheet = SHEET }) {
  await page.addInitScript({ path: tauriMockPath });
  if (withCues) await page.addInitScript((s) => { window.__E2E_CUES__ = s; }, sheet);
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

test('a clip draws over the whole view, fits its text, and owns the view until hidden', async ({ page }) => {
  await setupNowPlaying(page, { withCues: true, sheet: CLIP });
  const view = page.locator('.now-playing-view');
  const clip = view.locator('.np-clip');
  await expect(clip).toBeVisible();
  // Over the whole view, not inside the art column, and no card overlay.
  await expect(view.locator('.np-art-col .np-clip')).toHaveCount(0);
  await expect(view.locator('.np-cue')).toHaveCount(0);

  const title = clip.locator('.np-clip-el--text');
  await expect(title).toContainText('A VERY LONG TITLE');
  await expect(clip.locator('.np-clip-el--shape')).toHaveCount(1);
  // size 40 can't fit a 20%-tall box: the text was shrunk, and nothing spills.
  const fit = await title.evaluate((el) => parseFloat(el.style.getPropertyValue('--fit')));
  expect(fit).toBeLessThan(1);
  const spills = await title.evaluate((el) => {
    const block = el.querySelector('.np-clip-text-block');
    return block.scrollHeight > el.clientHeight + 1;
  });
  expect(spills).toBe(false);
  await expect.poll(() => clip.locator('.np-clip-dim').evaluate((el) => Number(el.style.opacity))).toBeGreaterThan(0.4);

  // The side column steps aside while the clip plays.
  await expect(view.locator('.np-action-btn[aria-label="About this track"]')).toBeDisabled();
  await expect(view.locator('.np-lyrics-col')).toHaveCount(0);

  await view.locator('.np-action-btn[aria-label="Hide clip"]').click();
  await expect(view.locator('.np-clip')).toHaveCount(0);
  await expect(view.locator('.np-action-btn[aria-label="About this track"]')).toBeEnabled();
  await view.locator('.np-action-btn[aria-label="Show clip"]').click();
  await expect(view.locator('.np-clip')).toHaveCount(1);
});

test('the cards travel into fullscreen', async ({ page }) => {
  await setupNowPlaying(page, { withCues: true });
  await page.locator('.np-action-btn[aria-label="Enter fullscreen"]').click();
  const overlay = page.locator('.audio-fs');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay.locator('.np-cue')).toContainText('Mock lyric line');
});
