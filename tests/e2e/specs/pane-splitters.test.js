// The sidebar and queue have no collapse arrows: their splitters resize, and a
// drag past the pane's minimum collapses it — previewed during the drag,
// committed on release. Rules in src/utils/paneResize.ts (unit-tested); this
// drives the real pointer path.
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

const hasClass = (page, cls) => page.locator('.app').evaluate((el, c) => el.classList.contains(c), cls);
const sidebarWidth = async (page) => (await page.locator('.sidebar').boundingBox()).width;

async function dragSplitter(page, selector, toX, { hold, release = true } = {}) {
  const box = await page.locator(selector).boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(toX, y, { steps: 12 });
  if (hold) await hold();
  if (release) await page.mouse.up();
}

test('the sidebar resizes, previews a collapse, and collapses on release', async ({ page }) => {
  const splitter = '.pane-splitter--start';

  await dragSplitter(page, splitter, 280);
  await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(270);
  expect(await hasClass(page, 'sidebar-collapsed')).toBe(false);

  // Into the zone: held at the minimum, the pill says to keep going.
  await dragSplitter(page, splitter, 135, {
    hold: async () => {
      await expect(page.locator('.pane-splitter-pill')).toHaveText(/Keep dragging to collapse/);
    },
  });
  expect(await hasClass(page, 'sidebar-collapsed')).toBe(false);

  // Past the line: previewed, not applied, until release.
  await dragSplitter(page, splitter, 60, {
    hold: async () => {
      await expect(page.locator('.pane-splitter-pill')).toHaveText('Release to collapse');
      await expect(page.locator('.pane-splitter-preview')).toBeVisible();
      expect(await hasClass(page, 'sidebar-collapsed')).toBe(false);
    },
  });
  await expect.poll(() => hasClass(page, 'sidebar-collapsed')).toBe(true);
  await expect(page.locator('.pane-splitter-preview')).toHaveCount(0);

  // Out from the rail: a ghost previews the open, release opens it.
  await dragSplitter(page, splitter, 240, {
    hold: async () => {
      await expect(page.locator('.pane-splitter-ghost.armed')).toBeVisible();
      expect(await hasClass(page, 'sidebar-collapsed')).toBe(true);
    },
  });
  await expect.poll(() => hasClass(page, 'sidebar-collapsed')).toBe(false);
});

test('Escape cancels a drag and leaves the pane as it was', async ({ page }) => {
  const before = await sidebarWidth(page);
  await dragSplitter(page, '.pane-splitter--start', 60, {
    release: false,
    hold: async () => {
      await expect(page.locator('.pane-splitter-pill')).toHaveText('Release to collapse');
      await page.keyboard.press('Escape');
      await expect(page.locator('.pane-splitter-pill')).toHaveCount(0);
    },
  });
  await page.mouse.up();
  expect(await hasClass(page, 'sidebar-collapsed')).toBe(false);
  await expect.poll(() => sidebarWidth(page)).toBe(before);
});

test('the queue collapses by drag and reopens by double-click', async ({ page }) => {
  const right = page.viewportSize().width;
  await dragSplitter(page, '.pane-splitter--end', right - 60);
  await expect.poll(() => hasClass(page, 'queue-collapsed')).toBe(true);
  await expect(page.locator('.queue-panel.collapsed .queue-collapsed-strip')).toBeVisible();

  await page.locator('.pane-splitter--end').dblclick();
  await expect.poll(() => hasClass(page, 'queue-collapsed')).toBe(false);
});

test('the queue cannot be dragged so wide the main column disappears', async ({ page }) => {
  const viewport = page.viewportSize();
  await dragSplitter(page, '.pane-splitter--end', 20);
  const main = await page.locator('.main').boundingBox();
  expect(main.width).toBeGreaterThanOrEqual(359);
  expect(viewport.width).toBeGreaterThan(0);
});

test('the arrow buttons are gone', async ({ page }) => {
  await expect(page.locator('.sidebar-collapse-btn, .queue-collapse-btn')).toHaveCount(0);
});
