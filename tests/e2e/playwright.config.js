import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  testDir: path.resolve(__dirname, 'specs'),
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:1420',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    cwd: path.resolve(__dirname, '../..'),
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
