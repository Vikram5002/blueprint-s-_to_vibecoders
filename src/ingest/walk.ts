/**
 * Stage 1a: repository walking.
 *
 * Deterministic. Reads the filesystem, honours .gitignore, detects languages,
 * and refuses to follow symlinks that escape the repository root.
 *
 * CLAUDE.md: prefer partial results over failure. A directory that cannot be
 * read is recorded in `stats.errors` and the walk continues.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import { detectLanguage, type Language } from './language.js';
import { createIgnoreMatcher, isAlwaysSkipped, isIgnored, type IgnoreMatcher } from './ignore-rules.js';
import { err, ok, type Result } from '../types/result.js';

export interface DiscoveredFile {
  /** Repo-relative path with forward slashes. */
  readonly path: string;
  readonly absolutePath: string;
  readonly language: Language;
  readonly sizeBytes: number;
}

export interface WalkError {
  readonly path: string;
  readonly message: string;
}

export interface WalkStats {
  directoriesVisited: number;
  /** Directory entries examined, including ones that were skipped. */
  entriesSeen: number;
  /** Files excluded by a .gitignore rule. */
  filesIgnored: number;
  /** Directories excluded by a .gitignore rule or the always-skip list. */
  directoriesSkipped: number;
  /** Files with an extension this tool does not support. */
  filesUnsupported: number;
  /** Symlinks pointing outside the root, or revisiting an already-followed target. */
  symlinksSkipped: number;
  readonly errors: WalkError[];
}

export interface WalkResult {
  /** Absolute, resolved repository root. */
  readonly root: string;
  readonly files: readonly DiscoveredFile[];
  readonly stats: WalkStats;
  readonly durationMs: number;
}

export interface WalkProgress {
  readonly directoriesVisited: number;
  readonly filesFound: number;
  /** Repo-relative path of the directory just completed. `''` is the root. */
  readonly currentDirectory: string;
}

export interface WalkOptions {
  /** Path to the repository root. Resolved before use. */
  readonly root: string;
  readonly onProgress?: (progress: WalkProgress) => void;
}

export type WalkFailure =
  | { readonly kind: 'root-not-found'; readonly path: string; readonly message: string }
  | { readonly kind: 'root-not-a-directory'; readonly path: string; readonly message: string };

interface DirectoryTask {
  readonly absolutePath: string;
  /** Repo-relative, forward slashes. `''` for the root. */
  readonly relativePath: string;
  readonly matchers: readonly IgnoreMatcher[];
}

interface WalkContext {
  readonly rootReal: string;
  readonly files: DiscoveredFile[];
  readonly stats: WalkStats;
  readonly queue: DirectoryTask[];
  readonly followedLinkTargets: Set<string>;
}

export async function walkRepository(options: WalkOptions): Promise<Result<WalkResult, WalkFailure>> {
  const startedAt = Date.now();
  const root = resolve(options.root);

  const rootCheck = await validateRoot(root);
  if (!rootCheck.ok) {
    return rootCheck;
  }

  const context: WalkContext = {
    rootReal: rootCheck.value,
    files: [],
    stats: createStats(),
    queue: [{ absolutePath: root, relativePath: '', matchers: [] }],
    followedLinkTargets: new Set(),
  };

  for (let task = context.queue.pop(); task !== undefined; task = context.queue.pop()) {
    await processDirectory(task, context);
    context.stats.directoriesVisited += 1;
    options.onProgress?.({
      directoriesVisited: context.stats.directoriesVisited,
      filesFound: context.files.length,
      currentDirectory: task.relativePath,
    });
  }

  context.files.sort((a, b) => a.path.localeCompare(b.path));

  return ok({
    root,
    files: context.files,
    stats: context.stats,
    durationMs: Date.now() - startedAt,
  });
}

async function processDirectory(task: DirectoryTask, context: WalkContext): Promise<void> {
  const entries = await readEntries(task.absolutePath);
  if (entries === null) {
    context.stats.errors.push({
      path: task.relativePath,
      message: `could not read directory: ${task.absolutePath}`,
    });
    return;
  }

  const matchers = await extendMatchers(task, entries);

  for (const entry of entries) {
    context.stats.entriesSeen += 1;
    await handleEntry(entry, task, matchers, context);
  }
}

