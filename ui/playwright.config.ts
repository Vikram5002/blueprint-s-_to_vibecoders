import { defineConfig, devices } from '@playwright/test';

/** Browser checks for the architecture-analysis UI on this branch. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    // Use Chromium's modern headless mode; it runs from the full Chromium
    // binary and does not require Playwright's separate headless-shell archive.
    launchOptions: { channel: 'chromium' },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
