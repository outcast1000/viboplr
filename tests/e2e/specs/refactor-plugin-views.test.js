// E2E coverage for the PluginViewRenderer refactor: leaf renderers extracted to
// pluginViews/pluginViews.tsx, sanitizeHTML moved to pluginViews/htmlSanitize.ts
// (re-exported from PluginViewRenderer for renderers/* consumers). The recursive
// PluginViewNode dispatcher stays in PluginViewRenderer.tsx.
//
// Plugin views are only driven by an active plugin in normal flow, so we mount
// PluginViewRenderer directly in the live Vite webview via dynamic import.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

// Mounts PluginViewRenderer with the given PluginViewData and returns probe data.
async function mountPluginView(page, data) {
  return page.evaluate(async (data) => {
    const errors = [];
    window.addEventListener('error', (e) => errors.push(String(e.message)));
    const reactDomMod = await import('/@id/react-dom/client');
    const ReactDOM = reactDomMod.createRoot ? reactDomMod : reactDomMod.default;
    const reactMod = await import('/@id/react');
    const createElement = reactMod.createElement ?? reactMod.default.createElement;
    const mod = await import('/src/components/PluginViewRenderer.tsx');

    const div = document.createElement('div');
    div.setAttribute('data-harness', 'plugin-view');
    document.body.appendChild(div);

    ReactDOM.createRoot(div).render(
      createElement(mod.PluginViewRenderer, {
        pluginName: 'TestPlugin',
        data,
        currentTrack: null,
        onAction: () => {},
      })
    );
    await new Promise((r) => setTimeout(r, 300));
    const root = document.querySelector('[data-harness="plugin-view"]');
    return { html: root ? root.innerHTML : '', errors };
  }, data);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
});

test('stats-grid node renders via extracted PluginStatsGrid', async ({ page }) => {
  const r = await mountPluginView(page, {
    type: 'stats-grid',
    items: [
      { label: 'Plays', value: 42 },
      { label: 'Rank', value: '#7' },
    ],
  });
  expect(r.html).toContain('Plays');
  expect(r.html).toContain('42');
  expect(r.html).toContain('#7');
  expect(r.errors, `page errors: ${r.errors.join('; ')}`).toHaveLength(0);
});

test('text node renders through the re-exported sanitizeHTML', async ({ page }) => {
  const r = await mountPluginView(page, {
    type: 'text',
    // <b> is allowed; <script> is stripped by sanitizeHTML.
    content: 'Hello <b>bold</b> <script>alert(1)</script>world',
  });
  expect(r.html).toContain('<b>bold</b>');
  expect(r.html).not.toContain('<script>');
  expect(r.errors, `page errors: ${r.errors.join('; ')}`).toHaveLength(0);
});

test('loading node renders via extracted PluginLoading', async ({ page }) => {
  const r = await mountPluginView(page, { type: 'loading', message: 'Fetching things' });
  expect(r.html).toContain('Fetching things');
  expect(r.errors, `page errors: ${r.errors.join('; ')}`).toHaveLength(0);
});

test('layout node recurses through PluginViewNode into child renderers', async ({ page }) => {
  const r = await mountPluginView(page, {
    type: 'layout',
    direction: 'vertical',
    children: [
      { type: 'text', content: 'Section A' },
      { type: 'stats-grid', items: [{ label: 'Count', value: 3 }] },
    ],
  });
  // Both children render -> dispatcher recursion + extracted renderers cooperate.
  expect(r.html).toContain('Section A');
  expect(r.html).toContain('Count');
  expect(r.html).toContain('3');
  expect(r.errors, `page errors: ${r.errors.join('; ')}`).toHaveLength(0);
});
