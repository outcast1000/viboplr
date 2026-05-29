// E2E coverage for the App.tsx startup-restore extraction: the 46-slot positional
// tuple of store.get reads moved into startup/readPersistedSettings.ts (named
// object) and the Last.fm migration into migrateLastfmSession. App.tsx still owns
// applying the values. This is the highest-stakes path (a wrong key string would
// silently fail to restore a setting), so we seed persisted values and assert the
// app actually applies them on startup — proving keys + apply-wiring are intact.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

// Seed persisted store values, then load. The seed must be set before any app
// code runs, so it goes in an init script ordered before the tauri mock reads it.
async function gotoWithSeed(page, seed) {
  await page.addInitScript((s) => { window.__E2E_STORE_SEED__ = s; }, seed);
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

test('restores sidebarCollapsed + queueCollapsed from persisted store', async ({ page }) => {
  await gotoWithSeed(page, { sidebarCollapsed: true, queueCollapsed: true });
  const app = page.locator('.app');
  await expect.poll(() => app.evaluate((el) => el.classList.contains('sidebar-collapsed'))).toBe(true);
  await expect.poll(() => app.evaluate((el) => el.classList.contains('queue-collapsed'))).toBe(true);
});

test('does NOT collapse when persisted values are false (default expanded)', async ({ page }) => {
  await gotoWithSeed(page, { sidebarCollapsed: false, queueCollapsed: false });
  const app = page.locator('.app');
  await expect.poll(() => app.evaluate((el) => el.classList.contains('sidebar-collapsed'))).toBe(false);
});

test('restores queueWidth from persisted store (CSS var)', async ({ page }) => {
  await gotoWithSeed(page, { queueWidth: 420 });
  const app = page.locator('.app');
  await expect
    .poll(() => app.evaluate((el) => el.style.getPropertyValue('--queue-width')))
    .toBe('420px');
});

test('always lands on Home regardless of persisted view (view not restored)', async ({ page }) => {
  // Even with a stale persisted "view", startup must land on Home.
  await gotoWithSeed(page, { view: 'history' });
  await expect(page.locator('.sidebar .nav-btn.active .nav-btn-label')).toHaveText('Home');
});
