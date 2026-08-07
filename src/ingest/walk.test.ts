import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkRepository } from './walk.js';

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates a throwaway repo. Keys are repo-relative paths with forward slashes. */
async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-walk-'));
  createdRoots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, ...relativePath.split('/'));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }

  return root;
}

async function walkPaths(root: string): Promise<string[]> {
  const result = await walkRepository({ root });
  if (!result.ok) {
    throw new Error(`walk failed: ${result.error.message}`);
  }
  return result.value.files.map((file) => file.path);
}

describe('walkRepository', () => {
  it('finds supported files and reports their language', async () => {
    const root = await makeRepo({
      'src/index.ts': 'export const a = 1;',
      'src/app.tsx': 'export const B = () => null;',
      'scripts/build.mjs': 'export {};',
      'tools/run.py': 'x = 1',
      'README.md': '# docs',
    });

    const result = await walkRepository({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.files.map((file) => file.path)).toEqual([
      'scripts/build.mjs',
      'src/app.tsx',
      'src/index.ts',
      'tools/run.py',
    ]);

    expect(result.value.files.map((file) => file.language)).toEqual([
      'javascript',
      'typescript',
      'typescript',
      'python',
    ]);
    expect(result.value.stats.filesUnsupported).toBe(1);
  });

  it('respects a root .gitignore', async () => {
    const root = await makeRepo({
      '.gitignore': 'generated/\n*.gen.ts\n',
      'src/keep.ts': '',
      'src/schema.gen.ts': '',
      'generated/output.ts': '',
    });

    expect(await walkPaths(root)).toEqual(['src/keep.ts']);
  });

  it('respects a nested .gitignore, scoped to its own subtree', async () => {
    const root = await makeRepo({
      'packages/a/.gitignore': 'secret.ts\n',
      'packages/a/secret.ts': '',
      'packages/a/public.ts': '',
      'packages/b/secret.ts': '',
    });

    expect(await walkPaths(root)).toEqual(['packages/a/public.ts', 'packages/b/secret.ts']);
  });

  it('honours negation patterns', async () => {
    const root = await makeRepo({
      '.gitignore': '*.js\n!keep.js\n',
      'drop.js': '',
      'keep.js': '',
    });

    expect(await walkPaths(root)).toEqual(['keep.js']);
  });

  it('always skips node_modules, .git, dist, build, __pycache__ and .venv', async () => {
    const root = await makeRepo({
      'index.ts': '',
      'node_modules/pkg/index.js': '',
      '.git/hooks/pre-commit.py': '',
      'dist/index.js': '',
      'build/index.js': '',
      'pkg/__pycache__/mod.py': '',
      '.venv/lib/site.py': '',
    });

    expect(await walkPaths(root)).toEqual(['index.ts']);
    expect((await walkRepository({ root })).ok).toBe(true);
  });

  it('handles an empty repository', async () => {
    const root = await makeRepo({});

    const result = await walkRepository({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.files).toEqual([]);
    expect(result.value.stats.directoriesVisited).toBe(1);
    expect(result.value.stats.errors).toEqual([]);
  });

  it('handles a repository with no supported files', async () => {
    const root = await makeRepo({
      'README.md': '# hi',
      'docs/notes.txt': 'notes',
      'Makefile': 'all:',
    });

    const result = await walkRepository({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.files).toEqual([]);
    expect(result.value.stats.filesUnsupported).toBe(3);
  });

  it('reports a missing root as an error rather than throwing', async () => {
    const result = await walkRepository({ root: join(tmpdir(), 'vibe-does-not-exist-9f3a') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('root-not-found');
  });

  it('reports a file passed as the root', async () => {
    const root = await makeRepo({ 'index.ts': '' });

    const result = await walkRepository({ root: join(root, 'index.ts') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('root-not-a-directory');
  });

  it('emits progress for every directory visited', async () => {
    const root = await makeRepo({ 'a/one.ts': '', 'b/two.ts': '' });

    const seen: string[] = [];
    const result = await walkRepository({
      root,
      onProgress: (progress) => seen.push(progress.currentDirectory),
    });

    expect(result.ok).toBe(true);
    expect(seen.sort()).toEqual(['', 'a', 'b']);
  });

  it('does not follow symlinks that escape the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vibe-outside-'));
    createdRoots.push(outside);
    await writeFile(join(outside, 'leaked.ts'), '', 'utf8');

    const root = await makeRepo({ 'inside.ts': '' });

    const linked = await symlink(outside, join(root, 'linked'), 'dir').then(
      () => true,
      () => false,
    );
    if (!linked) {
      // Windows without Developer Mode cannot create symlinks; nothing to assert.
      return;
    }

    const result = await walkRepository({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.files.map((file) => file.path)).toEqual(['inside.ts']);
    expect(result.value.stats.symlinksSkipped).toBe(1);
  });

  it('follows an in-repo symlink exactly once', async () => {
    const root = await makeRepo({ 'src/one.ts': '' });

    const linked = await symlink(join(root, 'src'), join(root, 'alias'), 'dir').then(
      () => true,
      () => false,
    );
    if (!linked) return;

    const result = await walkRepository({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.files.map((file) => file.path)).toEqual(['alias/one.ts', 'src/one.ts']);
  });
});
