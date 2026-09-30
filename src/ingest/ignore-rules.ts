/**
 * .gitignore handling.
 *
 * PHASE-1-SPEC Week 1: "use the `ignore` package; do not hand-roll this".
 * Git applies a `.gitignore` to the subtree rooted at its own directory, so the
 * walker carries a stack of matchers down the tree, each scoped to the
 * directory it was read from.
 */
import ignore from 'ignore';
import type { Ignore } from 'ignore';

/**
 * Directories skipped unconditionally, whether or not a .gitignore mentions
 * them. `.vibe` is this tool's own SQLite location. `generated` is where the
 * Layer 3 code-generation pipeline writes real scaffolded projects to disk
 * (see src/generate/) — never analysed by a normal `vibe-blueprint .` run on
 * this repo, the same way this tool never analyses its own `.vibe` database.
 *
 * Tool directories are skipped at any depth. Build-output names (`dist`,
 * `build`, `generated`) only at the repository root: deeper down they are
 * often real source - pip keeps code in src/pip/_internal/operations/build/ -
 * and a nested build output is normally covered by .gitignore anyway.
 */
export const ALWAYS_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  '.vibe',
]);

export const ROOT_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['dist', 'build', 'generated']);

export interface IgnoreMatcher {
  /** Repo-relative directory the patterns are anchored to. `''` is the root. */
  readonly base: string;
  readonly matcher: Ignore;
}

/** `relativePath` is the directory's repo-relative path; its last segment is the name. */
export function isAlwaysSkipped(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const name = segments[segments.length - 1] ?? '';
  return ALWAYS_SKIPPED_DIRECTORIES.has(name) || (segments.length === 1 && ROOT_SKIPPED_DIRECTORIES.has(name));
}

/** Builds a matcher for one `.gitignore` file's contents. */
export function createIgnoreMatcher(base: string, gitignoreContents: string): IgnoreMatcher {
  return { base, matcher: ignore().add(gitignoreContents) };
}

/**
 * Tests a repo-relative path against every matcher whose base directory is an
 * ancestor of it. Directories must be passed with `isDirectory` set so that
 * `dir/`-style patterns match.
 */
export function isIgnored(
  relativePath: string,
  isDirectory: boolean,
  matchers: readonly IgnoreMatcher[],
): boolean {
  for (const { base, matcher } of matchers) {
    const scoped = scopePath(relativePath, base);
    if (scoped === null || scoped === '') {
      continue;
    }
    if (matcher.ignores(isDirectory ? `${scoped}/` : scoped)) {
      return true;
    }
  }
  return false;
}

/** Re-expresses a repo-relative path as relative to `base`, or null if outside it. */
function scopePath(relativePath: string, base: string): string | null {
  if (base === '') {
    return relativePath;
  }
  if (!relativePath.startsWith(`${base}/`)) {
    return null;
  }
  return relativePath.slice(base.length + 1);
}
