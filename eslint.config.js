import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export const config = tseslint.config(
  {
    // Parser fixtures are deliberate specimens — some are syntactically broken
    // on purpose. They are inputs to tests, never compiled or linted.
    ignores: ['dist/**', 'node_modules/**', 'ui/**', 'coverage/**', 'src/parser/fixtures/**'],
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
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);

// ESLint requires a default export from its config file.
export default config;
