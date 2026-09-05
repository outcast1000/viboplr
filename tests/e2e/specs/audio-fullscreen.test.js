// Audio fullscreen is the Now Playing view, not a surface of its own.
//
// These assert the invariants that merge rests on. Each one is a bug that the
// two-surface version shipped or nearly did: fullscreen with no lyrics, the title
// drawn twice, two live copies of the view each holding a visualizer.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

/** Land on the Now Playing view with a track playing, which is what fullscreen
 *  needs. Reaching the track list mirrors screenshots.test.js `goToLibraryTracks`:
 *  SearchView only renders lists once a query has run, and `.track-row` only
 *  exists in Table view. */
async function setupNowPlaying(page) {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.locator('.nav .nav-btn').filter({ hasText: 'Library' }).click();
  await page.waitForTimeout(500);

  await page.locator('.search-view-input').fill('a');
  await page.waitForTimeout(700);
  await page.locator('.ds-tab', { hasText: 'Tracks' }).first().click();
  await page.waitForTimeout(400);
  const tableBtn = page.locator('button[title="Table view"]');
  if (await tableBtn.isVisible().catch(() => false)) {
    await tableBtn.click();
    await page.waitForTimeout(300);
  }

  await page.locator('.track-row').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.track-row .col-title').first().dblclick();
  await page.waitForTimeout(500);

  // Settle the duplicate-enqueue banner if the double-click raised one. Left
  // alone it auto-approves on a 5s countdown and re-renders mid-assertion.
  const cancelDupe = page.locator('.queue-duplicate-actions button', { hasText: 'Cancel' });
  if (await cancelDupe.isVisible().catch(() => false)) {
    await cancelDupe.click();
    await page.waitForTimeout(200);
  }

  await page.locator('.nav .nav-btn').filter({ hasText: 'Now Playing' }).click();
  await page.locator('.now-playing-view').waitFor({ state: 'visible', timeout: 10000 });
}

/** Enter fullscreen via the view's corner button — the affordance a user uses.
 *  Cmd+F has its own test below. */
async function enterFullscreen(page) {
  await page.locator('.np-action-btn[aria-label="Enter fullscreen"]').click();
  await expect(page.locator('.audio-fs')).toBeVisible({ timeout: 5000 });
}

test.beforeEach(async ({ page }) => {
  await setupNowPlaying(page);
});

test('fullscreen fills the screen with the Now Playing surface, not a bespoke stage', async ({ page }) => {
  await enterFullscreen(page);
  const overlay = page.locator('.audio-fs');

  // The whole point: the surface is the same component, in its fullscreen tier.
  await expect(overlay.locator('.now-playing-view--fs')).toBeVisible();
  // ...which brings the stage with it (art column, backdrop regime and all).
  await expect(overlay.locator('.np-art-col')).toBeVisible();
  // ...and the shared control bar, which is `display: none` unless this container
  // opts it in — there is no DOM `:fullscreen` ancestor here.
  await expect(overlay.locator('.fs-controls')).toBeVisible();
});

test('the corner action row is the same three buttons in both states', async ({ page }) => {
  // Windowed: picker, lyrics, and enter-fullscreen.
  await expect(page.locator('.now-playing-view .np-action-btn')).toHaveCount(3);
  await expect(page.locator('.now-playing-view .np-action-btn[aria-label="Enter fullscreen"]')).toHaveCount(1);

  await enterFullscreen(page);
  const overlay = page.locator('.audio-fs');

  // Fullscreen: the same row, same length, same order — only the third button
  // turns around. A row that lost an item on the way in would read as a glitch,
  // and nothing had to move into FullscreenControls to keep it whole.
  await expect(overlay.locator('.np-actions')).toBeVisible();
  await expect(overlay.locator('.np-action-btn')).toHaveCount(3);
  await expect(overlay.locator('.np-action-btn[aria-label="Choose visualizer"]')).toHaveCount(1);
  await expect(overlay.locator('.np-action-btn[aria-label="Exit fullscreen"]')).toHaveCount(1);
  await expect(overlay.locator('.np-action-btn[aria-label="Enter fullscreen"]')).toHaveCount(0);
});

