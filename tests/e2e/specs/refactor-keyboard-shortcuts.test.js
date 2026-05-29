// E2E coverage for the App.tsx keyboard-shortcut extraction: the in-window
// keydown handler (~135 lines) moved into hooks/useInAppKeyboardShortcuts.ts.
// These drive real shortcuts through the live webview and assert observable DOM,
// confirming the extracted hook is wired up correctly.
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

test('Cmd+1 activates Library, Cmd+2 activates History', async ({ page }) => {
  await page.keyboard.press('Meta+2');
  await expect(page.locator('.sidebar .nav-btn.active .nav-btn-label')).toHaveText('History');

  await page.keyboard.press('Meta+1');
  await expect(page.locator('.sidebar .nav-btn.active .nav-btn-label')).toHaveText('Library');
});

test('Cmd+B toggles the sidebar collapsed class', async ({ page }) => {
  const app = page.locator('.app');
  const initiallyCollapsed = await app.evaluate((el) => el.classList.contains('sidebar-collapsed'));

  await page.keyboard.press('Meta+b');
  await expect
    .poll(() => app.evaluate((el) => el.classList.contains('sidebar-collapsed')))
    .toBe(!initiallyCollapsed);

  // Toggling again returns to the original state.
  await page.keyboard.press('Meta+b');
  await expect
    .poll(() => app.evaluate((el) => el.classList.contains('sidebar-collapsed')))
    .toBe(initiallyCollapsed);
});

test('pressing "/" focuses the central search input (non-input context)', async ({ page }) => {
  // Click a neutral area first so focus isn't already in an input.
  await page.locator('.sidebar').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(page.locator('.central-search-container input')).toBeFocused();
});

test('Cmd+P toggles the queue panel collapsed class', async ({ page }) => {
  const app = page.locator('.app');
  const initiallyCollapsed = await app.evaluate((el) => el.classList.contains('queue-collapsed'));

  await page.keyboard.press('Meta+p');
  await expect
    .poll(() => app.evaluate((el) => el.classList.contains('queue-collapsed')))
    .toBe(!initiallyCollapsed);
});
