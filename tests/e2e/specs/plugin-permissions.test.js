// Permission consent for worker-runtime plugins: a plugin asking for anything
// the user hasn't approved does not run, the Extensions detail pane lists what
// it asks for in plain language, "Allow and start" approves exactly that list
// and starts it, and "Revoke permissions" stops it again.
//
// Runs against the opt-in plugin fixture (`window.__E2E_PLUGINS__`) and store
// persistence (`window.__E2E_STORE_PERSIST__`) in tauri-mock.js: approval is a
// store write followed by a reload that re-reads it, so dropped writes would
// make approval look broken. The worker is real — Vite serves the runtime.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

const PLUGIN = {
  id: 'perm-demo',
  manifest: {
    id: 'perm-demo',
    name: 'Permission Demo',
    version: '1.0.0',
    author: 'e2e',
    description: 'Asks for two permissions',
    runtime: 'worker',
    permissions: ['network:lrclib.net', 'exec:yt-dlp'],
  },
  // Proof of life: logs from inside its worker when activated.
  code: "function activate(api) { api.log('info', 'perm-demo is running'); }\nreturn { activate: activate };",
};

async function setup(page, grants) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript(({ plugin, grants }) => {
    window.__E2E_PLUGINS__ = [plugin];
    window.__E2E_STORE_PERSIST__ = true;
    window.__E2E_STORE_SEED__ = {
      enabledPlugins: [plugin.id],
      onboardingComplete: true,
      ...(grants ? { pluginPermissionGrants: grants } : {}),
    };
  }, { plugin: PLUGIN, grants });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

async function openPluginDetail(page) {
  await page.locator('.nav-btn[aria-label="Extensions"], .nav-btn:has-text("Extensions"), button[title="Extensions"]').first().click();
  const row = page.locator('.ext-prow, .ext-pcard').filter({ hasText: 'Permission Demo' }).first();
  await expect(row).toBeVisible();
  return row;
}

const pluginRan = (page) =>
  page.evaluate(() => (window.__TEST_LOG_LINES__ || []).some((l) => l.message === 'perm-demo is running'));

test('an unapproved worker plugin waits, and Allow starts it with exactly what it asked for', async ({ page }) => {
  await setup(page, null);
  const row = await openPluginDetail(page);
  await expect(row.locator('.ext-badge', { hasText: 'needs approval' })).toBeVisible();
  expect(await pluginRan(page)).toBe(false);

  await row.getByRole('button', { name: 'Details' }).click();
  const perms = page.locator('.ext-perms');
  await expect(perms).toBeVisible();
  await expect(perms).toContainText('Connect to lrclib.net');
  await expect(perms).toContainText('Run yt-dlp');
  // exec reaches outside the app, so it is flagged; a single site is not.
  await expect(perms.locator('.ext-perms-item', { hasText: 'Run yt-dlp' }).locator('.ext-badge', { hasText: 'sensitive' })).toBeVisible();
  await expect(perms.locator('.ext-perms-item', { hasText: 'Connect to lrclib.net' }).locator('.ext-badge')).toHaveCount(0);
  // The switch is on (the user enabled it); only the approval is missing.
  await expect(page.locator('.ext-detail-actions').getByRole('button', { name: 'Disable' })).toBeVisible();
  await expect(page.locator('.ext-detail-meta')).toContainText('Waiting for your approval');

  await perms.getByRole('button', { name: 'Allow and start' }).click();

  await expect(page.locator('.ext-detail-name .ext-badge--active')).toBeVisible();
  await expect.poll(() => pluginRan(page)).toBe(true);
  const grants = await page.evaluate(() => window.__E2E_STORE_WRITES__?.pluginPermissionGrants);
  expect(grants).toEqual({ 'perm-demo': ['network:lrclib.net', 'exec:yt-dlp'] });
  await expect(perms.getByRole('button', { name: 'Revoke permissions' })).toBeVisible();
});

test('an update that asks for more stops the plugin until the new permission is approved', async ({ page }) => {
  // Approved last version's single permission; this version adds exec.
  await setup(page, { 'perm-demo': ['network:lrclib.net'] });
  const row = await openPluginDetail(page);
  await expect(row.locator('.ext-badge', { hasText: 'needs approval' })).toBeVisible();
  expect(await pluginRan(page)).toBe(false);

  await row.getByRole('button', { name: 'Details' }).click();
  const perms = page.locator('.ext-perms');
  await expect(perms).toContainText('asks for more than you allowed before');
  await expect(perms.locator('.ext-perms-item.is-pending')).toHaveCount(1);
  await expect(perms.locator('.ext-perms-item.is-pending')).toContainText('Run yt-dlp');
  await expect(perms.locator('.ext-perms-item.is-pending .ext-badge', { hasText: 'new' })).toBeVisible();
});

test('Revoke stops a running plugin and puts it back to waiting', async ({ page }) => {
  await setup(page, { 'perm-demo': ['network:lrclib.net', 'exec:yt-dlp'] });
  const row = await openPluginDetail(page);
  await expect.poll(() => pluginRan(page)).toBe(true);
  await row.getByRole('button', { name: 'Details' }).click();

  await page.locator('.ext-perms').getByRole('button', { name: 'Revoke permissions' }).click();

  await expect(page.locator('.ext-perms').getByRole('button', { name: 'Allow and start' })).toBeVisible();
  await expect(page.locator('.ext-detail-meta')).toContainText('Waiting for your approval');
  const grants = await page.evaluate(() => window.__E2E_STORE_WRITES__?.pluginPermissionGrants);
  expect(grants).toEqual({});
});

test('a worker plugin with a visualizer is refused with a reason, not started in a broken state', async ({ page }) => {
  const viz = {
    id: 'viz-demo',
    manifest: {
      id: 'viz-demo', name: 'Viz Demo', version: '1.0.0', author: 'e2e', description: 'Declares a visualizer',
      runtime: 'worker', permissions: [],
      contributes: { visualizers: [{ id: 'deck', name: 'Deck', placements: ['nowplaying'] }] },
    },
    code: "function activate(api) { api.log('info', 'viz-demo is running'); }\nreturn { activate: activate };",
  };
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((plugin) => {
    window.__E2E_PLUGINS__ = [plugin];
    window.__E2E_STORE_SEED__ = { enabledPlugins: [plugin.id], onboardingComplete: true };
  }, viz);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.locator('button[title="Extensions"]').first().click();
  const row = page.locator('.ext-prow, .ext-pcard').filter({ hasText: 'Viz Demo' }).first();
  await expect(row.locator('.ext-badge', { hasText: 'error' })).toBeVisible();
  await row.getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('.ext-detail-error')).toContainText("Visualizers can't run in the worker runtime yet");
  expect(await pluginRan(page)).toBe(false);
  const ran = await page.evaluate(() => (window.__TEST_LOG_LINES__ || []).some((l) => l.message === 'viz-demo is running'));
  expect(ran).toBe(false);
});

test('uninstalling a plugin drops its approval, so a later plugin with the same id is asked again', async ({ page }) => {
  await setup(page, { 'perm-demo': ['network:lrclib.net', 'exec:yt-dlp'] });
  const row = await openPluginDetail(page);
  await expect.poll(() => pluginRan(page)).toBe(true);
  await row.getByRole('button', { name: 'Details' }).click();
  await page.locator('.ext-detail-actions').getByRole('button', { name: 'Uninstall' }).click();
  await page.locator('.ds-modal').getByRole('button', { name: 'Uninstall' }).click();
  await expect.poll(() => page.evaluate(() => window.__E2E_STORE_WRITES__?.pluginPermissionGrants)).toEqual({});
});
