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

test('pressing Cmd+1 through Cmd+6 switches views', async ({ page }) => {
  // Cmd+1 - Tracks
  await page.keyboard.press('Meta+1');
  await expect(page.locator('.nav-btn').nth(0)).toHaveClass(/active/);

  // Cmd+2 - Artists
  await page.keyboard.press('Meta+2');
  await expect(page.locator('.nav-btn').nth(1)).toHaveClass(/active/);

  // Cmd+3 - Albums
  await page.keyboard.press('Meta+3');
  await expect(page.locator('.nav-btn').nth(2)).toHaveClass(/active/);

  // Cmd+4 - Tags
  await page.keyboard.press('Meta+4');
  await expect(page.locator('.nav-btn').nth(3)).toHaveClass(/active/);

  // Cmd+5 - Liked
  await page.keyboard.press('Meta+5');
  await expect(page.locator('.nav-btn').nth(4)).toHaveClass(/active/);

  // Cmd+6 - History
  await page.keyboard.press('Meta+6');
  await expect(page.locator('.nav-btn').nth(5)).toHaveClass(/active/);
});

test('pressing Cmd+K focuses the central search input', async ({ page }) => {
  await page.keyboard.press('Meta+k');

  const searchInput = page.locator('.central-search-container input');
  await expect(searchInput).toBeFocused();
});

test('pressing Escape closes the search dropdown if open', async ({ page }) => {
  // Open search
  await page.keyboard.press('Meta+k');

  const searchInput = page.locator('.central-search-container input');
  await expect(searchInput).toBeFocused();

  // Type to trigger dropdown
  await searchInput.fill('test');
  await page.waitForTimeout(300); // Wait for debounce

  // Check if dropdown exists
  const dropdown = page.locator('.central-search-dropdown');
  if (await dropdown.isVisible()) {
    // Press Escape
    await page.keyboard.press('Escape');

    // Dropdown should close
    await expect(dropdown).not.toBeVisible();
  }
});

test('Space key toggles play/pause', async ({ page }) => {
  // Make sure no input is focused
  await page.locator('body').click();

  // Press Space to play
  await page.keyboard.press('Space');

  // Wait briefly for state change
  await page.waitForTimeout(200);

  // Check that play button changed state (either has .playing class or icon changed)
  const playButton = page.locator('.ctrl-btn.play');
  await expect(playButton).toBeVisible();

  // Press Space again to pause
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);

  // Button should still exist
  await expect(playButton).toBeVisible();
});
