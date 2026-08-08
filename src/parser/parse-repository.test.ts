import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository, summariseParse } from './parse-repository.js';
import type { DiscoveredFile } from '../ingest/walk.js';

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-parse-'));
  createdRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, ...relativePath.split('/'));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }
  return root;
}

async function walkedFiles(root: string): Promise<readonly DiscoveredFile[]> {
  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);
  return walked.value.files;
}

describe('parseRepository', () => {
  it('parses a walked repository into symbol tables', async () => {
    const root = await makeRepo({
      'src/a.ts': `import { b } from './b';\nexport const a = b;\n`,
      'src/b.ts': `export const b = 1;\n`,
    });

    const report = await parseRepository({ files: await walkedFiles(root) });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const summary = summariseParse(report.value);
    expect(summary.filesParsed).toBe(2);
    expect(summary.filesFailed).toBe(0);
    expect(summary.importCount).toBe(1);
    expect(summary.exportCount).toBe(2);
  }, 30_000);

  it('keeps going when a file is malformed and counts it', async () => {
    const root = await makeRepo({
      'good.ts': `import { x } from './x';\nexport const good = x;\n`,
      'bad.ts': `import { y } from './y';\nfunction ( { const ]][ broken\n`,
      'also-good.ts': `export const fine = 1;\n`,
    });

    const report = await parseRepository({ files: await walkedFiles(root) });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const summary = summariseParse(report.value);
    // The broken file is parsed, not dropped: three files in, three files out.
    expect(summary.filesParsed).toBe(3);
    expect(summary.filesFailed).toBe(0);
    expect(summary.filesWithSyntaxErrors).toBe(1);

    // And it still yielded the import that appeared before the damage.
    const bad = report.value.files.find((file) => file.path === 'bad.ts');
    expect(bad?.hadSyntaxErrors).toBe(true);
    expect(bad?.imports.map((i) => i.specifier)).toEqual(['./y']);
  }, 30_000);

  it('skips Python rather than failing on it', async () => {
    const root = await makeRepo({
      'app.ts': `export const a = 1;\n`,
      'script.py': `import os\n`,
    });

    const report = await parseRepository({ files: await walkedFiles(root) });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const summary = summariseParse(report.value);
    expect(summary.filesParsed).toBe(1);
    expect(summary.filesSkipped).toBe(1);
    expect(summary.filesFailed).toBe(0);
    expect(report.value.skipped[0]).toMatchObject({ path: 'script.py', reason: 'no-grammar-yet' });
  }, 30_000);

  it('records an unreadable file as a failure without throwing', async () => {
    const root = await makeRepo({ 'real.ts': `export const a = 1;\n` });
    const files = await walkedFiles(root);

    const report = await parseRepository({
      files: [...files, { path: 'ghost.ts', absolutePath: join(root, 'ghost.ts'), language: 'typescript', sizeBytes: 0 }],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const summary = summariseParse(report.value);
    expect(summary.filesParsed).toBe(1);
    expect(summary.filesFailed).toBe(1);
    expect(report.value.failures[0]).toMatchObject({ path: 'ghost.ts', reason: 'unreadable' });
  }, 30_000);

  it('handles a repository with nothing to parse', async () => {
    const root = await makeRepo({ 'README.md': '# nothing' });

    const report = await parseRepository({ files: await walkedFiles(root) });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(summariseParse(report.value).filesParsed).toBe(0);
  }, 30_000);

  it('reports progress for every file', async () => {
    const root = await makeRepo({ 'a.ts': '', 'b.ts': '', 'c.ts': '' });

    const seen: string[] = [];
    await parseRepository({
      files: await walkedFiles(root),
      onProgress: (progress) => seen.push(progress.currentFile),
    });

    expect(seen.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  }, 30_000);
});
