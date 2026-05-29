// E2E coverage for the App.tsx modal extraction: the inline modal JSX blocks were
// pulled into components/modals/ConfirmModals.tsx + YoutubeFeedbackModal.tsx as
// presentational leaf components. These are normally rendered by App.tsx in
// response to user actions; here we mount them directly in the live Vite webview
// and assert they render their props and fire their callbacks.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

// Mounts a named export with given props. Functions can't cross the page.evaluate
// boundary, so callbacks are passed as a list of prop NAMES (`callbackNames`) and
// reconstructed inside the browser to record invocation in `calls`.
async function mountModal(page, moduleUrl, exportName, dataProps, callbackNames, clickText) {
  return page.evaluate(async ({ moduleUrl, exportName, dataProps, callbackNames, clickText }) => {
    const errors = [];
    window.addEventListener('error', (e) => errors.push(String(e.message)));
    const reactDomMod = await import('/@id/react-dom/client');
    const ReactDOM = reactDomMod.createRoot ? reactDomMod : reactDomMod.default;
    const reactMod = await import('/@id/react');
    const createElement = reactMod.createElement ?? reactMod.default.createElement;
    const mod = await import(moduleUrl);

    const calls = [];
    const props = { ...dataProps };
    for (const name of callbackNames) {
      props[name] = () => calls.push(name);
    }

    const harnessId = 'modal-' + exportName + '-' + calls.length + '-' + (clickText || 'none');
    const div = document.createElement('div');
    div.setAttribute('data-harness', harnessId);
    document.body.appendChild(div);
    ReactDOM.createRoot(div).render(createElement(mod[exportName], props));
    await new Promise((r) => setTimeout(r, 200));

    const root = document.querySelector('[data-harness="' + harnessId + '"]');
    const html = root ? root.innerHTML : '';

    let clicked = null;
    if (clickText) {
      const btn = Array.from(root.querySelectorAll('button, a')).find(
        (b) => b.textContent.trim() === clickText
      );
      if (btn) { btn.click(); clicked = clickText; }
    }
    await new Promise((r) => setTimeout(r, 50));
    return { html, errors, calls, clicked };
  }, { moduleUrl, exportName, dataProps, callbackNames, clickText });
}

const CONFIRM = '/src/components/modals/ConfirmModals.tsx';
const YT = '/src/components/modals/YoutubeFeedbackModal.tsx';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
});

test('DeleteTracksModal renders title/trash label and fires onConfirm', async ({ page }) => {
  const r = await mountModal(page, CONFIRM, 'DeleteTracksModal',
    { title: '"My Song"', trackCount: 1, trashLabel: 'Trash' },
    ['onCancel', 'onConfirm'], 'Move to Trash');
  expect(r.html).toContain('My Song');
  expect(r.html).toContain('Trash');
  expect(r.calls).toContain('onConfirm');
  expect(r.errors, r.errors.join('; ')).toHaveLength(0);
});

test('DeleteTagsModal pluralizes and fires onCancel', async ({ page }) => {
  const r = await mountModal(page, CONFIRM, 'DeleteTagsModal',
    { tagCount: 3, firstTagName: 'rock' },
    ['onCancel', 'onConfirm'], 'Cancel');
  expect(r.html).toContain('Delete 3 tags?');
  expect(r.calls).toContain('onCancel');
  expect(r.errors, r.errors.join('; ')).toHaveLength(0);
});

test('DeleteErrorModal lists failures', async ({ page }) => {
  const r = await mountModal(page, CONFIRM, 'DeleteErrorModal',
    {
      message: 'Some deletes failed',
      failures: [{ title: 'Track A', reason: 'locked' }, { title: 'Track B', reason: 'missing' }],
    },
    ['onDismiss']);
  expect(r.html).toContain('Some deletes failed');
  expect(r.html).toContain('Track A');
  expect(r.html).toContain('locked');
  expect(r.errors, r.errors.join('; ')).toHaveLength(0);
});

test('DownloadAgainModal shows three actions and fires onShowInFolder', async ({ page }) => {
  const r = await mountModal(page, CONFIRM, 'DownloadAgainModal',
    { localTitle: 'Existing Track' },
    ['onCancel', 'onShowInFolder', 'onDownload'], 'Show in Folder');
  expect(r.html).toContain('Existing Track');
  expect(r.html).toContain('Already Downloaded');
  expect(r.calls).toContain('onShowInFolder');
  expect(r.errors, r.errors.join('; ')).toHaveLength(0);
});

test('RemoveCollectionModal renders name and fires onConfirm', async ({ page }) => {
  const r = await mountModal(page, CONFIRM, 'RemoveCollectionModal',
    { name: 'My Server' },
    ['onCancel', 'onConfirm'], 'Remove');
  expect(r.html).toContain('My Server');
  expect(r.calls).toContain('onConfirm');
  expect(r.errors, r.errors.join('; ')).toHaveLength(0);
});

test('NavErrorModal and PluginLoadingModal render their messages', async ({ page }) => {
  const nav = await mountModal(page, CONFIRM, 'NavErrorModal',
    { message: 'Could not navigate' }, ['onDismiss']);
  expect(nav.html).toContain('Could not navigate');
  expect(nav.errors, nav.errors.join('; ')).toHaveLength(0);

  const loading = await mountModal(page, CONFIRM, 'PluginLoadingModal',
    { message: 'Loading plugin X' }, []);
  expect(loading.html).toContain('Loading plugin X');
  expect(loading.errors, loading.errors.join('; ')).toHaveLength(0);
});

test('DeepLinkInstallModal renders kind/url and fires onInstall', async ({ page }) => {
  const r = await mountModal(page, CONFIRM, 'DeepLinkInstallModal',
    { kind: 'plugin', url: 'https://example.com/p.json' },
    ['onCancel', 'onInstall'], 'Install');
  expect(r.html).toContain('Install Plugin');
  expect(r.html).toContain('example.com/p.json');
  expect(r.calls).toContain('onInstall');
  expect(r.errors, r.errors.join('; ')).toHaveLength(0);
});

test('YoutubeFeedbackModal renders video title and fires onRespond', async ({ page }) => {
  const r = await mountModal(page, YT, 'YoutubeFeedbackModal',
    { url: 'https://youtu.be/abc', videoTitle: 'Some Music Video' },
    ['onRespond'], 'Yes');
  expect(r.html).toContain('Some Music Video');
  expect(r.calls).toContain('onRespond');
  expect(r.errors, r.errors.join('; ')).toHaveLength(0);
});
