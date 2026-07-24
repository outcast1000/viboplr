import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

// Extra local tracks served only for the quiz's random-pool fetch
// (get_tracks with sortField "random"), so the game is startable without
// changing the shared TEST_TRACKS counts other specs assert on.
const QUIZ_POOL = Array.from({ length: 8 }, (_, i) => ({
  id: 100 + i,
  key: `lib:${100 + i}`,
  path: `file:///music/Quiz/${i} Song.mp3`,
  title: `Quiz Song ${i}`,
  artist_id: 1,
  artist_name: `Quiz Artist ${i % 3}`,
  album_id: 1,
  album_title: 'Quiz Album',
  year: 2021,
  track_number: i + 1,
  duration_secs: 200,
  format: 'mp3',
  file_size: 1000,
  collection_id: 1,
  collection_name: 'Music',
  liked: 0,
  added_at: 1700000000,
  modified_at: 1700000000,
}));

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((pool) => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = function (cmd, args, ...rest) {
      if (cmd === 'get_tracks' && args && args.opts && args.opts.sortField === 'random') {
        return Promise.resolve(pool);
      }
      // Seed a persisted best score so the UI display is assertable.
      if (cmd === 'plugin:store|get' && args && args.key === 'quizBestScores') {
        return Promise.resolve([{ easy: 7 }, true]);
      }
      return original.call(this, cmd, args, ...rest);
    };
  }, QUIZ_POOL);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  // The quiz is a supporter easter egg: no sidebar entry — reached via the
  // viboplr://quiz deep link or the row at the end of Settings > Debug.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.ds-tab', { hasText: 'Debug' }).click();
  await page.locator('.settings-row', { hasText: 'Song Quiz' }).getByRole('button', { name: 'Open' }).click();
});

test('song quiz has no sidebar entry (supporter easter egg)', async ({ page }) => {
  await expect(page.locator('.sidebar .nav-btn-label', { hasText: 'Song Quiz' })).toHaveCount(0);
  // …but the Settings > Debug entry did land us on the game.
  await expect(page.locator('.quiz-splash h1')).toHaveText('Song Quiz');
});

async function startEasyGame(page) {
  await page.locator('.quiz-mode-card', { hasText: 'Easy' }).click();
  await expect(page.locator('.quiz-answer')).toHaveCount(4);
}

test('song quiz splash shows the three modes with stored best scores', async ({ page }) => {
  await expect(page.locator('.quiz-splash h1')).toHaveText('Song Quiz');
  await expect(page.locator('.quiz-mode-card')).toHaveCount(3);
  await expect(page.locator('.quiz-mode-card', { hasText: 'Easy' }).locator('.quiz-mode-best')).toHaveText('Best: 7');
  await expect(page.locator('.quiz-mode-card', { hasText: 'Hard' }).locator('.quiz-mode-best')).toHaveText('Best: —');
});

test('starting a game shows the clock, score and four answers', async ({ page }) => {
  await startEasyGame(page);
  await expect(page.locator('.quiz-clock')).toHaveText(/[12]:\d{2}/);
  await expect(page.locator('.quiz-hud-stat', { hasText: 'Score' })).toContainText('0');
  await expect(page.locator('.quiz-mode-chip')).toHaveText('Easy');
  await expect(page.locator('.quiz-question-lozenge')).toContainText('Which song is this?');
});

test('answering locks in and reveals the correct option', async ({ page }) => {
  await startEasyGame(page);
  await page.locator('.quiz-answer').first().click();
  // Lock-in suspense (~1.2s) then the correct answer flashes green.
  await expect(page.locator('.quiz-answer.correct')).toHaveCount(1, { timeout: 8000 });
});

test('fifty-fifty removes two answers and is spent for the run', async ({ page }) => {
  await startEasyGame(page);
  await page.locator('.quiz-lifeline', { hasText: '50:50' }).click();
  await expect(page.locator('.quiz-answer.eliminated')).toHaveCount(2);
  await expect(page.locator('.quiz-lifeline', { hasText: '50:50' })).toBeDisabled();
});

test('skipping costs time and loads a new question', async ({ page }) => {
  await startEasyGame(page);
  await page.locator('.quiz-lifeline', { hasText: 'Skip' }).click();
  await expect(page.locator('.quiz-time-delta')).toHaveText('−3s');
  await expect(page.locator('.quiz-answer')).toHaveCount(4);
});

test('very long titles ellipsize instead of growing the answer buttons', async ({ page }) => {
  // Swap the pool for one with absurdly long titles/artists before starting.
  await page.evaluate(() => {
    const longPool = Array.from({ length: 8 }, (_, i) => ({
      id: 200 + i,
      key: `lib:${200 + i}`,
      path: `file:///music/Quiz/long-${i}.mp3`,
      title: `An Extraordinarily Long And Winding Song Title That Never Seems To End ${i} (Extended Remaster Deluxe Anniversary Edition)`,
      artist_id: 1,
      artist_name: `The Incredibly Verbose Orchestra Of Perpetually Long Names ${i}`,
      album_id: 1,
      album_title: 'Quiz Album',
      year: 2021,
      track_number: i + 1,
      duration_secs: 200,
      format: 'mp3',
      file_size: 1000,
      collection_id: 1,
      collection_name: 'Music',
      liked: 0,
      added_at: 1700000000,
      modified_at: 1700000000,
    }));
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = function (cmd, args, ...rest) {
      if (cmd === 'get_tracks' && args && args.opts && args.opts.sortField === 'random') {
        return Promise.resolve(longPool);
      }
      return original.call(this, cmd, args, ...rest);
    };
  });
  await startEasyGame(page);

  const gridBox = await page.locator('.quiz-answers').boundingBox();
  const viewport = page.viewportSize();
  for (const answer of await page.locator('.quiz-answer').all()) {
    const box = await answer.boundingBox();
    // Buttons must stay inside the answers grid / viewport (1px rounding slack).
    expect(box.x).toBeGreaterThanOrEqual(gridBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(gridBox.x + gridBox.width + 1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  }
});

test('ending the run shows the final score and mode best', async ({ page }) => {
  await startEasyGame(page);
  await page.locator('.quiz-hud', { hasText: 'Score' }).getByRole('button', { name: 'End run' }).click();
  await expect(page.locator('.quiz-splash h1')).toHaveText('Run ended');
  await expect(page.locator('.quiz-result-score')).toContainText('0');
  await expect(page.locator('.quiz-result-answer')).toContainText('Best on Easy: 7');
  // Back to the mode picker.
  await page.getByRole('button', { name: 'Change mode' }).click();
  await expect(page.locator('.quiz-mode-card')).toHaveCount(3);
});
