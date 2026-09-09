// Playlist detail editing: drag-to-reorder within a user playlist.
// The reorder drag is the WKWebView raw-mouse pattern (no HTML5 DnD), so the
// gesture is driven with page.mouse in explicit steps.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.locator('.nav .nav-btn').filter({ hasText: 'Playlists' }).click();
  await page.waitForTimeout(500);
});

async function openMyMix(page) {
  // The mock serves one user playlist ("My Mix"). Open its detail view from
  // whichever list mode the persisted settings landed on.
  const card = page.locator('.playlist-card', { hasText: 'My Mix' });
  const row = page.locator('.entity-list-item, .entity-table-row', { hasText: 'My Mix' });
  if (await card.count()) await card.first().click();
  else await row.first().click();
  await page.waitForSelector('.playlists-track-list');
  await page.waitForTimeout(300);
}

function rowTitles(page) {
  return page.locator('.playlists-track-list .entity-list-name').allInnerTexts();
}

test('playlist detail lists the tracks in stored order', async ({ page }) => {
  await openMyMix(page);
  expect(await rowTitles(page)).toEqual(['PL One', 'PL Two', 'PL Three', 'PL Four']);
});

test('drag reorders a row within a user playlist', async ({ page }) => {
  await openMyMix(page);

  const rows = page.locator('.playlists-track-list [data-pl-index]');
  await expect(rows).toHaveCount(4);

  const first = await rows.nth(0).boundingBox();
  const third = await rows.nth(2).boundingBox();

  // Drag row 0 ("PL One") to below row 2's midpoint → insert before index 3.
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  // Cross the 5px threshold in small steps so the mousemove listeners fire.
  await page.mouse.move(first.x + first.width / 2 + 10, first.y + first.height / 2 + 10, { steps: 4 });
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * 0.8, { steps: 8 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(300);

  // The optimistic UI shows the new order…
  expect(await rowTitles(page)).toEqual(['PL Two', 'PL Three', 'PL One', 'PL Four']);

  // …and the backend command received the full permutation.
  const calls = await page.evaluate(() => window.__TEST_REORDER_CALLS__ || []);
  expect(calls).toHaveLength(1);
  expect(calls[0].playlistId).toBe(100);
  expect(calls[0].orderedIds).toEqual([12, 13, 11, 14]);
});

test('drag onto the queue panel still enqueues (handoff)', async ({ page }) => {
  await openMyMix(page);

  const rows = page.locator('.playlists-track-list [data-pl-index]');
  const first = await rows.nth(0).boundingBox();
  const queue = await page.locator('.queue-panel').boundingBox();

  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2 + 10, first.y + first.height / 2 + 10, { steps: 4 });
  await page.mouse.move(queue.x + queue.width / 2, queue.y + queue.height / 2, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(300);

  // The dragged track landed in the queue…
  await expect(page.locator('.queue-item')).toHaveCount(1);
  // …and the playlist itself was NOT reordered.
  const calls = await page.evaluate(() => window.__TEST_REORDER_CALLS__ || []);
  expect(calls).toHaveLength(0);
});

test('a filtered playlist explains why a reorder drop did nothing', async ({ page }) => {
  await openMyMix(page);

  // Activate the in-playlist search so the visible rows leave natural order.
  await page.locator('input[placeholder="Search this playlist..."]').fill('PL');
  await page.waitForTimeout(300);

  const rows = page.locator('.playlists-track-list [data-pl-index]');
  const first = await rows.nth(0).boundingBox();
  const third = await rows.nth(2).boundingBox();

  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * 0.8, { steps: 8 });
  await page.waitForTimeout(100);
  await page.mouse.up();

  await expect(page.locator('.toast')).toContainText('clear the search, sort and filters');
  const calls = await page.evaluate(() => window.__TEST_REORDER_CALLS__ || []);
  expect(calls).toHaveLength(0);
});