async function handleEntry(
  entry: Dirent,
  task: DirectoryTask,
  matchers: readonly IgnoreMatcher[],
  context: WalkContext,
): Promise<void> {
  const absolutePath = join(task.absolutePath, entry.name);
  const relativePath = task.relativePath === '' ? entry.name : `${task.relativePath}/${entry.name}`;

  const kind = await classifyEntry(entry, absolutePath, context);
  if (kind === 'skip') {
    context.stats.symlinksSkipped += 1;
    return;
  }

  if (kind === 'directory') {
    if (isAlwaysSkipped(entry.name) || isIgnored(relativePath, true, matchers)) {
      context.stats.directoriesSkipped += 1;
      return;
    }
    context.queue.push({ absolutePath, relativePath, matchers });
    return;
  }

  const language = detectLanguage(entry.name);
  if (language === null) {
    context.stats.filesUnsupported += 1;
    return;
  }
  if (isIgnored(relativePath, false, matchers)) {
    context.stats.filesIgnored += 1;
    return;
  }

  context.files.push({
    path: relativePath,
    absolutePath,
    language,
    sizeBytes: await fileSize(absolutePath),
  });
}

type EntryKind = 'directory' | 'file' | 'skip';

/**
 * Resolves what an entry actually is. Symlinks are followed only when their
 * target stays inside the repository root and has not been followed already,
 * which keeps the walk finite in the presence of link cycles.
 */
async function classifyEntry(entry: Dirent, absolutePath: string, context: WalkContext): Promise<EntryKind> {
  if (entry.isDirectory()) {
    return 'directory';
  }
  if (entry.isFile()) {
    return 'file';
  }
  if (!entry.isSymbolicLink()) {
    return 'skip';
  }

  const target = await realpath(absolutePath).catch(() => null);
  if (target === null || !isInsideRoot(context.rootReal, target)) {
    return 'skip';
  }

  const targetStat = await stat(absolutePath).catch(() => null);
  if (targetStat === null) {
    return 'skip';
  }
  if (targetStat.isFile()) {
    return 'file';
  }
  if (!targetStat.isDirectory() || context.followedLinkTargets.has(target)) {
    return 'skip';
  }

  context.followedLinkTargets.add(target);
  return 'directory';
}

/** Adds this directory's own `.gitignore` to the inherited matcher stack. */
async function extendMatchers(
  task: DirectoryTask,
  entries: readonly Dirent[],
): Promise<readonly IgnoreMatcher[]> {
  const hasGitignore = entries.some((entry) => entry.name === '.gitignore' && !entry.isDirectory());
  if (!hasGitignore) {
    return task.matchers;
  }

  const contents = await readFile(join(task.absolutePath, '.gitignore'), 'utf8').catch(() => null);
  if (contents === null) {
    return task.matchers;
  }

  return [...task.matchers, createIgnoreMatcher(task.relativePath, contents)];
}

async function validateRoot(root: string): Promise<Result<string, WalkFailure>> {
  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null) {
    return err({ kind: 'root-not-found', path: root, message: `path does not exist: ${root}` });
  }
  if (!rootStat.isDirectory()) {
    return err({ kind: 'root-not-a-directory', path: root, message: `not a directory: ${root}` });
  }
  return ok(await realpath(root).catch(() => root));
}

async function readEntries(directory: string): Promise<Dirent[] | null> {
  return readdir(directory, { withFileTypes: true }).catch(() => null);
}

async function fileSize(absolutePath: string): Promise<number> {
  const info = await stat(absolutePath).catch(() => null);
  return info?.size ?? 0;
}

function isInsideRoot(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function createStats(): WalkStats {
  return {
    directoriesVisited: 0,
    entriesSeen: 0,
    filesIgnored: 0,
    directoriesSkipped: 0,
    filesUnsupported: 0,
    symlinksSkipped: 0,
    errors: [],
  };
}
