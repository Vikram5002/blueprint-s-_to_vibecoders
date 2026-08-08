import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { GRAMMAR_KEYS, grammarKeyForPath, grammarPathFor, loadGrammar } from './grammars.js';

describe('grammarPathFor', () => {
  it('resolves a real file for every grammar', async () => {
    for (const key of GRAMMAR_KEYS) {
      const path = grammarPathFor(key);
      await expect(access(path), `${key} grammar missing at ${path}`).resolves.toBeUndefined();
    }
  });

  it('resolves relative to this module rather than the process cwd', async () => {
    // Absolute at the point of use is correct; what matters is that it is derived
    // from import.meta.url, so it survives being run from any directory.
    expect(isAbsolute(grammarPathFor('typescript'))).toBe(true);

    const source = await readFile(new URL('./grammars.ts', import.meta.url), 'utf8');
    expect(source).toContain('import.meta.url');
    expect(source).not.toContain('process.cwd()');
    // No drive letters or POSIX roots baked into the source.
    expect(source).not.toMatch(/['"][A-Za-z]:[\\/]/);
    expect(source).not.toMatch(/['"]\/(?:home|users|opt)\//i);
  });
});

describe('grammarKeyForPath', () => {
  it('selects the tsx grammar only for .tsx', () => {
    expect(grammarKeyForPath('src/component.tsx')).toBe('tsx');
    expect(grammarKeyForPath('src/module.ts')).toBe('typescript');
  });

  it('uses the javascript grammar for every JS extension', () => {
    expect(grammarKeyForPath('a.js')).toBe('javascript');
    expect(grammarKeyForPath('a.jsx')).toBe('javascript');
    expect(grammarKeyForPath('a.mjs')).toBe('javascript');
    expect(grammarKeyForPath('a.cjs')).toBe('javascript');
  });

  it('maps .py to the python grammar', () => {
    expect(grammarKeyForPath('a.py')).toBe('python');
  });

  it('is case-insensitive and returns null for unsupported extensions', () => {
    expect(grammarKeyForPath('Component.TSX')).toBe('tsx');
    expect(grammarKeyForPath('README.md')).toBeNull();
    expect(grammarKeyForPath('Makefile')).toBeNull();
  });
});

describe('loadGrammar', () => {
  it('loads each grammar and caches the result', async () => {
    for (const key of GRAMMAR_KEYS) {
      const first = await loadGrammar(key);
      expect(first.ok, `${key} failed to load`).toBe(true);
      if (!first.ok) continue;

      const second = await loadGrammar(key);
      expect(second.ok).toBe(true);
      if (!second.ok) continue;
      // Same Language instance — grammars are loaded once per process.
      expect(second.value).toBe(first.value);
    }
  }, 30_000);
});