test('the corner exit button leaves fullscreen', async ({ page }) => {
  await enterFullscreen(page);
  await page.locator('.audio-fs .np-action-btn[aria-label="Exit fullscreen"]').click();
  await expect(page.locator('.audio-fs')).toHaveCount(0);
  await expect(page.locator('.now-playing-view')).toBeVisible();
});

test('the fullscreen bar keeps exit and the queue button', async ({ page }) => {
  await enterFullscreen(page);
  const bar = page.locator('.audio-fs .fs-controls');

  // Exit stays. The restore control belongs at the right end of the control bar
  // in EVERY fullscreen, which is where the windowed bar's fullscreen button
  // just was — so there is one corner to look in either bar. It duplicating the
  // surface's corner row is accepted: that row fades with the artwork and reads
  // as part of the presentation, while the bar is the transport.
  await expect(bar.locator('button[title="Exit fullscreen"]')).toHaveCount(1);
  // Queue is back: it used to be dropped as a second route to the edge-reveal
  // gesture, but the gesture is invisible (issue #123's reporter read the drawer
  // as broken) — the button is the discoverable route, the gesture the fast path.
  await expect(bar.locator('button[title="Queue"]')).toHaveCount(1);
  // The rest of the bar is untouched. Prefix match: the real title carries the
  // shortcut hint ("Play / Pause (Space)"), so an exact `[title="Play / Pause"]`
  // matches nothing — as this assertion silently did until the Exit expectation
  // above stopped failing first and let execution reach it.
  await expect(bar.locator('button[title^="Play / Pause"]')).toHaveCount(1);
});

test('the bar queue button pins the drawer open until toggled again', async ({ page }) => {
  await enterFullscreen(page);
  const app = page.locator('.app');
  const revealed = () => app.evaluate((el) => el.classList.contains('fs-queue-revealed'));
  const queueBtn = page.locator('.audio-fs .fs-controls button[title="Queue"]');

  await queueBtn.click();
  await expect.poll(revealed).toBe(true);
  await expect(queueBtn).toHaveClass(/active/);

  // Pinned means pinned: moving the pointer away — which hides an edge-revealed
  // drawer — leaves it up.
  const { width, height } = page.viewportSize();
  await page.mouse.move(Math.round(width / 4), Math.round(height / 2));
  await page.waitForTimeout(200);
  expect(await revealed()).toBe(true);

  await queueBtn.click();
  await expect.poll(revealed).toBe(false);
});

test('Cmd+P toggles the drawer in fullscreen instead of the collapsed flag', async ({ page }) => {
  // In the grid, Cmd+P collapses the panel; in fullscreen the collapsed flag is
  // invisible (the drawer always renders expanded), so the same intent — "show /
  // hide the queue" — routes to the drawer pin. Without this a keyboard user has
  // no way to open the queue in fullscreen at all: the edge gesture is
  // pointer-only.
  await enterFullscreen(page);
  const app = page.locator('.app');
  const revealed = () => app.evaluate((el) => el.classList.contains('fs-queue-revealed'));

  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(revealed).toBe(true);
  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(revealed).toBe(false);

  // ...and the persisted collapsed state was never touched: back in the grid the
  // panel is still expanded.
  await page.keyboard.press('Escape');
  await expect(page.locator('.audio-fs')).toHaveCount(0);
  await expect(page.locator('.queue-panel.collapsed')).toHaveCount(0);
});

test("the bar's exit button leaves fullscreen", async ({ page }) => {
  // Distinct from 'the corner exit button leaves fullscreen' above: this surface
  // has two ways out and they are wired to different callbacks, so a regression
  // in either is invisible to the other's test.
  await enterFullscreen(page);
  await page.locator('.audio-fs .fs-controls button[title="Exit fullscreen"]').click();
  await expect(page.locator('.audio-fs')).toHaveCount(0);
  await expect(page.locator('.now-playing-view')).toBeVisible();
});

test('the queue reveals itself at the right edge and hides again', async ({ page }) => {
  await enterFullscreen(page);
  const app = page.locator('.app');
  const revealed = () => app.evaluate((el) => el.classList.contains('fs-queue-revealed'));

  // Parked: lifted above the overlay, but translated out of view.
  expect(await revealed()).toBe(false);
  const z = await page.locator('.queue-panel').evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(z)).toBeGreaterThan(999);

  const { width, height } = page.viewportSize();
  await page.mouse.move(width - 4, Math.round(height / 2));
  await expect.poll(revealed).toBe(true);

  // Hysteresis: still open while the pointer is inside the drawer...
  await page.mouse.move(width - 120, Math.round(height / 2));
  expect(await revealed()).toBe(true);

  // ...and only closes once it is clear of the whole drawer. One threshold would
  // flicker it every time the pointer crossed that single line.
  await page.mouse.move(Math.round(width / 2), Math.round(height / 2));
  await expect.poll(revealed).toBe(false);
});

