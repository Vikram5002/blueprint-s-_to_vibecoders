import { describe, expect, it } from 'vitest';
import { checkDetails, parseServerUrl, parseUriList, relativeTo, summariseChecks } from './text';

const check = (stillPresent: boolean, line = 2) => ({
  ruleText: 'routes must not import db',
  line,
  snippet: "  import { q } from '../db';",
  lookedFor: '../db',
  stillPresent,
});

describe('parseServerUrl', () => {
  it('reads the address the CLI prints', () => {
    expect(parseServerUrl('...\n  Blueprint ready at  http://127.0.0.1:51234\n  (browser not opened)')).toBe('http://127.0.0.1:51234');
    expect(parseServerUrl('analysing 120 files...')).toBeNull();
  });
});

describe('parseUriList', () => {
  it('splits lines and drops comments and blanks', () => {
    expect(parseUriList('# from explorer\r\nfile:///d%3A/a.ts\r\n\r\nfile:///d%3A/b.ts\n')).toEqual(['file:///d%3A/a.ts', 'file:///d%3A/b.ts']);
  });
});

describe('relativeTo', () => {
  it('gives a forward-slash path inside the root, ignoring drive-letter case on Windows', () => {
    expect(relativeTo('D:\\proj', 'd:\\proj\\src\\a.ts')).toBe('src/a.ts');
    expect(relativeTo('/home/me/proj/', '/home/me/proj/src/a.ts')).toBe('src/a.ts');
  });

  it('refuses files outside the root, including a sibling with the same prefix', () => {
    expect(relativeTo('/home/me/proj', '/home/me/project2/a.ts')).toBeNull();
    expect(relativeTo('/home/me/proj', '/home/me/proj')).toBeNull();
  });
});

describe('summariseChecks', () => {
  it('says what the quick check found', () => {
    expect(summariseChecks([])).toMatch(/one you asked for/);
    expect(summariseChecks([check(false), check(false, 3)])).toBe('All 2 violating import(s) are gone (quick check).');
    expect(summariseChecks([check(false), check(true, 3)])).toBe('1 of 2 violating import(s) are gone; 1 still there (quick check).');
  });

  it('lists each violation with its outcome', () => {
    expect(checkDetails([check(true)])).toBe("STILL THERE - line 2: import { q } from '../db';  (routes must not import db)");
  });
});
