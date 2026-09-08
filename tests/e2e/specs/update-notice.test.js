// The update notice banner: a new release announces itself at the top of the
// content column instead of only as a dot on the Settings nav button, carries
// its release notes, and stays dismissed for that release only.
//
// Runs against the opt-in update fixtures in tauri-mock.js
// (`window.__E2E_APP_UPDATE__` / `window.__E2E_EXT_UPDATES__`) — every other
// spec asserts on views this banner would otherwise push down.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

const NOTES = 'Album artist support and assorted fixes';

async function setup(page, { app = null, extensions = null, storeSeed = {} } = {}) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript(({ app, extensions, seed }) => {
    if (app) window.__E2E_APP_UPDATE__ = app;
    if (extensions) window.__E2E_EXT_UPDATES__ = extensions;
    window.__E2E_STORE_SEED__ = seed;
  }, { app, extensions, seed: storeSeed });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

/** The background check fires 30s after launch, which a test can't wait out —
 *  Settings' own button runs the same `app_update_check`. */
async function checkForUpdates(page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForSelector('.settings-view');
  await page.getByRole('button', { name: 'Check for Updates' }).click();
}

const appUpdate = { version: '9.9.9', body: NOTES };

test('an available release announces itself in the content column', async ({ page }) => {
  await setup(page, { app: appUpdate });
  await checkForUpdates(page);

  const notice = page.locator('.update-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Viboplr 9.9.9 is available');
  // The one-click route the banner exists to provide.
  await expect(notice.getByRole('button', { name: 'Update & restart' })).toBeVisible();
});

test("release notes are reachable from the banner via What's new", async ({ page }) => {
  await setup(page, { app: appUpdate });
  await checkForUpdates(page);

  const notice = page.locator('.update-notice');
  // Collapsed by default — the strip is a headline, not a changelog.
  await expect(page.locator('.update-notice-notes')).toHaveCount(0);
  await notice.getByRole('button', { name: "What's new" }).click();
  await expect(page.locator('.update-notice-notes')).toContainText(NOTES);
});

test('dismissing hides the banner, leaving the Settings route intact', async ({ page }) => {
  await setup(page, { app: appUpdate });
  await checkForUpdates(page);
  await page.locator('.update-notice').waitFor();

  await page.getByRole('button', { name: 'Dismiss update notice' }).click();
  await expect(page.locator('.update-notice')).toHaveCount(0);
  // Dismissing the announcement must not withdraw the update itself.
  await expect(page.getByRole('button', { name: 'Update to v9.9.9' })).toBeVisible();
});

test('a dismissal survives a relaunch', async ({ page }) => {
  await setup(page, {
    app: appUpdate,
    storeSeed: { updateNoticeDismissed: { app: 'app:9.9.9' } },
  });
  await checkForUpdates(page);
  // The check found the same release the user already waved away.
  await expect(page.getByRole('button', { name: 'Update to v9.9.9' })).toBeVisible();
  await expect(page.locator('.update-notice')).toHaveCount(0);
});

test('a later release announces itself despite an earlier dismissal', async ({ page }) => {
  // The dismissal is keyed by release, not by a "don't show me banners" flag —
  // otherwise it would be something you turn off once and never see again.
  await setup(page, {
    app: { version: '9.9.10', body: '' },
    storeSeed: { updateNoticeDismissed: { app: 'app:9.9.9' } },
  });
  await checkForUpdates(page);
  await expect(page.locator('.update-notice')).toContainText('Viboplr 9.9.10 is available');
});

test('extension updates get the same banner, with Update all', async ({ page }) => {
  await setup(page, {
    extensions: [{
      id: 'ytdlp', kind: 'plugin', name: 'yt-dlp',
      currentVersion: '1.7.0', latestVersion: '1.8.0',
      changelog: '', downloadUrl: 'https://example.com/x.zip', status: 'available',
    }],
  });
  await page.getByRole('button', { name: 'Extensions' }).click();
  await page.waitForSelector('.extensions-view');
  // Same reason as the app check: the automatic one is 30s out.
  await page.getByRole('button', { name: 'Check for updates' }).click();

  const notice = page.locator('.update-notice');
  await expect(notice).toContainText('An update is available for yt-dlp');
  await expect(notice.getByRole('button', { name: 'Update all' })).toBeVisible();
});
