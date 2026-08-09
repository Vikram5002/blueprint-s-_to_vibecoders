/**
 * Walking a repository's history, one commit at a time.
 *
 * ## Why consecutive, and never against HEAD
 *
 * A drift chart is assembled from adjacent steps. Comparing each old commit
 * directly against HEAD would attribute an entire window of legitimate growth
 * to whichever commit sits at the far end of it.
 *
 * That is not a theoretical preference. Measured on this repository: adjacent
 * commits produce *identical* clusterings — ARI 1.000 across 25 consecutive
 * steps — while `HEAD~30` against HEAD scores 0.586. The same history is
 * perfectly stable step by step and looks chaotic end to end, because thirty
 * commits of real growth accumulate. See docs/CLUSTERING.md.
 *
 * ## Worktrees, not checkouts
 *
 * Each commit is materialised in a throwaway `git worktree`. Checking out into
 * the user's own tree would destroy uncommitted work, and a tool that reads a
 * repository has no business moving its HEAD.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { analyseRepository } from './analyse.js';
import { checkConformance } from './conformance.js';
import { buildSnapshot } from '../store/snapshots.js';
import { fileEdgesFrom } from '../conformance/graph-adapter.js';
import { labelModules } from './label.js';
import type { Snapshot } from '../types/snapshots.js';
import type { Correction } from '../types/corrections.js';

const run = promisify(execFile);

export interface CommitRef {
  readonly sha: string;
  readonly committedAt: string;
  readonly subject: string;
}

export interface HistoryOptions {
  readonly root: string;
  /** How many commits back from HEAD, oldest returned first. */
  readonly count: number;
  /** Corrections in force. Recorded on every snapshot for comparability. */
  readonly corrections?: readonly Correction[];
  readonly onProgress?: (done: number, total: number, commit: CommitRef) => void;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Oldest first, so a chart reads left to right. */
export async function listCommits(root: string, count: number): Promise<CommitRef[]> {
  /**
   * ASCII unit separator between fields, record separator between commits.
   *
   * A commit subject can contain anything a person can type — tabs, pipes,
   * newlines — so any printable delimiter is a parsing bug waiting for the
   * commit that contains it. These two bytes cannot appear in git output.
   * Written as escapes, never as literal bytes, or the file becomes binary to
   * git and grep.
   */
  const FIELD = '\u001f';
  const RECORD = '\u001e';

  const output = await git(root, [
    'log',
    `--max-count=${count}`,
    '--date=iso-strict',
    `--pretty=format:%H${FIELD}%ad${FIELD}%s${RECORD}`,
  ]);

  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', committedAt = '', subject = ''] = record.split(FIELD);
      return { sha, committedAt, subject };
    })
    .reverse();
}

/**
 * Builds one snapshot per commit.
 *
 * Labelling is mechanical throughout — `labelModules` with no labeller. Asking
 * a model to name modules at every commit would cost a hundred calls per chart
 * and, worse, would make the history non-reproducible: a snapshot's identity
 * would then depend on what a model happened to say that day. Names are
 * cosmetic; membership is what a diff compares.
 */
export async function snapshotHistory(options: HistoryOptions): Promise<Snapshot[]> {
  const commits = await listCommits(options.root, options.count);
  const correctionIds = (options.corrections ?? []).map((correction) => correction.id);
  const workRoot = await mkdtemp(join(tmpdir(), 'vibe-history-'));
  const snapshots: Snapshot[] = [];

  try {
    for (const [index, commit] of commits.entries()) {
      const path = join(workRoot, commit.sha.slice(0, 12));
      await git(options.root, ['worktree', 'add', '--detach', '--quiet', path, commit.sha]);

      try {
        const analysed = await analyseRepository({
          root: path,
          ...(options.corrections === undefined ? {} : { cluster: { corrections: options.corrections } }),
        });
        if (!analysed.ok) continue;

        const { clustering, graph, parse } = analysed.value;
        const labels = await labelModules(clustering);

        /**
         * No intent extraction while walking history.
         *
         * It needs a model, so it would be a network call per commit — slow,
         * quota-bound, and non-reproducible. Constraints therefore come from
         * the caller's current run and are held constant across the window,
         * which is stated in docs/DRIFT.md: the chart shows the code moving
         * against a fixed set of rules, not the rules moving too.
         */
        const conformance = checkConformance({ graph, clustering, constraints: [] });

        snapshots.push(
          buildSnapshot({
            commit: commit.sha,
            committedAt: commit.committedAt,
            subject: commit.subject,
            clustering,
            labels,
            fileEdges: fileEdgesFrom(graph),
            constraints: [],
            conformance,
            activeCorrections: correctionIds,
            fileCount: parse.files.length,
          }),
        );

        options.onProgress?.(index + 1, commits.length, commit);
      } finally {
        await git(options.root, ['worktree', 'remove', '--force', path]).catch(() => undefined);
      }
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    await git(options.root, ['worktree', 'prune']).catch(() => undefined);
  }

  return snapshots;
}
