import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// ui/ is excluded from the root eslint.config.js (see its `ignores` list) —
// this is the config that actually covers it. Mirrors the root project's
// conventions (CLAUDE.md: strict TS, no `any`, named exports only) plus the
// React-specific rules a Vite/React app needs.
export const config = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // CLAUDE.md: no `any` — use `unknown` and narrow.
      '@typescript-eslint/no-explicit-any': 'error',
      // CLAUDE.md: named exports only.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Named exports only (CLAUDE.md conventions).',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Same carve-out this file takes for itself (see the bottom of this
    // file): Vite requires its config's default export, same as the root
    // eslint.config.js requires ESLint's.
    files: ['vite.config.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);

// ESLint requires a default export from its config file.
export default config;
