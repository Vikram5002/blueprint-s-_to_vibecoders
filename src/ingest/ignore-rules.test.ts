import { describe, expect, it } from 'vitest';
import { ALWAYS_SKIPPED_DIRECTORIES, createIgnoreMatcher, isAlwaysSkipped, isIgnored } from './ignore-rules.js';

describe('isAlwaysSkipped', () => {
  it('covers every directory named in the Phase 1 spec', () => {
    for (const name of ['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv']) {
      expect(isAlwaysSkipped(name)).toBe(true);
    }
  });

  it('also skips this tool\'s own state directory', () => {
    expect(ALWAYS_SKIPPED_DIRECTORIES.has('.vibe')).toBe(true);
  });

  it('does not skip ordinary directories', () => {
    expect(isAlwaysSkipped('src')).toBe(false);
    expect(isAlwaysSkipped('distribution')).toBe(false);
  });
});

describe('isIgnored', () => {
  const rootMatcher = createIgnoreMatcher('', '*.log\ntmp/\n');

  it('matches file patterns anchored at the root', () => {
    expect(isIgnored('debug.log', false, [rootMatcher])).toBe(true);
    expect(isIgnored('src/debug.log', false, [rootMatcher])).toBe(true);
    expect(isIgnored('src/index.ts', false, [rootMatcher])).toBe(false);
  });

  it('matches directory-only patterns when told the path is a directory', () => {
    expect(isIgnored('tmp', true, [rootMatcher])).toBe(true);
    expect(isIgnored('tmp', false, [rootMatcher])).toBe(false);
  });

  it('scopes a nested matcher to its own subtree', () => {
    const nested = createIgnoreMatcher('packages/a', 'secret.ts\n');

    expect(isIgnored('packages/a/secret.ts', false, [nested])).toBe(true);
    expect(isIgnored('packages/b/secret.ts', false, [nested])).toBe(false);
    expect(isIgnored('secret.ts', false, [nested])).toBe(false);
  });

  it('is ignored when any matcher in the stack matches', () => {
    const nested = createIgnoreMatcher('packages/a', 'local.ts\n');
    const stack = [rootMatcher, nested];

    expect(isIgnored('packages/a/local.ts', false, stack)).toBe(true);
    expect(isIgnored('packages/a/keep.ts', false, stack)).toBe(false);
    expect(isIgnored('packages/a/keep.log', false, stack)).toBe(true);
  });

  it('returns false with no matchers', () => {
    expect(isIgnored('anything.ts', false, [])).toBe(false);
  });
});
