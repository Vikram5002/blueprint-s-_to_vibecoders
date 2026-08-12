import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export const config = tseslint.config(
  {
    // Parser fixtures are deliberate specimens — some are syntactically broken
    // on purpose. They are inputs to tests, never compiled or linted.
    ignores: [
      'dist/**',
      'node_modules/**',
      // Working directory: the database, caches, and — during a corpus run —
      // full clones of other people's repositories. Linting those reports
      // thousands of errors in code this project does not own, and turns
      // `npm run lint` into a coin flip depending on whether collection is
      // running.
      '.vibe/**',
      'ui/**',
      'coverage/**',
      'src/parser/fixtures/**',
      'src/graph/fixtures/**',
      // Built UI bundle, not source.
      'src/server/static/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
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
    // Architectural rule 1: the determinism boundary.
    files: ['src/parser/**/*.ts', 'src/graph/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/llm/**', '**/llm'],
              message:
                'parser/ and graph/ must never import from llm/. This is the determinism boundary (CLAUDE.md rule 1).',
            },
          ],
        },
      ],
    },
  },
  {
    // Architectural rule 6: no network calls outside llm/.
    files: ['src/**/*.ts'],
    ignores: ['src/llm/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'No network calls outside llm/ (CLAUDE.md rule 6).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:http', message: 'No outbound network calls outside llm/ (CLAUDE.md rule 6). The local server is the only exception and lives in src/server/.' },
            { name: 'node:https', message: 'No network calls outside llm/ (CLAUDE.md rule 6).' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: {
      // The local server binds 127.0.0.1; it is allowed to use node:http.
      'no-restricted-imports': 'off',
    },
  },
  {
    // Server tests drive the API by calling their own loopback server. That is
    // not the outbound network access rule 6 exists to prevent, and the
    // exemption is kept to test files so the server itself stays covered.
    files: ['src/server/**/*.test.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Plain Node build scripts: no TypeScript, so no-undef is live and needs
    // the runtime globals declared.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);

// ESLint requires a default export from its config file.
export default config;
