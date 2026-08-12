/**
 * PHP import resolution.
 *
 * Two independent paths, matching the two ImportKinds extract-php.ts produces:
 *
 * - `php-use` (a fully-qualified class/function/const name) resolves through
 *   composer.json's PSR-4 autoload map — a pure string-and-path computation,
 *   the namespace prefix maps directly onto a directory prefix and the
 *   remainder of the FQCN maps onto a file path. Unlike Python this needs no
 *   directory scan: PSR-4 is a convention, not a discovery process. A FQCN
 *   matching no registered prefix is a vendor package or a PHP core class —
 *   EXTERNAL. A FQCN matching a prefix but pointing at no file is a resolver
 *   miss on code that is genuinely part of this repo — UNRESOLVED, never
 *   EXTERNAL, same anti-pattern-avoidance as resolve-python.ts.
 * - `php-require` (a literal filesystem path, usually `__DIR__ . '/x.php'`
 *   with the `__DIR__` prefix already stripped by the extractor) resolves
 *   relative to the importing file's own directory, same as a TS relative
 *   import. Anything landing under `vendor/` is EXTERNAL.
 */
import { posix } from 'node:path';
import { readFile } from 'node:fs/promises';
import { joinFromFile, normaliseRepoPath, type RepoIndex } from './repo-index.js';
import type { ImportRecord } from '../types/symbols.js';
import type { ResolvedImport } from '../types/resolution.js';

interface Psr4Prefix {
  /** Namespace prefix, e.g. `App\`. Empty string is the PSR-4 fallback root. */
  readonly prefix: string;
  /** Repo-relative directories this prefix maps onto, longest match first. */
  readonly dirs: readonly string[];
}

export interface PhpResolveContext {
  readonly index: RepoIndex;
  /** Sorted longest-prefix-first so `App\Http\` wins over `App\`. */
  readonly autoload: readonly Psr4Prefix[];
}

/**
 * Reads composer.json off disk once per repo and builds the PSR-4 prefix
 * table. A repo with no composer.json, or no `autoload.psr-4` entry, yields an
 * empty table — every `use` then falls through to EXTERNAL, which is correct:
 * without PSR-4 there is no way to tell a first-party class from a vendor one.
 */
export async function buildPhpContext(root: string, index: RepoIndex): Promise<PhpResolveContext> {
  const composerDir = posix.dirname(findComposerJson(index) ?? 'composer.json');
  const raw = await readComposerJson(root, composerDir === '.' ? 'composer.json' : `${composerDir}/composer.json`);
  const autoload = raw === null ? [] : mergePsr4(raw, composerDir);

  return {
    index,
    autoload: [...autoload].sort((a, b) => b.prefix.length - a.prefix.length),
  };
}

function findComposerJson(index: RepoIndex): string | null {
  return index.has('composer.json') ? 'composer.json' : null;
}

interface ComposerJson {
  readonly autoload?: { readonly 'psr-4'?: Record<string, string | readonly string[]> };
  readonly 'autoload-dev'?: { readonly 'psr-4'?: Record<string, string | readonly string[]> };
}

async function readComposerJson(root: string, repoRelativePath: string): Promise<ComposerJson | null> {
  try {
    const absolute = posix.join(root.replace(/\\/g, '/'), repoRelativePath);
    const text = await readFile(absolute, 'utf8');
    return JSON.parse(text) as ComposerJson;
  } catch {
    return null;
  }
}

/**
 * `autoload` and `autoload-dev` may register the *same* namespace prefix
 * against different directories (php-parser's own composer.json does this:
 * `PhpParser\` maps to both `lib/PhpParser` and `test/PhpParser/`). Every
 * directory registered under a prefix must be tried before giving up on it,
 * so entries sharing a prefix are merged rather than kept as separate,
 * independently-failing candidates.
 */
function mergePsr4(composer: ComposerJson, composerDir: string): Psr4Prefix[] {
  const byPrefix = new Map<string, string[]>();
  for (const map of [composer.autoload?.['psr-4'], composer['autoload-dev']?.['psr-4']]) {
    if (map === undefined) continue;
    for (const [prefix, dirs] of Object.entries(map)) {
      const list = Array.isArray(dirs) ? dirs : [dirs];
      const resolved = list.map((dir) => joinComposerRelative(composerDir, dir));
      const existing = byPrefix.get(prefix);
      if (existing === undefined) {
        byPrefix.set(prefix, resolved);
      } else {
        existing.push(...resolved);
      }
    }
  }
  return [...byPrefix.entries()].map(([prefix, dirs]) => ({ prefix, dirs }));
}

function joinComposerRelative(composerDir: string, dir: string): string {
  const joined = composerDir === '.' ? dir : posix.join(composerDir, dir);
  return normaliseRepoPath(joined) ?? joined;
}

export function resolvePhpImport(record: ImportRecord, context: PhpResolveContext): ResolvedImport {
  return record.kind === 'php-use' ? resolveUse(record, context) : resolveRequire(record, context);
}

function resolveUse(record: ImportRecord, context: PhpResolveContext): ResolvedImport {
  const fqcn = record.specifier;

  for (const entry of context.autoload) {
    if (!fqcn.startsWith(entry.prefix)) {
      continue;
    }

    const remainder = fqcn.slice(entry.prefix.length);
    const relativePath = `${remainder.split('\\').join('/')}.php`;

    for (const dir of entry.dirs) {
      const candidate = normaliseRepoPath(posix.join(dir, relativePath));
      if (candidate !== null && context.index.has(candidate)) {
        return internal(record, candidate);
      }
    }

    // A prefix registered in composer.json matched, but no file sits at the
    // mapped path — this is first-party code the resolver failed to find.
    return unresolved(record, 'php-namespace-target-missing');
  }

  return external(record, fqcn, 'php-composer-package');
}

function resolveRequire(record: ImportRecord, context: PhpResolveContext): ResolvedImport {
  const base = joinFromFile(record.evidence.file, record.specifier);
  if (base === null) {
    return unresolved(record, 'php-require-target-missing');
  }

  if (isUnderVendor(base)) {
    return external(record, base, 'php-composer-package');
  }

  const target = resolvePhpPath(base, context.index);
  return target === null ? unresolved(record, 'php-require-target-missing') : internal(record, target);
}

function isUnderVendor(path: string): boolean {
  return path.split('/').includes('vendor');
}

function resolvePhpPath(base: string, index: RepoIndex): string | null {
  const normalised = normaliseRepoPath(base);
  if (normalised === null) {
    return null;
  }
  if (index.has(normalised)) {
    return normalised;
  }
  if (!normalised.endsWith('.php') && index.has(`${normalised}.php`)) {
    return `${normalised}.php`;
  }
  return null;
}

function internal(record: ImportRecord, targetPath: string): ResolvedImport {
  return { record, status: 'INTERNAL', targetPath, externalName: null, reason: null };
}

function external(record: ImportRecord, name: string, reason: 'php-composer-package'): ResolvedImport {
  return { record, status: 'EXTERNAL', targetPath: null, externalName: name, reason };
}

function unresolved(
  record: ImportRecord,
  reason: 'php-namespace-target-missing' | 'php-require-target-missing',
): ResolvedImport {
  return { record, status: 'UNRESOLVED', targetPath: null, externalName: null, reason };
}
