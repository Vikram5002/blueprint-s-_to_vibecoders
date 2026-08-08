/**
 * The set of files the walker actually found, and the module-path guessing that
 * runs against it.
 *
 * Resolution targets are checked against this index rather than the filesystem.
 * That guarantees every INTERNAL target is a file the graph has a node for —
 * pointing an edge at a path the walker never saw would break rule 3, since the
 * edge could not be traced to anything the user can open.
 */
import { posix } from 'node:path';

export interface RepoIndex {
  has(repoRelativePath: string): boolean;
  readonly paths: ReadonlySet<string>;
}

export function createRepoIndex(paths: Iterable<string>): RepoIndex {
  const set = new Set(paths);
  return { has: (path) => set.has(path), paths: set };
}

/**
 * Extension inference order, from PHASE-1-SPEC Week 3. A file always beats a
 * directory of the same name, so every bare extension is tried before any
 * `/index.*` candidate.
 */
export const EXTENSION_ORDER: readonly string[] = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

/** Extensions a NodeNext specifier may carry that really mean a TS file on disk. */
const NODENEXT_REWRITES: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', ['.ts', '.tsx', '.d.ts']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts', '.ts']],
  ['.cjs', ['.cts', '.ts']],
]);

/**
 * Turns a repo-relative base path into a real file in the index, or null.
 *
 * Tried in order: the path as written, the NodeNext rewrite (`./x.js` meaning
 * `x.ts`), each extension appended, then each directory index file.
 */
export function resolveModulePath(basePath: string, index: RepoIndex): string | null {
  const normalised = normaliseRepoPath(basePath);
  if (normalised === null) {
    return null;
  }

  if (index.has(normalised)) {
    return normalised;
  }

  for (const candidate of nodeNextCandidates(normalised)) {
    if (index.has(candidate)) {
      return candidate;
    }
  }

  for (const extension of EXTENSION_ORDER) {
    if (index.has(`${normalised}${extension}`)) {
      return `${normalised}${extension}`;
    }
  }

  for (const extension of EXTENSION_ORDER) {
    if (index.has(`${normalised}/index${extension}`)) {
      return `${normalised}/index${extension}`;
    }
  }

  return null;
}

/**
 * `import './x.js'` in a TypeScript project means `x.ts` on disk. This is not an
 * edge case — NodeNext projects import this way throughout, including this one.
 */
function nodeNextCandidates(path: string): string[] {
  const extension = posix.extname(path);
  const replacements = NODENEXT_REWRITES.get(extension);
  if (replacements === undefined) {
    return [];
  }

  const stem = path.slice(0, path.length - extension.length);
  return replacements.map((replacement) => `${stem}${replacement}`);
}

/**
 * Normalises to a repo-relative posix path, or null if it escapes the root.
 * Windows separators are folded so the index only ever holds forward slashes.
 */
export function normaliseRepoPath(path: string): string | null {
  const normalised = posix.normalize(path.replace(/\\/g, '/'));
  const trimmed = normalised.replace(/^\.\//, '').replace(/\/+$/, '');

  if (trimmed === '..' || trimmed.startsWith('../')) {
    return null;
  }
  return trimmed;
}

/** Joins a specifier onto the directory of the importing file. */
export function joinFromFile(importingFile: string, specifier: string): string | null {
  return normaliseRepoPath(posix.join(posix.dirname(importingFile), specifier));
}
