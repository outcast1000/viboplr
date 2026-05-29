// E2E coverage for the DownloadModal refactor (split into download/SingleTrackDownload,
// download/MultiTrackDownload, download/types, download/pathUtils).
//
// DownloadModal is only reachable through plugin download-provider context-menu
// actions, which the e2e tauri-mock doesn't simulate. Instead we mount the
// component directly in the live Vite webview via dynamic import and assert that
// both the single- and multi-track variants render through the slim wrapper.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

const COMMON_PROPS = {
  providerId: 'test:prov',
  providerName: 'TestProvider',
  downloadFormat: 'flac',
  collections: [{ id: 1, name: 'Music', path: '/music' }],
  downloadsCollectionId: 1,
  lastDest: null,
};

// Mounts DownloadModal into a fresh root with the given tracks, returns probe data.
async function mountDownloadModal(page, tracks, extra = {}) {
  return page.evaluate(async ({ tracks, common, extra }) => {
    const errors = [];
    window.addEventListener('error', (e) => errors.push(String(e.message)));
    // Vite resolves bare specifiers behind the /@id/ prefix; raw browser
    // import() of "react-dom/client" would fail. Vite's optimized deps expose
    // the API on .default, so unwrap defensively.
    const reactDomMod = await import('/@id/react-dom/client');
    const ReactDOM = reactDomMod.createRoot ? reactDomMod : reactDomMod.default;
    const reactMod = await import('/@id/react');
    const createElement = reactMod.createElement ?? reactMod.default.createElement;
    const mod = await import('/src/components/DownloadModal.tsx');

    const div = document.createElement('div');
    div.setAttribute('data-harness', 'download');
    document.body.appendChild(div);

    const fakeStore = { get: async () => null, set: async () => {} };
    const props = {
      ...common,
      ...extra,
      tracks,
      store: fakeStore,
      onSearch: async () => [],
      onResolve: async () => ({ url: '' }),
      onClose: () => {},
      onComplete: () => {},
    };
    ReactDOM.createRoot(div).render(createElement(mod.DownloadModal, props));
    await new Promise((r) => setTimeout(r, 400));

    const modal = document.querySelector('[data-harness="download"] .dl-modal');
    return {
      mounted: !!modal,
      title: modal?.querySelector('.ds-modal-title')?.textContent ?? null,
      trackLine: modal?.querySelector('.dl-track')?.textContent ?? null,
      hasConfigRows: modal ? modal.querySelectorAll('.dl-config-row').length : 0,
      errors,
    };
  }, { tracks, common: COMMON_PROPS, extra });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
});

test('single-track DownloadModal renders via the slim wrapper', async ({ page }) => {
  const r = await mountDownloadModal(page, [
    { title: 'Spike Song', artistName: 'Spike Artist', albumTitle: 'Spike Album', uri: null, durationSecs: 180, trackId: null },
  ]);
  expect(r.mounted).toBe(true);
  // SingleTrackDownload header + track line.
  expect(r.title).toContain('Download from TestProvider');
  expect(r.trackLine).toContain('Spike Song');
  expect(r.errors, `page errors: ${r.errors.join('; ')}`).toHaveLength(0);
});

test('multi-track DownloadModal renders the batch variant', async ({ page }) => {
  const r = await mountDownloadModal(page, [
    { title: 'Track One', artistName: 'Artist A', albumTitle: 'Album X', uri: null, durationSecs: 100, trackId: null },
    { title: 'Track Two', artistName: 'Artist B', albumTitle: 'Album Y', uri: null, durationSecs: 200, trackId: null },
  ]);
  expect(r.mounted).toBe(true);
  // MultiTrackDownload header reports the count, and the configure step has rows.
  expect(r.title).toContain('Download 2 tracks from TestProvider');
  expect(r.hasConfigRows).toBeGreaterThan(0);
  expect(r.errors, `page errors: ${r.errors.join('; ')}`).toHaveLength(0);
});
