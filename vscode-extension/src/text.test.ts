import { describe, expect, it } from 'vitest';
import { checkDetails, parseServerUrl, parseUriList, relativeTo, summariseChecks, workspaceHtml } from './text';

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

describe('workspaceHtml', () => {
  it('frames the server workspace and allows framing only that server', () => {
    const html = workspaceHtml({ origin: 'http://127.0.0.1:5123', page: 'http://127.0.0.1:5123/workspace.html' });
    expect(html).toContain('<iframe src="http://127.0.0.1:5123/workspace.html"');
    expect(html).toContain("default-src 'none'; frame-src http://127.0.0.1:5123;");
    expect(html).not.toContain('<script');
  });

  it('shows a status line while starting, and the reason when the server failed, escaped', () => {
    expect(workspaceHtml({ loading: 'Starting VibeCoder for app...' })).toContain('Starting VibeCoder for app...');
    const failed = workspaceHtml({ error: 'npx <not found>' });
    expect(failed).toContain('VibeCoder could not start: npx &lt;not found&gt;');
    expect(failed).toContain("frame-src 'none'");
  });
});
