/**
 * tsconfig.json loading for path-alias resolution.
 *
 * Only the fields resolution needs are read: `baseUrl`, `paths`, and `extends`.
 *
 * Two TypeScript rules are easy to get wrong and both are handled here:
 *   - `baseUrl` is relative to the config file that DECLARES it, not to the
 *     config that inherits it through `extends`.
 *   - `paths` entries are relative to `baseUrl` when one is set, and relative to
 *     the declaring config otherwise.
 */
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { normaliseRepoPath } from './repo-index.js';

export interface TsconfigPaths {
  /** Repo-relative directory that bare specifiers resolve against, or null. */
  readonly baseUrl: string | null;
  /** Alias pattern to repo-relative targets, in declaration order. */
  readonly paths: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_TSCONFIG: TsconfigPaths = { baseUrl: null, paths: new Map() };

interface RawTsconfig {
  readonly extends?: unknown;
  readonly compilerOptions?: { readonly baseUrl?: unknown; readonly paths?: unknown };
}

/**
 * Loads a tsconfig and its `extends` chain. `configPath` and the result are
 * repo-relative; `readJson` is injected so tests and callers control I/O.
 */
export async function loadTsconfig(
  root: string,
  configPath: string,
  seen: ReadonlySet<string> = new Set(),
): Promise<TsconfigPaths> {
  if (seen.has(configPath)) {
    return EMPTY_TSCONFIG; // circular extends
  }

  const raw = await readTsconfigFile(root, configPath);
  if (raw === null) {
    return EMPTY_TSCONFIG;
  }

  const configDir = posix.dirname(configPath);
  const inherited = await loadParent(root, raw, configDir, new Set([...seen, configPath]));

  const ownBaseUrl = asString(raw.compilerOptions?.baseUrl);
  const baseUrl = ownBaseUrl === null
    ? inherited.baseUrl
    : normaliseRepoPath(posix.join(configDir, ownBaseUrl));

  const ownPaths = asPathsRecord(raw.compilerOptions?.paths);
  if (ownPaths === null) {
    return { baseUrl, paths: inherited.paths };
  }

  // `paths` replaces rather than merges, matching TypeScript.
  return { baseUrl, paths: resolvePathTargets(ownPaths, baseUrl ?? configDir) };
}

async function loadParent(
  root: string,
  raw: RawTsconfig,
  configDir: string,
  seen: ReadonlySet<string>,
): Promise<TsconfigPaths> {
  const extendsPath = asString(raw.extends);
  if (extendsPath === null || !extendsPath.startsWith('.')) {
    // A bare `extends` names a package; those live in node_modules, which is
    // outside the repository, so there is nothing to read.
    return EMPTY_TSCONFIG;
  }

  const withExtension = extendsPath.endsWith('.json') ? extendsPath : `${extendsPath}.json`;
  const target = normaliseRepoPath(posix.join(configDir, withExtension));
  return target === null ? EMPTY_TSCONFIG : loadTsconfig(root, target, seen);
}

function resolvePathTargets(
  paths: ReadonlyMap<string, readonly string[]>,
  relativeTo: string,
): Map<string, readonly string[]> {
  const resolved = new Map<string, readonly string[]>();

  for (const [pattern, targets] of paths) {
    const mapped = targets
      .map((target) => normaliseRepoPath(posix.join(relativeTo, target)))
      .filter((target): target is string => target !== null);
    resolved.set(pattern, mapped);
  }

  return resolved;
}

/**
 * Applies alias patterns to a specifier, returning candidate repo-relative
 * paths. A `*` matches one or more segments; the longest matching prefix wins,
 * which is how TypeScript disambiguates overlapping patterns.
 */
export function applyPathAliases(specifier: string, config: TsconfigPaths): string[] {
  const matches: { readonly targets: readonly string[]; readonly wildcard: string; readonly weight: number }[] = [];

  for (const [pattern, targets] of config.paths) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern === specifier) {
        matches.push({ targets, wildcard: '', weight: pattern.length + 1 });
      }
      continue;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
      matches.push({
        targets,
        wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
        weight: prefix.length,
      });
    }
  }

  matches.sort((a, b) => b.weight - a.weight);
  return matches.flatMap(({ targets, wildcard }) =>
    targets.map((target) => target.replace('*', wildcard)),
  );
}

async function readTsconfigFile(root: string, configPath: string): Promise<RawTsconfig | null> {
  const absolute = posix.join(root.replace(/\\/g, '/'), configPath);
  const text = await readFile(absolute, 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }

  const parsed = parseJsonWithComments(text);
  return typeof parsed === 'object' && parsed !== null ? (parsed as RawTsconfig) : null;
}

/** tsconfig.json permits comments and trailing commas; JSON.parse does not. */
function parseJsonWithComments(text: string): unknown {
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm, (match, line: string | undefined, block: string | undefined) =>
      line === undefined && block === undefined ? match : '',
    )
    .replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asPathsRecord(value: unknown): ReadonlyMap<string, readonly string[]> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const result = new Map<string, readonly string[]>();
  for (const [pattern, targets] of Object.entries(value)) {
    if (Array.isArray(targets)) {
      result.set(pattern, targets.filter((target): target is string => typeof target === 'string'));
    }
  }
  return result;
}
