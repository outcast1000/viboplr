import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

// Mock durable-like key for the first test track ("First Song" / "Artist A"),
// normalized the same way build_entity_key does (lowercased).
const LIKE_KEY = 'track:artist a:first song';

// Reads the mock durable like store (mirrors the backend entity_likes table).
const readLike = (page) =>
  page.evaluate((k) => (window.__TEST_LIKES__ || {})[k] ?? 0, LIKE_KEY);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Library' }).click();
  await page.locator('.entity-list-item').first().waitFor({ state: 'visible', timeout: 10000 });
});

test('now-playing bar like cycles through tri-state and persists to the durable store', async ({ page }) => {
  // Play the first track so it becomes the now-playing track.
  await page.locator('.entity-list-item').first().dblclick();
  await expect(page.locator('.now-title')).toContainText('First Song');

  const likeBtn = page.locator('.now-like-col button');
  await expect(likeBtn).toBeVisible();

  // Neutral → like (1): the durable store records a liked row.
  await likeBtn.click();
  await expect.poll(() => readLike(page)).toBe(1);

  // Like → dislike (-1): one deterministic cycle step (the bar's like control
  // is a single cycling button: neutral → like → dislike → neutral).
  await likeBtn.click();
  await expect.poll(() => readLike(page)).toBe(-1);

  // Dislike → neutral (0): the durable row is DELETEd (mock, like the backend,
  // removes the row at liked == 0).
  await likeBtn.click();
  await expect.poll(() => readLike(page)).toBe(0);
});
