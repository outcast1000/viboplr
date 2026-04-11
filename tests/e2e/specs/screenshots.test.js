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

/** Wait for all external images (https://) to finish loading */
async function waitForImages(page, timeout = 10000) {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const external = imgs.filter(i => i.src.startsWith('https://'));
    return external.length === 0 || external.every(i => i.complete && i.naturalWidth > 0);
  }, { timeout }).catch(() => {});
}

/** Apply a skin by injecting its CSS variables */
const SKINS = {
  'arctic-light': {
    type: 'light',
    colors: { 'bg-primary': '#f5f5f7', 'bg-secondary': '#e8e8ed', 'bg-tertiary': '#dcdce1', 'bg-surface': '#d1d1d6', 'bg-hover': '#c7c7cc', 'text-primary': '#1d1d1f', 'text-secondary': '#6e6e73', 'text-tertiary': '#9e9ea3', 'accent': '#0071e3', 'accent-dim': '#0058b0', 'border': '#d2d2d7', 'now-playing-bg': '#f2f2f7', 'success': '#34c759', 'error': '#ff3b30', 'warning': '#ff9500' },
  },
  'viboplr': {
    type: 'dark',
    colors: { 'bg-primary': '#1a0a14', 'bg-secondary': '#2a1020', 'bg-tertiary': '#321028', 'bg-surface': '#3d1530', 'bg-hover': '#4a1a3a', 'text-primary': '#f0d0e0', 'text-secondary': '#b08098', 'text-tertiary': '#906078', 'accent': '#ff6b6b', 'accent-dim': '#e91e8a', 'border': '#3a1a2e', 'now-playing-bg': '#12060e', 'success': '#ff6b9d', 'error': '#ff4060', 'warning': '#ffb74d' },
  },
  'sunset': {
    type: 'dark',
    colors: { 'bg-primary': '#1c1018', 'bg-secondary': '#2a1520', 'bg-tertiary': '#341a28', 'bg-surface': '#3e1e2e', 'bg-hover': '#4d2538', 'text-primary': '#f0dce0', 'text-secondary': '#b89098', 'text-tertiary': '#907078', 'accent': '#ff7043', 'accent-dim': '#e64a19', 'border': '#3a2028', 'now-playing-bg': '#140a10', 'success': '#66bb6a', 'error': '#ef5350', 'warning': '#ffca28' },
  },
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

async function applySkin(page, skinId) {
  const skin = SKINS[skinId];
  const vars = Object.entries(skin.colors)
    .map(([k, v]) => {
      let line = `--${k}: ${v};`;
      if (k === 'accent' || k === 'now-playing-bg') line += ` --${k}-rgb: ${hexToRgb(v)};`;
      return line;
    })
    .join(' ');
  await page.addStyleTag({ content: `:root { ${vars} }` });
  await page.evaluate((type) => { document.documentElement.dataset.skinType = type; }, skin.type);
  await page.waitForTimeout(100);
}

/** Expand sidebar, click a nav button, then collapse sidebar */
async function sidebarNavigate(page, navText) {
  await page.locator('button[title="Expand sidebar"]').click();
  await page.waitForTimeout(400);
  await page.locator('.nav-btn', { hasText: navText }).click();
  await page.waitForTimeout(500);
  // Collapse — the button may already be gone if sidebar auto-collapsed
  const collapseBtn = page.locator('button[title="Collapse sidebar"]');
  if (await collapseBtn.isVisible().catch(() => false)) {
    await collapseBtn.click();
    await page.waitForTimeout(300);
  }
}

/** Navigate to Artists view and open a specific artist by index */
async function goToArtistDetail(page, artistIndex = 0) {
  await sidebarNavigate(page, 'Artists');
  await page.locator('.artist-card').nth(artistIndex).click();
  await page.waitForTimeout(500);
  await waitForImages(page);
}

test.describe('Screenshots', () => {
  test('01 - hero', async ({ page }) => {
    await setup(page);
    await page.screenshot({ path: path.join(outDir, 'hero.png'), type: 'png' });
  });

  test('02 - playback', async ({ page }) => {
    await setup(page);
    // Double-click the title cell of the first track to start playback
    const firstTitle = page.locator('.track-row .col-title').first();
    await firstTitle.dblclick();
    await page.waitForTimeout(600);
    await waitForImages(page);
    await page.screenshot({ path: path.join(outDir, 'playback.png'), type: 'png' });
  });

  test('03 - library', async ({ page }) => {
    await setup(page);
    await goToArtistDetail(page, 0);
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
    await sidebarNavigate(page, 'Collections');
    await page.screenshot({ path: path.join(outDir, 'servers.png'), type: 'png' });
  });

  test('06 - mini-player', async ({ page }) => {
    await setup(page);
    // Start playback first
    const firstTitle = page.locator('.track-row .col-title').first();
    await firstTitle.dblclick();
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
    // Open settings view
    await page.locator('.settings-btn').click();
    await page.waitForSelector('.settings-tab-bar');
    // Click the Skins tab
    const skinsTab = page.locator('.settings-tab', { hasText: 'Skins' });
    await skinsTab.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'skins.png'), type: 'png' });
  });

  test('09 - discovery', async ({ page }) => {
    await setup(page);
    // Double-click a track title to play it
    const firstTitle = page.locator('.track-row .col-title').first();
    await firstTitle.dblclick();
    await page.waitForTimeout(500);
    // Click the track title in the now-playing bar to open track detail view
    const npTitle = page.locator('.now-title').first();
    await npTitle.click();
    await page.waitForTimeout(600);
    await waitForImages(page);
    await page.screenshot({ path: path.join(outDir, 'discovery.png'), type: 'png' });
  });

  test('10 - plugins', async ({ page }) => {
    await setup(page);
    // Open settings view
    await page.locator('.settings-btn').click();
    await page.waitForSelector('.settings-tab-bar');
    // Click the Plugins tab
    const pluginsTab = page.locator('.settings-tab', { hasText: 'Plugins' });
    await pluginsTab.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'plugins.png'), type: 'png' });
  });

  test('11 - artist detail (Arctic Light)', async ({ page }) => {
    await setup(page);
    await applySkin(page, 'arctic-light');
    // Navigate to artist detail for a different artist (Massive Attack = index 3)
    await goToArtistDetail(page, 3);
    await page.screenshot({ path: path.join(outDir, 'detail-artist-light.png'), type: 'png' });
  });

  test('12 - album detail (Viboplr)', async ({ page }) => {
    await setup(page);
    await applySkin(page, 'viboplr');
    // Navigate to artist detail (Portishead = index 2), then click first album
    await goToArtistDetail(page, 2);
    const firstAlbum = page.locator('.album-card').first();
    await firstAlbum.click();
    await page.waitForTimeout(500);
    await waitForImages(page);
    await page.screenshot({ path: path.join(outDir, 'detail-album-viboplr.png'), type: 'png' });
  });

  test('13 - track detail (Sunset)', async ({ page }) => {
    await setup(page);
    await applySkin(page, 'sunset');
    // Play a track and open its detail view
    const firstTitle = page.locator('.track-row .col-title').first();
    await firstTitle.dblclick();
    await page.waitForTimeout(500);
    const npTitle = page.locator('.now-title').first();
    await npTitle.click();
    await page.waitForTimeout(600);
    await waitForImages(page);
    await page.screenshot({ path: path.join(outDir, 'detail-track-sunset.png'), type: 'png' });
  });
});
