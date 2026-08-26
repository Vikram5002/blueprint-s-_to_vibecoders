import { defineConfig } from 'vitest/config';

/**
 * Scoped to src/ only — e2e/ holds Playwright specs, which vitest's default
 * glob would otherwise also try (and fail) to pick up.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
