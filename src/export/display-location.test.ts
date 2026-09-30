import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayLocation, displayRoot } from './display-location.js';

const root = resolve('/work/shop');

describe('displayLocation', () => {
  it('writes a location inside the repository relative to it, with forward slashes', () => {
    expect(displayLocation(root, join(root, 'docs', 'rules.txt'))).toBe('docs/rules.txt');
  });

  it('reduces a location outside the repository to its file name', () => {
    expect(displayLocation(root, resolve('/home/someone/private/rules.txt'))).toBe('rules.txt');
  });

  it('leaves an already-relative location as it is', () => {
    expect(displayLocation(root, 'CLAUDE.md')).toBe('CLAUDE.md');
    expect(displayLocation(root, 'docs\\adr\\001.md')).toBe('docs/adr/001.md');
  });
});

describe('displayRoot', () => {
  it('keeps only the repository folder name', () => {
    expect(displayRoot(root)).toBe('shop');
    expect(displayRoot(`${root}/`)).toBe('shop');
  });
});
