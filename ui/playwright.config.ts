import { defineConfig } from '@playwright/test';

/**
 * E2E coverage for the workspace shell (ui/src/workspace/). No backend —
 * the shell renders placeholder content only, so tests run against the
 * plain Vite dev server with no mocking required.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
