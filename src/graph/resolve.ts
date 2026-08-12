/**
 * Stage 2a: resolution.
 *
 * Turns raw specifiers into one of INTERNAL / EXTERNAL / UNRESOLVED, dispatching
 * per language. Nothing is dropped: every import produces exactly one outcome,
 * and every non-INTERNAL outcome carries a reason code.
 *
 * Architectural rule 1: this module and everything under graph/ is deterministic
 * and must never import from llm/.
 */
import { posix } from 'node:path';
import { createRepoIndex, type RepoIndex } from './repo-index.js';
import { loadTsconfig, EMPTY_TSCONFIG, type TsconfigPaths } from './tsconfig.js';
import { discoverWorkspaces } from './workspaces.js';
import { resolveTypeScriptImport } from './resolve-ts.js';
import { buildPythonContext, resolvePythonImport } from './resolve-python.js';
import { buildPhpContext, resolvePhpImport } from './resolve-php.js';
import type { ParsedFile } from '../types/symbols.js';
import type {
  ExternalReason,
  ResolutionSummary,
  ResolvedImport,
  UnresolvedReason,
} from '../types/resolution.js';

export interface ResolveRepositoryOptions {
  /** Absolute repository root. */
  readonly root: string;
  readonly files: readonly ParsedFile[];
}

export interface ResolutionResult {
  readonly imports: readonly ResolvedImport[];
  readonly summary: ResolutionSummary;
}

export async function resolveRepository(options: ResolveRepositoryOptions): Promise<ResolutionResult> {
  const index = createRepoIndex(options.files.map((file) => file.path));
  const workspaces = await discoverWorkspaces(options.root);
  const tsconfigFor = await createTsconfigLookup(options.root, options.files);

  const python = buildPythonContext(index);
  const php = await buildPhpContext(options.root, index);

  const imports: ResolvedImport[] = [];
  for (const file of options.files) {
    for (const record of file.imports) {
      if (file.language === 'python') {
        imports.push(resolvePythonImport(record, python));
      } else if (file.language === 'php') {
        imports.push(resolvePhpImport(record, php));
      } else {
        imports.push(resolveTypeScriptImport(record, { index, workspaces, tsconfigFor, root: options.root }));
      }
    }
  }

  return { imports, summary: summariseResolution(imports) };
}

export function summariseResolution(imports: readonly ResolvedImport[]): ResolutionSummary {
  const unresolvedByReason: Partial<Record<UnresolvedReason, number>> = {};
  const externalByReason: Partial<Record<ExternalReason, number>> = {};
  let internal = 0;
  let external = 0;
  let unresolved = 0;

  for (const item of imports) {
    if (item.status === 'INTERNAL') {
      internal += 1;
    } else if (item.status === 'EXTERNAL') {
      external += 1;
      const reason = item.reason as ExternalReason | null;
      if (reason !== null) {
        externalByReason[reason] = (externalByReason[reason] ?? 0) + 1;
      }
    } else {
      unresolved += 1;
      const reason = item.reason as UnresolvedReason | null;
      if (reason !== null) {
        unresolvedByReason[reason] = (unresolvedByReason[reason] ?? 0) + 1;
      }
    }
  }

  const total = imports.length;
  return {
    total,
    internal,
    external,
    unresolved,
    resolutionRate: total === 0 ? 100 : (1 - unresolved / total) * 100,
    unresolvedByReason,
    externalByReason,
  };
}

/**
 * Finds the tsconfig nearest to each file, walking up from its directory, and
 * caches per directory so a repo with one config reads it once.
 */
async function createTsconfigLookup(
  root: string,
  files: readonly ParsedFile[],
): Promise<(importingFile: string) => TsconfigPaths> {
  const configDirectories = new Set<string>();
  for (const file of files) {
    for (let dir = posix.dirname(file.path); ; dir = posix.dirname(dir)) {
      configDirectories.add(dir === '.' ? '' : dir);
      if (dir === '.' || dir === '/' || dir === '') break;
    }
  }

  const loaded = new Map<string, TsconfigPaths>();
  for (const directory of configDirectories) {
    const configPath = directory === '' ? 'tsconfig.json' : `${directory}/tsconfig.json`;
    const config = await loadTsconfig(root, configPath);
    if (config !== EMPTY_TSCONFIG && (config.baseUrl !== null || config.paths.size > 0)) {
      loaded.set(directory, config);
    }
  }

  return (importingFile: string): TsconfigPaths => {
    for (let dir = posix.dirname(importingFile); ; dir = posix.dirname(dir)) {
      const key = dir === '.' ? '' : dir;
      const found = loaded.get(key);
      if (found !== undefined) {
        return found;
      }
      if (key === '') break;
    }
    return EMPTY_TSCONFIG;
  };
}

export type { RepoIndex };
