/**
 * How a resolved PATH_PATTERN picks out files and directories.
 *
 * Shared by subject resolution, the violation detector and `check_import`,
 * so the three can never disagree about what a rule covers.
 *
 * A pattern whose only wildcard is a trailing `/*` or `/**` - which is what
 * `normalisePattern` produces for a plain directory such as `src/parser/` -
 * keeps its long-standing meaning: that directory and everything below it.
 * A wildcard anywhere else (`src/*\/domain`, `**\/domain/**`) is matched as a
 * real glob. Reducing those to a prefix by deleting the `*` gave
 * `src//domain` or `/domain`, which matched nothing, so such rules were
 * always reported unresolved or empty.
 *
 * Matching is case-sensitive, like the repository paths it runs on.
 */

/** The directory a trailing-only pattern names, or null when a wildcard sits elsewhere. */
function plainPrefix(pattern: string): string | null {
  const prefix = pattern.replace(/\/?\*\*?$/, '');
  return prefix.includes('*') ? null : prefix;
}

/** `**` spans any number of segments (including none), `*` stays within one segment. */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === '*' && pattern[i + 1] === '*') {
      const followedBySlash = pattern[i + 2] === '/';
      source += followedBySlash ? '(?:.*/)?' : '.*';
      i += followedBySlash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** Does `path` (a repo-relative file) fall under `pattern`? */
export function pathPatternMatcher(pattern: string): (path: string) => boolean {
  const prefix = plainPrefix(pattern);
  if (prefix !== null) {
    return (path) => path === prefix || path.startsWith(`${prefix}/`);
  }
  const full = globToRegExp(pattern);
  // A file inside a matching directory is covered too: `src/*/domain` covers src/a/domain/x.ts.
  const directory = globToRegExp(pattern.replace(/\/\*\*$/, ''));
  return (path) => {
    if (full.test(path)) return true;
    const segments = path.split('/');
    for (let end = segments.length - 1; end > 0; end -= 1) {
      if (directory.test(segments.slice(0, end).join('/'))) return true;
    }
    return false;
  };
}

/** True when the pattern has a wildcard somewhere other than its end. */
export function hasInnerWildcard(pattern: string): boolean {
  return plainPrefix(pattern) === null;
}

/** The trailing-only prefix of a pattern (see plainPrefix); empty when the pattern has inner wildcards. */
export function patternPrefix(pattern: string): string {
  return plainPrefix(pattern) ?? '';
}

/** Does any real directory fall under `pattern`? Used to accept a glob only when it matches something. */
export function matchesAnyDirectory(pattern: string, directories: readonly string[]): boolean {
  const matches = pathPatternMatcher(pattern);
  return directories.some((directory) => matches(directory) || matches(`${directory}/`));
}
