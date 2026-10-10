// Settings → Scrobbling: every scrobbler — the local history plus each plugin
// subscribed to `track:scrobbled` — with its own Audio / Video switches. The
// real bundled Last.fm plugin is loaded through `__E2E_PLUGINS__` so the
// plugin row comes from an actual subscription, not a fixture list.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');
const pluginDir = path.resolve(__dirname, '..', '..', '..', 'src-tauri', 'plugins', 'lastfm');

const PLUGIN = {
  id: 'lastfm',
  manifest: JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')),
  code: fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8'),
};

async function setup(page, seed = {}) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript(({ plugin, seed }) => {
    window.__E2E_PLUGINS__ = [plugin];
    window.__E2E_STORE_SEED__ = {
      enabledPlugins: [plugin.id],
      onboardingComplete: true,
      pluginPermissionGrants: { [plugin.id]: plugin.manifest.permissions },
      ...seed,
    };
  }, { plugin: PLUGIN, seed });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.settings-view .ds-tab', { hasText: 'Scrobbling' }).click();
}

const toggle = (page, name, media) => page.getByRole('switch', { name: `${name}: record ${media}` });

test('lists the local history and the Last.fm plugin', async ({ page }) => {
  await setup(page);
  const group = page.locator('#scrobbling');
  await expect(group.getByText('Local history', { exact: true })).toBeVisible();
  await expect(group.getByText('Last.fm (plugin)')).toBeVisible();
  for (const name of ['Local history', 'Last.fm']) {
    await expect(toggle(page, name, 'audio')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, name, 'video')).toHaveAttribute('aria-checked', 'true');
  }
});

test('each scrobbler has its own switches', async ({ page }) => {
  await setup(page);
  await toggle(page, 'Last.fm', 'video').click();
  await expect(toggle(page, 'Last.fm', 'video')).toHaveAttribute('aria-checked', 'false');
  await expect(toggle(page, 'Local history', 'video')).toHaveAttribute('aria-checked', 'true');
  await expect(toggle(page, 'Last.fm', 'audio')).toHaveAttribute('aria-checked', 'true');
});

test('the old "Track video history: off" carries over to every scrobbler', async ({ page }) => {
  await setup(page, { trackVideoHistory: false });
  for (const name of ['Local history', 'Last.fm']) {
    await expect(toggle(page, name, 'video')).toHaveAttribute('aria-checked', 'false');
    await expect(toggle(page, name, 'audio')).toHaveAttribute('aria-checked', 'true');
  }
});
