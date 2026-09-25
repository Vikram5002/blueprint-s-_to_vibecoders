import { defineConfig } from 'vitest/config';

export const config = defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Walker tests touch the real filesystem; keep them off a shared fake timer.
    restoreMocks: true,
    // Never read or write the real "which Gemini key is used up today" file.
    env: { VIBE_GEMINI_KEY_STATE_PATH: 'off' },
  },
});

// Vitest requires a default export from its config file. This is the only
// default export permitted in the repository (see CLAUDE.md conventions).
// eslint-disable-next-line no-restricted-syntax
export default config;
