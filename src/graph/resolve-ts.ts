/**
 * TypeScript / JavaScript import resolution.
 *
 * Order of attempts:
 *   1. relative specifiers, against the importing file's directory
 *   2. workspace packages, so monorepo cross-package imports stay INTERNAL
 *   3. tsconfig `paths` aliases
 *   4. tsconfig `baseUrl`
 *   5. Node builtins, then anything else bare, as EXTERNAL
 *
 * A specifier that matched an alias but pointed at nothing is UNRESOLVED, not
 * EXTERNAL — it names something inside the repo that we failed to find, and
 * calling it external would hide a resolver bug behind a healthy-looking rate.
 */
import { builtinModules } from 'node:module';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { joinFromFile, resolveModulePath, type RepoIndex } from './repo-index.js';
import { applyPathAliases, type TsconfigPaths } from './tsconfig.js';
import { matchWorkspacePackage, type WorkspaceIndex } from './workspaces.js';
import type { ImportRecord } from '../types/symbols.js';
import type { ResolvedImport } from '../types/resolution.js';

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

export interface TsResolveContext {
  readonly index: RepoIndex;
  readonly workspaces: WorkspaceIndex;
  /** tsconfig nearest to the importing file, already merged through `extends`. */
  readonly tsconfigFor: (importingFile: string) => TsconfigPaths;
  /** Absolute repository root, used only to distinguish a missing file from an untracked one. */
  readonly root: string;
}

export function resolveTypeScriptImport(record: ImportRecord, context: TsResolveContext): ResolvedImport {
  const { specifier } = record;
  const importingFile = record.evidence.file;

  if (isRelative(specifier)) {
    return resolveRelative(record, importingFile, context);
  }

  const workspaceHit = resolveWorkspace(record, context);
  if (workspaceHit !== null) {
    return workspaceHit;
  }

  const aliasHit = resolveAlias(record, context);
  if (aliasHit !== null) {
    return aliasHit;
  }

  return resolveBare(record);
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
}

function resolveRelative(
  record: ImportRecord,
  importingFile: string,
  context: TsResolveContext,
): ResolvedImport {
  const base = joinFromFile(importingFile, record.specifier);
  if (base === null) {
    return unresolved(record, 'relative-target-missing');
  }

  const target = resolveModulePath(base, context.index);
  if (target !== null) {
    return internal(record, target);
  }

  // A relative import of a real file that the walker does not index — a JSON
  // manifest, a stylesheet, an asset. Reporting that as "missing" would be
  // wrong: we know exactly what it is, it simply has no node in a graph of
  // source files. Kept out of the rate rather than counted as a success.
  if (existsInRepo(context.root, base)) {
    return unresolved(record, 'target-not-in-repo');
  }

  return unresolved(record, 'relative-target-missing');
}

function existsInRepo(root: string, repoRelativePath: string): boolean {
  return existsSync(posix.join(root.replace(/\\/g, '/'), repoRelativePath));
}

function resolveWorkspace(record: ImportRecord, context: TsResolveContext): ResolvedImport | null {
  const match = matchWorkspacePackage(record.specifier, context.workspaces);
  if (match === null) {
    return null;
  }

  const { pkg, subpath } = match;

  if (subpath !== '') {
    const target = resolveModulePath(`${pkg.directory}/${subpath}`, context.index);
    return target === null ? unresolved(record, 'alias-target-missing') : internal(record, target);
  }

  for (const candidate of pkg.entryCandidates) {
    const target = resolveModulePath(`${pkg.directory}/${candidate}`, context.index);
    if (target !== null) {
      return internal(record, target);
    }
  }

  // The package is genuinely part of the repo; we just could not find its entry.
  return unresolved(record, 'alias-target-missing');
}

function resolveAlias(record: ImportRecord, context: TsResolveContext): ResolvedImport | null {
  const config = context.tsconfigFor(record.evidence.file);

  const aliasTargets = applyPathAliases(record.specifier, config);
  for (const candidate of aliasTargets) {
    const target = resolveModulePath(candidate, context.index);
    if (target !== null) {
      return internal(record, target);
    }
  }

  if (config.baseUrl !== null) {
    const target = resolveModulePath(`${config.baseUrl}/${record.specifier}`, context.index);
    if (target !== null) {
      return internal(record, target);
    }
  }

  // An alias pattern matched but nothing was there: a repo-internal miss.
  return aliasTargets.length > 0 ? unresolved(record, 'alias-target-missing') : null;
}

function resolveBare(record: ImportRecord): ResolvedImport {
  const { specifier } = record;

  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) {
    return external(record, specifier, 'node-builtin');
  }

  return external(record, packageNameOf(specifier), 'npm-package');
}

/** `@scope/pkg/deep/path` -> `@scope/pkg`; `pkg/deep` -> `pkg`. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  if (specifier.startsWith('@') && segments.length >= 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? specifier;
}

function internal(record: ImportRecord, targetPath: string): ResolvedImport {
  return { record, status: 'INTERNAL', targetPath, externalName: null, reason: null };
}

function external(record: ImportRecord, name: string, reason: 'npm-package' | 'node-builtin'): ResolvedImport {
  return { record, status: 'EXTERNAL', targetPath: null, externalName: name, reason };
}

function unresolved(
  record: ImportRecord,
  reason: 'relative-target-missing' | 'alias-target-missing' | 'target-not-in-repo',
): ResolvedImport {
  return { record, status: 'UNRESOLVED', targetPath: null, externalName: null, reason };
}
