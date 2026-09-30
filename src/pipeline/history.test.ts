import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listCommits, snapshotHistory } from './history.js';
import type { Snapshot } from '../types/snapshots.js';

const run = promisify(execFile);
let repo = '';

async function git(args: string[], env: Record<string, string> = {}): Promise<void> {
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
  });
}

async function commit(message: string, authorDate: string, committerDate: string): Promise<void> {
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate });
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vibe-history-test-'));
  await git(['init', '-q']);
  await mkdir(join(repo, 'packages', 'foo'), { recursive: true });
  await mkdir(join(repo, 'other'), { recursive: true });
  await writeFile(join(repo, 'packages', 'foo', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(repo, 'other', 'x.ts'), 'export const x = 1;\n');
  await writeFile(join(repo, 'other', 'y.ts'), 'export const y = 1;\n');
  await commit('first', '2020-01-01T00:00:00Z', '2024-06-01T00:00:00Z');
  await writeFile(join(repo, 'packages', 'foo', 'b.ts'), "import { a } from './a';\nexport const b = a;\n");
  await commit('second', '2020-01-02T00:00:00Z', '2024-06-02T00:00:00Z');
}, 60_000);

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('snapshotHistory', () => {
  it('records the committer date, not the author date', async () => {
    const commits = await listCommits(repo, 2);
    expect(commits.map((c) => c.subject)).toEqual(['first', 'second']);
    expect(commits[0]?.committedAt).toMatch(/^2024-06-01/);
  });

  it('analyses the requested subfolder in every commit, and hands over each snapshot as it is built', async () => {
    const handed: Snapshot[] = [];
    const snapshots = await snapshotHistory({
      root: join(repo, 'packages', 'foo'),
      count: 2,
      onSnapshot: (snapshot) => handed.push(snapshot),
    });
    expect(snapshots.map((s) => s.fileCount)).toEqual([1, 2]);
    expect(handed).toEqual(snapshots);
  }, 120_000);
});
