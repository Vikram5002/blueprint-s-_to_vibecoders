import { defineConfig } from 'vitest/config';

export const config = defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Walker tests touch the real filesystem; keep them off a shared fake timer.
    restoreMocks: true,
  },
});

// Vitest requires a default export from its config file. This is the only
// default export permitted in the repository (see CLAUDE.md conventions).
// eslint-disable-next-line no-restricted-syntax
export default config;
