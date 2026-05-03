import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(500);
});

test('no context banner when no tracks are playing', async ({ page }) => {
  await expect(page.locator('.queue-context-banner')).not.toBeVisible();
});

test('album play from search shows context banner with album name', async ({ page }) => {
  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);

  await page.locator('button').filter({ hasText: /^Albums/ }).first().click();
  await page.waitForTimeout(500);

  await expect(page.locator('.album-card')).toHaveCount(2);

  // Hover to reveal play button, then click
  const firstCard = page.locator('.album-card').first();
  await firstCard.hover();
  await firstCard.locator('.album-card-play-btn').click({ force: true });

  await expect(page.locator('.queue-context-banner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.queue-context-name')).toHaveText('Album X');
});

test('artist play from search shows context banner with artist name', async ({ page }) => {
  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);

  await page.locator('button').filter({ hasText: /^Artists/ }).first().click();
  await page.waitForTimeout(500);

  await expect(page.locator('.artist-card')).toHaveCount(2);

  const firstCard = page.locator('.artist-card').first();
  await firstCard.hover();
  await firstCard.locator('.album-card-play-btn').click({ force: true });

  await expect(page.locator('.queue-context-banner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.queue-context-name')).toHaveText('Artist A');
});

test('album detail Play All shows context banner', async ({ page }) => {
  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);

  await page.locator('button').filter({ hasText: /^Albums/ }).first().click();
  await page.waitForTimeout(500);

  // Navigate to album detail
  await page.locator('.album-card .album-card-body').first().click();
  await page.waitForTimeout(1000);

  // Click Play All
  await page.locator('.detail-art-play').click({ force: true });

  await expect(page.locator('.queue-context-banner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.queue-context-name')).toHaveText('Album X');
});

test('single track double-click does not show context banner', async ({ page }) => {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.locator('.entity-list-item').first().waitFor({ state: 'visible', timeout: 10000 });

  await page.locator('.entity-list-item').first().dblclick();
  await page.waitForTimeout(1000);

  // Single track play should not produce a context banner
  await expect(page.locator('.queue-context-banner')).not.toBeVisible();
});

test.skip('clearing queue removes context banner', async ({ page }) => {
  await page.locator('.search-view-input').fill('A');
  await page.waitForTimeout(1000);

  await page.locator('button').filter({ hasText: /^Albums/ }).first().click();
  await page.waitForTimeout(500);

  const firstCard = page.locator('.album-card').first();
  await firstCard.hover();
  await firstCard.locator('.album-card-play-btn').click({ force: true });

  await expect(page.locator('.queue-context-banner')).toBeVisible({ timeout: 5000 });

  // Use force:true to avoid crash from audio element teardown during clear
  await page.locator('button[title="Clear playlist"]').click({ force: true });

  await expect(page.locator('.queue-context-banner')).not.toBeVisible({ timeout: 5000 });
});
