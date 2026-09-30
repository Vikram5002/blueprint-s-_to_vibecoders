import { describe, expect, it } from 'vitest';
import { matchesAnyDirectory, pathPatternMatcher } from './path-pattern.js';

describe('pathPatternMatcher', () => {
  it('keeps the directory-and-below meaning for a trailing-only pattern', () => {
    const covers = pathPatternMatcher('src/parser/**');
    expect(covers('src/parser/parse.ts')).toBe(true);
    expect(covers('src/parser/deep/x.ts')).toBe(true);
    expect(covers('src/parserx/y.ts')).toBe(false);
  });

  it('matches a wildcard in the middle as one path segment', () => {
    const covers = pathPatternMatcher('src/*/domain/**');
    expect(covers('src/billing/domain/invoice.ts')).toBe(true);
    expect(covers('src/billing/infra/db.ts')).toBe(false);
    expect(covers('src/a/b/domain/x.ts')).toBe(false);
  });

  it('covers files inside a directory named by a glob without a trailing **', () => {
    expect(pathPatternMatcher('src/*/domain')('src/billing/domain/invoice.ts')).toBe(true);
  });

  it('matches a leading ** at any depth, including the root', () => {
    const covers = pathPatternMatcher('**/domain/**');
    expect(covers('domain/x.ts')).toBe(true);
    expect(covers('packages/a/src/domain/x.ts')).toBe(true);
    expect(covers('src/domainx/x.ts')).toBe(false);
  });

  it('is case-sensitive, like repository paths', () => {
    expect(pathPatternMatcher('app/Models/**')('app/Models/User.php')).toBe(true);
    expect(pathPatternMatcher('app/Models/**')('app/models/User.php')).toBe(false);
  });

  it('only accepts a glob that a real directory matches', () => {
    expect(matchesAnyDirectory('src/*/domain/**', ['src/billing/domain'])).toBe(true);
    expect(matchesAnyDirectory('src/*/domain/**', ['src/billing/infra'])).toBe(false);
  });
});