test('a collapsed queue still renders the track list in the fullscreen drawer', async ({ page }) => {
  // The drawer CSS forces full --queue-width even when the grid column is the
  // collapsed 40px strip — but the strip CONTENT (vertical "Queue" label, no
  // list) used to render into it, so the drawer slid in looking empty
  // (issue #123). In fullscreen the panel must render expanded regardless of
  // the persisted collapsed state.
  await page.locator('.queue-collapse-btn').click();
  await expect(page.locator('.queue-panel.collapsed .queue-collapsed-strip')).toBeVisible();

  await enterFullscreen(page);
  const { width, height } = page.viewportSize();
  await page.mouse.move(width - 4, Math.round(height / 2));
  await expect
    .poll(() => page.locator('.app').evaluate((el) => el.classList.contains('fs-queue-revealed')))
    .toBe(true);

  const panel = page.locator('.queue-panel');
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(panel.locator('.queue-collapsed-strip')).toHaveCount(0);
  await expect(panel.locator('.queue-list .queue-item').first()).toBeVisible();

  // The preference is untouched: leaving fullscreen restores the strip.
  await page.keyboard.press('Escape');
  await expect(page.locator('.audio-fs')).toHaveCount(0);
  await expect(page.locator('.queue-panel.collapsed .queue-collapsed-strip')).toBeVisible();
});

test('leaving fullscreen forgets the revealed drawer', async ({ page }) => {
  await enterFullscreen(page);
  const { width, height } = page.viewportSize();
  await page.mouse.move(width - 4, Math.round(height / 2));
  await expect
    .poll(() => page.locator('.app').evaluate((el) => el.classList.contains('fs-queue-revealed')))
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('.audio-fs')).toHaveCount(0);
  // Fullscreen-only state: left set, it would be waiting on the next entry
  // before the pointer had asked for anything.
  await expect(page.locator('.app.fs-queue-revealed')).toHaveCount(0);
});

test('fullscreen does not draw the title twice', async ({ page }) => {
  // The in-grid view draws its own identity block...
  await expect(page.locator('.now-playing-view .np-meta')).toHaveCount(1);

  await enterFullscreen(page);
  const overlay = page.locator('.audio-fs');

  // ...but in fullscreen the control bar carries the title with clickable
  // artist/album links, so the view's block is suppressed rather than stacked.
  await expect(overlay.locator('.np-meta')).toHaveCount(0);
  await expect(overlay.locator('.np-tags')).toHaveCount(0);
  await expect(overlay.locator('.fs-title')).toBeVisible();
});

test('only one copy of the view is live at a time', async ({ page }) => {
  // The in-grid view is already open, so both would render if nothing dropped one.
  await expect(page.locator('.now-playing-view')).toHaveCount(1);
  await enterFullscreen(page);

  // Two mounts would each run the tag lookup and each hold a visualizer instance
  // whose IntersectionObserver still reports it on screen — the second painting
  // behind an opaque overlay.
  await expect(page.locator('.now-playing-view')).toHaveCount(1);
  await expect(page.locator('.now-playing-view--fs')).toHaveCount(1);
});

test('Cmd+F toggles fullscreen, and Escape leaves it', async ({ page }) => {
  await page.keyboard.press('Meta+f');
  await expect(page.locator('.audio-fs')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.now-playing-view--fs')).toHaveCount(1);

  // Same key, same intent, back out again.
  await page.keyboard.press('Meta+f');
  await expect(page.locator('.audio-fs')).toHaveCount(0);

  await page.keyboard.press('Meta+f');
  await expect(page.locator('.audio-fs')).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.audio-fs')).toHaveCount(0);

  // Back to exactly one copy, this time the windowed one.
  await expect(page.locator('.now-playing-view')).toBeVisible();
  await expect(page.locator('.now-playing-view--fs')).toHaveCount(0);
});
