import { describe, expect, it } from 'vitest';
import { detectLanguage, SUPPORTED_EXTENSIONS } from './language.js';

describe('detectLanguage', () => {
  it('detects every extension listed in the Phase 1 spec', () => {
    expect(detectLanguage('a.ts')).toBe('typescript');
    expect(detectLanguage('a.tsx')).toBe('typescript');
    expect(detectLanguage('a.js')).toBe('javascript');
    expect(detectLanguage('a.jsx')).toBe('javascript');
    expect(detectLanguage('a.mjs')).toBe('javascript');
    expect(detectLanguage('a.cjs')).toBe('javascript');
    expect(detectLanguage('a.py')).toBe('python');
  });

  it('exposes exactly the spec extension list', () => {
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual(
      ['.cjs', '.js', '.jsx', '.mjs', '.py', '.ts', '.tsx'].sort(),
    );
  });

  it('is case-insensitive', () => {
    expect(detectLanguage('Component.TSX')).toBe('typescript');
    expect(detectLanguage('SCRIPT.PY')).toBe('python');
  });

  it('returns null for unsupported and extensionless files', () => {
    expect(detectLanguage('README.md')).toBeNull();
    expect(detectLanguage('main.go')).toBeNull();
    expect(detectLanguage('Makefile')).toBeNull();
    expect(detectLanguage('.gitignore')).toBeNull();
  });

  it('uses the final extension of a multi-part name', () => {
    expect(detectLanguage('walk.test.ts')).toBe('typescript');
    expect(detectLanguage('vite.config.js')).toBe('javascript');
  });
});
