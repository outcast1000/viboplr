import { test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const mockPath = path.resolve(__dirname, '..', 'screenshot-mock.js');
const outDir = path.resolve(__dirname, '..', '..', '..', 'docs', 'assets', 'screenshots');

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});

async function setup(page) {
  await page.addInitScript({ path: mockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(800);
}

test.describe('Screenshots', () => {
  test('01 - hero', async ({ page }) => {
    await setup(page);
    await page.screenshot({ path: path.join(outDir, 'hero.png'), type: 'png' });
  });

  test('02 - playback', async ({ page }) => {
    await setup(page);
    // Double-click the first track to start playback
    const firstTrack = page.locator('.track-row').first();
    await firstTrack.dblClick();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, 'playback.png'), type: 'png' });
  });

  test('03 - library', async ({ page }) => {
    await setup(page);
    // Navigate to Artists view
    const artistsBtn = page.locator('.nav-btn', { hasText: 'Artists' });
    await artistsBtn.click();
    await page.waitForTimeout(400);
    // Click the first artist card to see artist detail
    const firstArtist = page.locator('.artist-card').first();
    await firstArtist.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'library.png'), type: 'png' });
  });

  test('04 - search', async ({ page }) => {
    await setup(page);
    // Focus and type in the central search
    const searchInput = page.locator('.central-search-container input');
    await searchInput.click();
    await searchInput.fill('Radiohead');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, 'search.png'), type: 'png' });
  });

  test('05 - servers', async ({ page }) => {
    await setup(page);
    // Navigate to Collections view
    const collectionsBtn = page.locator('.nav-btn', { hasText: 'Collections' });
    await collectionsBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'servers.png'), type: 'png' });
  });

  test('06 - mini-player', async ({ page }) => {
    await setup(page);
    // Start playback first
    const firstTrack = page.locator('.track-row').first();
    await firstTrack.dblClick();
    await page.waitForTimeout(500);
    // Resize to mini player dimensions
    await page.setViewportSize({ width: 500, height: 52 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'mini-player.png'), type: 'png' });
  });

  test('07 - keyboard', async ({ page }) => {
    await setup(page);
    // Click the "?" button in the CaptionBar to open keyboard shortcuts overlay
    const helpBtn = page.locator('button[title="Keyboard shortcuts"]');
    await helpBtn.click();
    await page.waitForSelector('.shortcuts-overlay');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'keyboard.png'), type: 'png' });
  });

  test('08 - skins', async ({ page }) => {
    await setup(page);
    // Open settings panel
    await page.locator('.settings-btn').click();
    await page.waitForSelector('.settings-overlay');
    // Click the Skins tab
    const skinsTab = page.locator('.settings-tab', { hasText: 'Skins' });
    await skinsTab.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'skins.png'), type: 'png' });
  });

  test('09 - discovery', async ({ page }) => {
    await setup(page);
    // Double-click a track to play it
    const firstTrack = page.locator('.track-row').first();
    await firstTrack.dblClick();
    await page.waitForTimeout(500);
    // Click the track title in the now-playing bar to open track detail view
    const npTitle = page.locator('.now-title').first();
    await npTitle.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, 'discovery.png'), type: 'png' });
  });

  test('10 - plugins', async ({ page }) => {
    await setup(page);
    // Open settings panel
    await page.locator('.settings-btn').click();
    await page.waitForSelector('.settings-overlay');
    // Click the Plugins tab
    const pluginsTab = page.locator('.settings-tab', { hasText: 'Plugins' });
    await pluginsTab.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'plugins.png'), type: 'png' });
  });
});
