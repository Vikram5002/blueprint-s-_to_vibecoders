/**
 * Python import resolution.
 *
 * Package roots are derived from layout rather than assumed. `__init__.py` is
 * NOT required by modern Python — PEP 420 namespace packages have none — so a
 * root is any directory holding Python code that is not itself inside a
 * package. That covers the classic layout, the src/ layout, and namespace
 * packages with the same rule.
 *
 * The dangerous failure here is calling an unresolved internal module
 * "site-packages", which counts as a success and hides the bug. So a specifier
 * whose top-level name exists inside the repository is UNRESOLVED when its full
 * path cannot be found, never EXTERNAL.
 */
import { posix } from 'node:path';
import { isStandardLibraryModule } from './python-stdlib.js';
import { normaliseRepoPath, type RepoIndex } from './repo-index.js';
import type { ImportRecord } from '../types/symbols.js';
import type { ResolvedImport } from '../types/resolution.js';

export interface PythonResolveContext {
  readonly index: RepoIndex;
  /** Directories that behave like sys.path entries, shortest first. */
  readonly roots: readonly string[];
  /** Directories containing an `__init__.py`. */
  readonly packageDirectories: ReadonlySet<string>;
  /** Every directory that holds Python files, at any depth. */
  readonly pythonDirectories: ReadonlySet<string>;
}

export function buildPythonContext(index: RepoIndex): PythonResolveContext {
  const packageDirectories = new Set<string>();
  const pythonDirectories = new Set<string>();

  for (const path of index.paths) {
    if (!path.endsWith('.py')) {
      continue;
    }
    const directory = dirOf(path);
    pythonDirectories.add(directory);
    if (posix.basename(path) === '__init__.py') {
      packageDirectories.add(directory);
    }
  }

  return {
    index,
    roots: deriveRoots(pythonDirectories, packageDirectories),
    packageDirectories,
    pythonDirectories,
  };
}

/**
 * A root is the first ancestor of a Python directory that is not itself a
 * package. The repository root is always a candidate.
 */
function deriveRoots(
  pythonDirectories: ReadonlySet<string>,
  packageDirectories: ReadonlySet<string>,
): string[] {
  const roots = new Set<string>(['']);

  for (const directory of pythonDirectories) {
    let current = directory;
    while (current !== '' && packageDirectories.has(current)) {
      current = dirOf(current);
    }
    roots.add(current);
  }

  return [...roots].sort((a, b) => a.length - b.length);
}

export function resolvePythonImport(record: ImportRecord, context: PythonResolveContext): ResolvedImport {
  if (record.relativeLevel > 0) {
    return resolveRelative(record, context);
  }
  return resolveAbsolute(record, context);
}

function resolveRelative(record: ImportRecord, context: PythonResolveContext): ResolvedImport {
  // Level 1 is the containing package; each extra dot climbs one more. Python
  // forbids climbing past the top-level package, so a climb is only legal while
  // the parent is itself part of the package tree.
  let base = dirOf(record.evidence.file);
  for (let step = 1; step < record.relativeLevel; step += 1) {
    const parent = dirOf(base);
    if (base === '' || !isPackageLike(parent, context)) {
      return unresolved(record, 'relative-beyond-root');
    }
    base = parent;
  }

  const targetBase = record.specifier === ''
    ? base
    : normaliseRepoPath(posix.join(base, record.specifier.split('.').join('/')));

  if (targetBase === null) {
    return unresolved(record, 'relative-beyond-root');
  }

  const target = resolveModuleOrPackage(targetBase, record, context);
  return target === null ? unresolved(record, 'python-module-missing') : internal(record, target);
}

function resolveAbsolute(record: ImportRecord, context: PythonResolveContext): ResolvedImport {
  const segments = record.specifier.split('.').filter((segment) => segment !== '');
  if (segments.length === 0) {
    return unresolved(record, 'python-module-missing');
  }

  for (const root of context.roots) {
    const base = root === '' ? segments.join('/') : `${root}/${segments.join('/')}`;
    const target = resolveModuleOrPackage(base, record, context);
    if (target !== null) {
      return internal(record, target);
    }
  }

  return classifyExternal(record, context, segments[0] ?? '');
}

/**
 * Decides between stdlib, site-packages and "we failed". A top-level name that
 * exists inside the repository is treated as an internal miss, because calling
 * it external would count a resolver bug as a success.
 */
function classifyExternal(
  record: ImportRecord,
  context: PythonResolveContext,
  topLevel: string,
): ResolvedImport {
  if (isStandardLibraryModule(record.specifier)) {
    return external(record, record.specifier, 'python-stdlib');
  }

  if (looksInternal(topLevel, context)) {
    return unresolved(record, 'python-module-missing');
  }

  return external(record, topLevel, 'python-site-packages');
}

function looksInternal(topLevel: string, context: PythonResolveContext): boolean {
  if (topLevel === '') {
    return false;
  }
  for (const root of context.roots) {
    const candidate = root === '' ? topLevel : `${root}/${topLevel}`;
    if (context.pythonDirectories.has(candidate) || context.index.has(`${candidate}.py`)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves a base path to a module file, a package `__init__.py`, or — when the
 * base is a package — a submodule named by one of the imported names.
 *
 * `from .sub import deep` should point at `sub/deep.py` rather than at
 * `sub/__init__.py`, because `deep` is the thing being depended on.
 */
function resolveModuleOrPackage(
  base: string,
  record: ImportRecord,
  context: PythonResolveContext,
): string | null {
  const asModule = `${base}.py`;
  if (context.index.has(asModule)) {
    return asModule;
  }

  const isPackage = context.packageDirectories.has(base);
  const isNamespaceDirectory = context.pythonDirectories.has(base) || hasPythonDescendant(base, context);
  if (!isPackage && !isNamespaceDirectory) {
    return null;
  }

  for (const name of record.names) {
    if (name.name === '*') {
      continue;
    }
    const submodule = `${base}/${name.name}.py`;
    if (context.index.has(submodule)) {
      return submodule;
    }
    const subpackage = `${base}/${name.name}/__init__.py`;
    if (context.index.has(subpackage)) {
      return subpackage;
    }
  }

  const initFile = `${base}/__init__.py`;
  return context.index.has(initFile) ? initFile : null;
}

/**
 * True when a directory participates in the package tree — either a classic
 * package with `__init__.py`, or a PEP 420 namespace directory holding Python.
 * Relative imports may only climb through such directories.
 */
function isPackageLike(directory: string, context: PythonResolveContext): boolean {
  return context.packageDirectories.has(directory) || context.pythonDirectories.has(directory);
}

/** True when `base` is a namespace package: a directory with Python below it. */
function hasPythonDescendant(base: string, context: PythonResolveContext): boolean {
  const prefix = `${base}/`;
  for (const directory of context.pythonDirectories) {
    if (directory.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function dirOf(path: string): string {
  const directory = posix.dirname(path);
  return directory === '.' ? '' : directory;
}

function internal(record: ImportRecord, targetPath: string): ResolvedImport {
  return { record, status: 'INTERNAL', targetPath, externalName: null, reason: null };
}

function external(
  record: ImportRecord,
  name: string,
  reason: 'python-stdlib' | 'python-site-packages',
): ResolvedImport {
  return { record, status: 'EXTERNAL', targetPath: null, externalName: name, reason };
}

function unresolved(
  record: ImportRecord,
  reason: 'relative-beyond-root' | 'python-module-missing',
): ResolvedImport {
  return { record, status: 'UNRESOLVED', targetPath: null, externalName: null, reason };
}
