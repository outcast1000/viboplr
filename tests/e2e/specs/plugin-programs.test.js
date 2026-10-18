// api.system.programs consent, end to end through a real worker plugin:
//  - `programs:run` listed under optionalPermissions is NOT asked at start-up
//    (the plugin runs without it — the user may run the program themselves);
//  - the first call that needs it asks for the optional set, and an unsigned
//    plugin then gets the warned second consent;
//  - every download is confirmed in a host dialog, and declining one rejects
//    the call with "Install declined" without reaching the backend.
//
// The plugin fixture exposes its calls as UI actions so the spec can drive
// them, and records outcomes through api.log (window.__TEST_LOG_LINES__).
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

const URL_ = 'https://github.com/slskd/slskd/releases/download/0.26.1/slskd-0.26.1-osx-arm64.zip';

const PLUGIN = {
  id: 'prog-demo',
  manifest: {
    id: 'prog-demo',
    name: 'Program Demo',
    version: '1.0.0',
    author: 'e2e',
    description: 'Installs a program when asked',
    runtime: 'worker',
    permissions: ['network:127.0.0.1'],
    optionalPermissions: ['programs:run', 'network:github.com'],
    permissionReasons: { 'programs:run': 'Install slskd for you' },
    contributes: { sidebarItems: [{ id: 'main', label: 'Program Demo', icon: 'download' }] },
  },
  code: `
function activate(api) {
  api.log('info', 'prog-demo is running');
  api.ui.setViewData('main', { type: 'layout', direction: 'vertical', children: [
    { type: 'button', label: 'Install it', action: 'install' },
  ] });
  api.ui.onAction('install', function () {
    api.system.programs.download(['dl', 'slskd.zip'], ${JSON.stringify(URL_)}, { sha256: '${'a'.repeat(64)}', label: 'slskd 0.26.1' })
      .then(function () { api.log('info', 'download ok'); })
      .catch(function (e) { api.log('info', 'download failed: ' + (e && e.message)); });
  });
}
return { activate: activate };`,
};

async function setup(page) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((plugin) => {
    window.__E2E_PLUGINS__ = [plugin];
    window.__E2E_STORE_PERSIST__ = true;
    // The required permission was approved at install; the optional ones never were.
    window.__E2E_STORE_SEED__ = {
      enabledPlugins: [plugin.id],
      onboardingComplete: true,
      pluginPermissionGrants: { [plugin.id]: ['network:127.0.0.1'] },
    };
  }, PLUGIN);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

const logged = (page, message) =>
  page.evaluate((m) => (window.__TEST_LOG_LINES__ || []).some((l) => l.message === m), message);
const downloads = (page) =>
  page.evaluate(() => (window.__TEST_PROGRAM_CALLS__ || []).filter((c) => c.cmd === 'plugin_program_download').length);

async function clickInstall(page) {
  await page.locator('.nav-btn', { hasText: 'Program Demo' }).first().click();
  await page.getByRole('button', { name: 'Install it' }).click();
}

test('optional permissions are not asked at start-up, only when the install is chosen', async ({ page }) => {
  await setup(page);
  // Runs straight away: nothing it needs to start is missing.
  await expect.poll(() => logged(page, 'prog-demo is running')).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await clickInstall(page);
  const ask = page.getByRole('dialog', { name: 'Program Demo needs more access' });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Download and run programs on this computer');
  await expect(ask).toContainText('Connect to github.com');
  await expect(ask).toContainText('Why: Install slskd for you');
  await ask.getByRole('button', { name: 'Allow' }).click();

  // Unsigned plugin: the second, warned consent.
  const warn = page.getByRole('alertdialog', { name: "Program Demo isn't signed by Vibo" });
  await expect(warn).toBeVisible();
  await warn.getByRole('button', { name: 'Allow anyway' }).click();

  // And the install itself is confirmed, naming what will be fetched.
  const confirm = page.getByRole('dialog', { name: 'Install a program for Program Demo?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('slskd-0.26.1-osx-arm64.zip');
  await expect(confirm).toContainText('github.com');
  await expect(confirm).toContainText('slskd 0.26.1');
  await expect(confirm).toContainText('checksum is pinned');
  await confirm.getByRole('button', { name: 'Install' }).click();

  await expect.poll(() => logged(page, 'download ok')).toBe(true);
  expect(await downloads(page)).toBe(1);
  const writes = await page.evaluate(() => window.__E2E_STORE_WRITES__);
  expect(writes.pluginPermissionGrants['prog-demo']).toEqual(['network:127.0.0.1', 'programs:run', 'network:github.com']);
  expect(writes.pluginProgramConsent).toEqual({ 'prog-demo': 'unsigned' });

  // A second install skips the permission asks but is confirmed again.
  await page.getByRole('button', { name: 'Install it' }).click();
  const again = page.getByRole('dialog', { name: 'Install a program for Program Demo?' });
  await expect(again).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Program Demo needs more access' })).toHaveCount(0);
  await again.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => logged(page, 'download failed: Install declined')).toBe(true);
  expect(await downloads(page)).toBe(1);
});

test('declining the permission ask denies the call without asking anything else', async ({ page }) => {
  await setup(page);
  await expect.poll(() => logged(page, 'prog-demo is running')).toBe(true);
  await clickInstall(page);
  await page.getByRole('dialog', { name: 'Program Demo needs more access' }).getByRole('button', { name: 'Not now' }).click();
  await expect.poll(() =>
    page.evaluate(() => (window.__TEST_LOG_LINES__ || []).some((l) => /download failed: Permission denied.*programs:run/.test(l.message))),
  ).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await downloads(page)).toBe(0);
});
