/**
 * Workspace package discovery.
 *
 * In a monorepo a bare specifier like `@myorg/utils` is INTERNAL — it names a
 * package inside the repository. Treating it as an npm dependency silently
 * deletes every cross-package edge, which on a monorepo is most of the
 * architecture. That failure is invisible in the resolution rate too, because
 * EXTERNAL counts as a success.
 */
import { readFile, readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { normaliseRepoPath } from './repo-index.js';

export interface WorkspacePackage {
  /** Name from the package's package.json, e.g. `@myorg/utils`. */
  readonly name: string;
  /** Repo-relative directory containing the package. */
  readonly directory: string;
  /** Entry-point candidates from package.json, most specific first. */
  readonly entryCandidates: readonly string[];
}

export type WorkspaceIndex = ReadonlyMap<string, WorkspacePackage>;

export const NO_WORKSPACES: WorkspaceIndex = new Map();

export async function discoverWorkspaces(root: string): Promise<WorkspaceIndex> {
  const globs = [...(await readPnpmWorkspaceGlobs(root)), ...(await readPackageJsonWorkspaceGlobs(root))];
  if (globs.length === 0) {
    return NO_WORKSPACES;
  }

  const index = new Map<string, WorkspacePackage>();
  for (const directory of await expandGlobs(root, globs)) {
    const manifest = await readPackageJson(root, directory);
    if (manifest?.name !== undefined) {
      index.set(manifest.name, {
        name: manifest.name,
        directory,
        entryCandidates: manifest.entryCandidates,
      });
    }
  }

  return index;
}

/**
 * Resolves a bare specifier against the workspace index.
 * Returns the package and the subpath after the package name, if any.
 */
export function matchWorkspacePackage(
  specifier: string,
  workspaces: WorkspaceIndex,
): { readonly pkg: WorkspacePackage; readonly subpath: string } | null {
  const exact = workspaces.get(specifier);
  if (exact !== undefined) {
    return { pkg: exact, subpath: '' };
  }

  // Deep import: `@myorg/utils/src/sub`. Longest package name wins so that
  // `@a/b` does not shadow `@a/b-extra`.
  let best: { pkg: WorkspacePackage; subpath: string } | null = null;
  for (const pkg of workspaces.values()) {
    if (!specifier.startsWith(`${pkg.name}/`)) {
      continue;
    }
    if (best === null || pkg.name.length > best.pkg.name.length) {
      best = { pkg, subpath: specifier.slice(pkg.name.length + 1) };
    }
  }
  return best;
}

/**
 * Minimal reader for the `packages:` list in pnpm-workspace.yaml.
 *
 * Deliberately not a YAML parser: the file has one field this tool cares about
 * and a fixed shape in practice. Pulling in a YAML dependency for it would cost
 * startup time (CLAUDE.md) for no gain. Anything more exotic than a flat list
 * of quoted or bare globs simply yields no globs, and packages fall back to
 * being treated as external.
 */
async function readPnpmWorkspaceGlobs(root: string): Promise<string[]> {
  const text = await readRepoFile(root, 'pnpm-workspace.yaml');
  if (text === null) {
    return [];
  }

  const globs: string[] = [];
  let inPackages = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }

    const entry = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
    if (entry?.[1] !== undefined) {
      globs.push(entry[1]);
    } else if (/^\S/.test(line)) {
      break; // a new top-level key ends the list
    }
  }

  return globs;
}

async function readPackageJsonWorkspaceGlobs(root: string): Promise<string[]> {
  const text = await readRepoFile(root, 'package.json');
  if (text === null) {
    return [];
  }

  const parsed: unknown = safeJson(text);
  if (typeof parsed !== 'object' || parsed === null || !('workspaces' in parsed)) {
    return [];
  }

  const { workspaces } = parsed as { workspaces: unknown };
  if (Array.isArray(workspaces)) {
    return workspaces.filter((glob): glob is string => typeof glob === 'string');
  }
  if (typeof workspaces === 'object' && workspaces !== null && 'packages' in workspaces) {
    const { packages } = workspaces as { packages: unknown };
    return Array.isArray(packages) ? packages.filter((glob): glob is string => typeof glob === 'string') : [];
  }
  return [];
}

/** Expands `packages/*` style globs. Only a trailing `*` segment is supported. */
async function expandGlobs(root: string, globs: readonly string[]): Promise<string[]> {
  const directories = new Set<string>();

  for (const glob of globs) {
    const normalised = normaliseRepoPath(glob);
    if (normalised === null || normalised.includes('**')) {
      continue;
    }

    if (!normalised.endsWith('/*')) {
      directories.add(normalised);
      continue;
    }

    const parent = normalised.slice(0, -2);
    const entries = await readdir(posix.join(root.replace(/\\/g, '/'), parent), { withFileTypes: true }).catch(() => null);
    for (const entry of entries ?? []) {
      if (entry.isDirectory()) {
        directories.add(`${parent}/${entry.name}`);
      }
    }
  }

  return [...directories];
}

interface PackageManifest {
  readonly name: string | undefined;
  readonly entryCandidates: readonly string[];
}

async function readPackageJson(root: string, directory: string): Promise<PackageManifest | null> {
  const text = await readRepoFile(root, `${directory}/package.json`);
  if (text === null) {
    return null;
  }

  const parsed: unknown = safeJson(text);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const manifest = parsed as Record<string, unknown>;
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : undefined;

  // `types` first: in a TS monorepo it points at source, while `main` often
  // points at a build output that does not exist until something is compiled.
  const entryCandidates = ['types', 'typings', 'module', 'main']
    .map((field) => manifest[field])
    .filter((value): value is string => typeof value === 'string');

  return { name, entryCandidates: [...entryCandidates, 'index', 'src/index'] };
}

async function readRepoFile(root: string, relativePath: string): Promise<string | null> {
  return readFile(posix.join(root.replace(/\\/g, '/'), relativePath), 'utf8').catch(() => null);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
