// The master/detail view nodes, end to end: a worker plugin draws a `split`
// with a `tree` of the library's artists on the left; expanding an artist lazily
// loads its albums through `api.library.getAlbums`, selecting an album shows its
// tracks on the right, and the keyboard drives the tree without the window's
// transport keys (↑/↓ = volume) also firing.
//
// Runs on the opt-in plugin fixture (`window.__E2E_PLUGINS__`) — a real worker,
// served by Vite — against tauri-mock.js's TEST_ARTISTS / TEST_ALBUMS.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

const PLUGIN = {
  id: 'tree-demo',
  manifest: {
    id: 'tree-demo',
    name: 'Tree Demo',
    version: '1.0.0',
    author: 'e2e',
    description: 'A tiny explorer',
    runtime: 'worker',
    permissions: ['library:read'],
    contributes: { sidebarItems: [{ id: 'main', label: 'Tree Demo', icon: 'library' }] },
  },
  code: `
var artists = [];
var albumsByArtist = {};
var selected = null;
function render() {
  var nodes = artists.map(function (a) {
    var kids = albumsByArtist[a.id];
    return {
      id: 'artist:' + a.id, label: a.name, hasChildren: true, data: { artistId: a.id },
      entity: { kind: 'artist', id: a.id, name: a.name },
      children: kids ? kids.map(function (al) {
        return { id: 'album:' + al.id, label: al.title, sublabel: String(al.year), data: { albumId: al.id, title: al.title } };
      }) : undefined,
    };
  });
  api.ui.setViewData('main', {
    type: 'split', persistKey: 'main', initialSize: 260,
    children: [
      { type: 'tree', nodes: nodes, selectAction: 'select', expandAction: 'expand', selectedId: selected ? selected.id : undefined, ariaLabel: 'Library tree' },
      { type: 'text', content: selected ? 'Showing ' + selected.label : 'Pick something' },
    ],
  });
}
var api;
function activate(a) {
  api = a;
  api.library.getArtists({ sort: 'name' }).then(function (list) { artists = list; render(); });
  api.ui.onAction('expand', function (p) {
    if (!p.expanded || !p.data || albumsByArtist[p.data.artistId]) return;
    api.library.getAlbums({ artistId: p.data.artistId, sort: 'year' }).then(function (list) {
      albumsByArtist[p.data.artistId] = list;
      render();
    });
  });
  api.ui.onAction('select', function (p) {
    selected = { id: p.id, label: p.data && p.data.title ? p.data.title : p.id };
    render();
  });
}
return { activate: activate };`,
};

async function setup(page) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((plugin) => {
    window.__E2E_PLUGINS__ = [plugin];
    window.__E2E_STORE_PERSIST__ = true;
    window.__E2E_STORE_SEED__ = {
      enabledPlugins: [plugin.id],
      onboardingComplete: true,
      pluginPermissionGrants: { [plugin.id]: ['library:read'] },
    };
  }, PLUGIN);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.locator('.nav-btn', { hasText: 'Tree Demo' }).first().click();
}

test('a lazy tree in a split: expand loads children, select drives the other pane', async ({ page }) => {
  await setup(page);
  const tree = page.getByRole('tree', { name: 'Library tree' });
  await expect(tree.getByRole('treeitem', { name: /Artist A/ })).toBeVisible();
  await expect(page.locator('.psplit-pane--first')).toHaveCSS('width', '260px');

  await tree.getByRole('button', { name: 'Expand Artist A' }).click();
  await expect(tree.getByRole('treeitem', { name: /Album X/ })).toBeVisible();
  // The mock filters albums by artist: Artist B's album isn't under Artist A.
  await expect(tree.getByRole('treeitem', { name: /Album Y/ })).toHaveCount(0);

  await tree.getByRole('treeitem', { name: /Album X/ }).click();
  await expect(page.locator('.psplit-pane--second')).toContainText('Showing Album X');
  await expect(tree.getByRole('treeitem', { name: /Album X/ })).toHaveAttribute('aria-selected', 'true');
});

test('the keyboard drives the tree and the transport keys stand down', async ({ page }) => {
  await setup(page);
  const tree = page.getByRole('tree', { name: 'Library tree' });
  await expect(tree.getByRole('treeitem', { name: /Artist B/ })).toBeVisible();
  const volumeBefore = await page.evaluate(() => (window.__TEST_ENGINE__ && window.__TEST_ENGINE__.calls || [])
    .filter((c) => c.cmd === 'engine_set_volume').length);

  await tree.focus();
  await page.keyboard.press('ArrowDown'); // cursor on Artist A
  await page.keyboard.press('ArrowDown'); // Artist B
  await page.keyboard.press('ArrowRight'); // expand → lazy load
  await expect(tree.getByRole('treeitem', { name: /Album Y/ })).toBeVisible();
  await page.keyboard.press('ArrowRight'); // into Album Y
  await page.keyboard.press('Enter');
  await expect(page.locator('.psplit-pane--second')).toContainText('Showing Album Y');

  const volumeAfter = await page.evaluate(() => (window.__TEST_ENGINE__ && window.__TEST_ENGINE__.calls || [])
    .filter((c) => c.cmd === 'engine_set_volume').length);
  expect(volumeAfter).toBe(volumeBefore);
});

test('dragging the divider is remembered for the view', async ({ page }) => {
  await setup(page);
  const divider = page.getByRole('separator', { name: 'Resize panes' });
  await expect(divider).toBeVisible();
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.psplit-pane--first')).toHaveCSS('width', '340px');
  await expect.poll(() => page.evaluate(() => window.__E2E_STORE_WRITES__ && window.__E2E_STORE_WRITES__.pluginSplitSizes))
    .toEqual({ 'tree-demo:main': 340 });
});