test('sort is per-playlist: it sticks on reopen, and clearing it re-enables reorder', async ({ page }) => {
  await openMyMix(page);

  // Apply a Title sort in the detail sort bar. Scope to .playlists-view — the
  // Library view stays mounted and carries its own hidden sort bar.
  await page.locator('.playlist-detail-toolbar .sort-bar-toggle').click();
  await page.locator('.playlists-view .sort-bar-group .sort-btn', { hasText: 'Title' }).first().click();
  await page.waitForTimeout(200);
  expect(await rowTitles(page)).toEqual(['PL Four', 'PL One', 'PL Three', 'PL Two']);
  // The "#" column keeps showing each row's REAL stored position under the sort.
  expect(await page.locator('.playlists-track-list [data-pl-index] .pl-track-num').allInnerTexts())
    .toEqual(['4', '1', '3', '2']);

  // Leave and reopen — the chain belongs to this playlist and comes back.
  await page.locator('.detail-hero-back, .hero-back, [aria-label="Back"]').first().click();
  await page.waitForTimeout(300);
  await openMyMix(page);
  expect(await rowTitles(page)).toEqual(['PL Four', 'PL One', 'PL Three', 'PL Two']);

  // Clear the sort → natural order → a reorder drag lands again.
  await page.locator('.playlist-detail-toolbar .sort-bar-toggle').click();
  await page.locator('.playlists-view .sort-btn-clear').click();
  await page.waitForTimeout(200);
  expect(await rowTitles(page)).toEqual(['PL One', 'PL Two', 'PL Three', 'PL Four']);

  const rows = page.locator('.playlists-track-list [data-pl-index]');
  const first = await rows.nth(0).boundingBox();
  const third = await rows.nth(2).boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * 0.8, { steps: 8 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await rowTitles(page)).toEqual(['PL Two', 'PL Three', 'PL One', 'PL Four']);
});

test('sorting by "#" ascending still allows drag-to-reorder', async ({ page }) => {
  await openMyMix(page);

  // "# asc" IS the stored order, so the reorder gate must stay open.
  await page.locator('.playlist-detail-toolbar .sort-bar-toggle').click();
  await page.locator('.playlists-view .sort-bar-group .sort-btn', { hasText: '#' }).first().click();
  await page.waitForTimeout(200);
  expect(await rowTitles(page)).toEqual(['PL One', 'PL Two', 'PL Three', 'PL Four']);

  // Collapse the sort bar again and let its max-height transition finish —
  // rows shift down while it animates, which would invalidate the boxes below.
  await page.locator('.playlist-detail-toolbar .sort-bar-toggle').click();
  await page.waitForTimeout(500);

  const rows = page.locator('.playlists-track-list [data-pl-index]');
  const first = await rows.nth(0).boundingBox();
  const third = await rows.nth(2).boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * 0.8, { steps: 8 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(300);

  expect(await rowTitles(page)).toEqual(['PL Two', 'PL Three', 'PL One', 'PL Four']);
  // Numbers follow the new stored order (optimistic renumber).
  expect(await page.locator('.playlists-track-list [data-pl-index] .pl-track-num').allInnerTexts())
    .toEqual(['1', '2', '3', '4']);
});

test('drag shows the insert indicator while over a row', async ({ page }) => {
  await openMyMix(page);

  const rows = page.locator('.playlists-track-list [data-pl-index]');
  const first = await rows.nth(0).boundingBox();
  const third = await rows.nth(2).boundingBox();

  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * 0.2, { steps: 8 });
  await page.waitForTimeout(100);

  await expect(page.locator('.playlists-track-list .pl-reorder-before')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.playlists-track-list .pl-reorder-before')).toHaveCount(0);
});

// Issue #129: the hover action tray sat over the row's trailing duration ("a
// small over button card on the track time text"). It is now anchored to a
// zero-width slot in front of that meta cell, which is a *layout* fact — no
// unit tier can see it, so it is asserted here with real boxes.
test('the hover action tray does not cover the row duration', async ({ page }) => {
  await openMyMix(page);

  const row = page.locator('.playlists-track-list [data-pl-index]').nth(1);
  const box = await row.boundingBox();
  // Hover the row's left half: over the tray itself the pointer would still
  // reveal it, but a *user* reading the duration hovers the row, not the tray.
  await page.mouse.move(box.x + 40, box.y + box.height / 2);

  const tray = row.locator('.row-hover-actions');
  const meta = row.locator('.entity-list-count');
  await expect(tray).toBeVisible();
  await expect(meta).toBeVisible();

  const trayBox = await tray.boundingBox();
  const metaBox = await meta.boundingBox();
  expect(trayBox.width).toBeGreaterThan(0);
  expect(trayBox.x + trayBox.width).toBeLessThanOrEqual(metaBox.x);
});

// The corollary: buying that clearance must not have cost the row any width.
// The slot cancels its own flex gap, so the duration sits where it always did.
test('the tray slot costs the row no layout', async ({ page }) => {
  await openMyMix(page);

  const rows = page.locator('.playlists-track-list [data-pl-index]');
  const first = await rows.nth(0).boundingBox();
  const metaBefore = await rows.nth(0).locator('.entity-list-count').boundingBox();

  // Hovering reveals the tray; the meta must not move when it appears.
  await page.mouse.move(first.x + 40, first.y + first.height / 2);
  await expect(rows.nth(0).locator('.row-hover-actions')).toBeVisible();
  const metaAfter = await rows.nth(0).locator('.entity-list-count').boundingBox();

  expect(Math.round(metaAfter.x)).toBe(Math.round(metaBefore.x));
});
