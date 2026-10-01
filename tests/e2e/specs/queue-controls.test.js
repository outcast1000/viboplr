// Queue mode and auto-continue live in the queue panel (header + collapsed
// rail), not on the player bars; EQ and Bit-perfect sit behind one "Audio
// options" button and come back to the bar while on or pinned
// (utils/playerBarPins). The Audio options and ⋯ menus are native (no DOM), so
// what is asserted here is the DOM around them; their contents are unit-tested.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

async function setup(page, storeSeed = {}) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((seed) => { window.__E2E_STORE_SEED__ = seed; }, storeSeed);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(500);
}

test('the player bar has no playlist group and one Audio options button', async ({ page }) => {
  await setup(page);
  const bar = page.locator('footer.now-playing');
  await expect(bar.locator('.now-group--playlist')).toHaveCount(0);
  await expect(bar.locator('[aria-label^="Queue mode"]')).toHaveCount(0);
  await expect(bar.locator('[aria-label="Auto-continue"]')).toHaveCount(0);
  await expect(bar.locator('[aria-label="Audio options"]')).toHaveCount(1);
  // EQ is off by default, so it is behind Audio options rather than on the bar.
  await expect(bar.locator('[aria-label="Equalizer"]')).toHaveCount(0);
});

test('the EQ comes back to the bar while it is on', async ({ page }) => {
  await setup(page, { eqEnabled: true });
  await expect(page.locator('footer.now-playing [aria-label="Equalizer"]')).toHaveCount(1);
});

test('a pinned EQ stays on the bar while off', async ({ page }) => {
  await setup(page, { playerBarPins: { eq: true, bitPerfect: false } });
  await expect(page.locator('footer.now-playing [aria-label="Equalizer"]')).toHaveCount(1);
});

test('auto-continue is one button in the queue header', async ({ page }) => {
  await setup(page);
  const header = page.locator('.queue-header');
  const ac = header.locator('[aria-label="Auto-continue"]');
  await expect(ac).toHaveAttribute('aria-pressed', 'false');
  await ac.click();
  await expect(ac).toHaveAttribute('aria-pressed', 'true');
  await ac.click();
  await expect(ac).toHaveAttribute('aria-pressed', 'false');
});

test('auto-continue disables, but stays put, outside Normal mode', async ({ page }) => {
  await setup(page);
  const header = page.locator('.queue-header');
  const ac = header.locator('[aria-label="Auto-continue"]');
  await expect(ac).toBeEnabled();
  await header.locator('[aria-label^="Queue mode"]').click(); // → Repeat All
  await expect(header.locator('[aria-label="Queue mode: Repeat All"]')).toBeVisible();
  await expect(ac).toBeDisabled();
});

test('the collapsed rail carries the same controls without expanding', async ({ page }) => {
  await setup(page, { queueCollapsed: true });
  const rail = page.locator('.queue-collapsed-strip');
  await expect(rail).toBeVisible();
  const ac = rail.locator('[aria-label="Auto-continue"]');
  await ac.click();
  await expect(ac).toHaveAttribute('aria-pressed', 'true');
  // Still collapsed: the click belonged to the button, not the rail.
  await expect(page.locator('.queue-collapsed-strip')).toBeVisible();
  await expect(page.locator('.queue-header')).toHaveCount(0);
});

test('Prefer video, now a menu item, still announces itself in the list', async ({ page }) => {
  await setup(page, { preferVideoResolution: true });
  await expect(page.locator('.queue-header [aria-label="Prefer video"]')).toHaveCount(0);
  await expect(page.locator('.queue-prefer-video-row')).toBeVisible();
  await page.locator('.queue-prefer-video-off').click();
  await expect(page.locator('.queue-prefer-video-row')).toHaveCount(0);
});
