/**
 * Measures how much the module clustering moves between commits.
 *
 * Determinism (same input, same output) is asserted in the unit tests. This
 * measures the other half: adjacent commits must produce near-identical
 * clusters. Week 9 diffs architecture between commits to compute drift, so if
 * clusters churn on their own, every diff reports architectural change that
 * never happened and the drift score is noise.
 *
 * Usage:
 *   node scripts/cluster-stability.mjs <repo> [offsets]
 *   node scripts/cluster-stability.mjs . 1,5,20
 *
 * Each offset is checked out into a throwaway git worktree, analysed, and its
 * clustering compared with HEAD's. Only files present in both commits are
 * compared — a file that was added or deleted cannot agree or disagree about
 * where it belongs, and counting it would report churn that is not regrouping.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const { walkRepository } = await import(new URL('ingest/walk.js', dist).href);
const { parseRepository } = await import(new URL('parser/parse-repository.js', dist).href);
const { resolveRepository } = await import(new URL('graph/resolve.js', dist).href);
const { buildDependencyGraph } = await import(new URL('graph/build-graph.js', dist).href);
const { clusterRepository } = await import(new URL('graph/cluster.js', dist).href);
const { adjustedRandIndex, jaccardOverlap, partitionFromEntries } = await import(
  new URL('graph/partition.js', dist).href
);

const repo = process.argv[2] ?? '.';
const offsets = (process.argv[3] ?? '1,5,20').split(',').map((value) => Number.parseInt(value, 10));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Walk, parse, resolve, cluster. Returns the file -> module partition. */
async function clusterAt(root) {
  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(`walk failed: ${walked.error.message}`);

  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.message}`);

  const resolution = await resolveRepository({ root, files: parsed.value.files });
  const graph = buildDependencyGraph({ files: parsed.value.files, resolution });
  const clustering = clusterRepository(graph);

  return {
    partition: partitionFromEntries(clustering.assignments.map((a) => [a.file, a.moduleId])),
    summary: clustering.summary,
    fileCount: graph.graph.order,
  };
}

const head = await clusterAt(repo);
const headSha = git(repo, 'rev-parse', '--short', 'HEAD');

console.log(`\n=== ${repo} @ ${headSha} ===`);
console.log(
  `  HEAD: ${head.fileCount} files, ${head.summary.moduleCount} modules, ` +
    `modularity ${head.summary.modularity.toFixed(3)}, disagreement ${head.summary.disagreementRate.toFixed(1)}%`,
);
console.log('');
console.log('  vs        commit    files    shared      ARI   Jaccard   modules');

const scratch = mkdtempSync(join(tmpdir(), 'vibe-stability-'));

try {
  for (const offset of offsets) {
    const ref = `HEAD~${offset}`;
    let sha;
    try {
      sha = git(repo, 'rev-parse', '--short', ref);
    } catch {
      console.log(`  ${ref.padEnd(9)} (not enough history)`);
      continue;
    }

    const worktree = join(scratch, `at-${offset}`);
    git(repo, 'worktree', 'add', '--detach', '--quiet', worktree, sha);

    try {
      const past = await clusterAt(worktree);
      const shared = [...head.partition.keys()].filter((file) => past.partition.has(file)).length;
      const ari = adjustedRandIndex(head.partition, past.partition);
      const jaccard = jaccardOverlap(head.partition, past.partition);

      console.log(
        `  ${ref.padEnd(9)} ${sha.padEnd(9)} ${String(past.fileCount).padStart(5)} ` +
          `${String(shared).padStart(9)} ${ari.toFixed(3).padStart(8)} ${jaccard.toFixed(3).padStart(9)} ` +
          `${String(past.summary.moduleCount).padStart(9)}`,
      );
    } finally {
      git(repo, 'worktree', 'remove', '--force', worktree);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  git(repo, 'worktree', 'prune');
}

console.log('');
