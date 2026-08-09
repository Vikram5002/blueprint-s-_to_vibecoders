/**
 * Cluster stability between *adjacent* commits.
 *
 * `cluster-stability.mjs` compares old commits against HEAD, which answers "how
 * far has the architecture moved". That is the wrong question for Week 9. A
 * drift chart walks history one commit at a time, so what matters is whether
 * consecutive commits produce the same clustering — noise between neighbours
 * compounds into a chart full of architectural change that never happened.
 *
 * Reports, for each consecutive pair, the adjusted Rand index and the mean
 * best-match Jaccard overlap over the files both commits share. An ARI of 1.0
 * means the two clusterings agree completely and any diff between them is real.
 *
 * Usage:
 *   node scripts/adjacent-stability.mjs <repo> [count]
 *   node scripts/adjacent-stability.mjs . 20
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
const count = Number.parseInt(process.argv[3] ?? '20', 10);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function clusterAt(root) {
  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);
  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const resolution = await resolveRepository({ root, files: parsed.value.files });
  const graph = buildDependencyGraph({ files: parsed.value.files, resolution });
  const clustering = clusterRepository(graph);
  return {
    partition: partitionFromEntries(Object.entries(clustering.assignments).map(([f, m]) => [f, m])),
    modules: clustering.modules.length,
    files: parsed.value.files.length,
  };
}

const commits = git(repo, 'rev-list', `--max-count=${count + 1}`, 'HEAD').split('\n').reverse();
console.log(`\n=== adjacent-commit stability over ${commits.length - 1} steps ===\n`);
console.log('  step  older -> newer      shared   files      ARI   Jaccard   modules');
console.log('  ----  -----------------   ------   -----   ------   -------   -------');

const worktree = mkdtempSync(join(tmpdir(), 'vibe-adj-'));
const rows = [];

try {
  let previous = null;
  for (const [index, commit] of commits.entries()) {
    const path = join(worktree, commit.slice(0, 8));
    git(repo, 'worktree', 'add', '--detach', '--quiet', path, commit);
    try {
      const current = await clusterAt(path);
      if (previous !== null) {
        const ari = adjustedRandIndex(previous.result.partition, current.partition);
        const jaccard = jaccardOverlap(previous.result.partition, current.partition);
        const shared = [...previous.result.partition.keys()].filter((k) => current.partition.has(k)).length;

        rows.push({ from: previous.commit, to: commit, ari, jaccard, shared, modules: current.modules });
        console.log(
          `  ${String(index).padStart(4)}  ${previous.commit.slice(0, 7)} -> ${commit.slice(0, 7)}   ` +
            `${String(shared).padStart(6)}  ${String(current.files).padStart(6)}   ` +
            `${ari.toFixed(3).padStart(6)}   ${jaccard.toFixed(3).padStart(7)}   ${String(current.modules).padStart(7)}`,
        );
      }
      previous = { commit, result: current };
    } finally {
      git(repo, 'worktree', 'remove', '--force', path);
    }
  }
} finally {
  rmSync(worktree, { recursive: true, force: true });
  git(repo, 'worktree', 'prune');
}

const perfect = rows.filter((r) => r.ari >= 0.999).length;
const strong = rows.filter((r) => r.ari >= 0.9).length;
const weak = rows.filter((r) => r.ari < 0.8);
const mean = rows.reduce((sum, r) => sum + r.ari, 0) / Math.max(1, rows.length);

console.log(`\n  steps                 ${rows.length}`);
console.log(`  mean ARI              ${mean.toFixed(3)}`);
console.log(`  identical (ARI=1)     ${perfect}/${rows.length}  (${((perfect / rows.length) * 100).toFixed(0)}%)`);
console.log(`  strong  (ARI>=0.9)    ${strong}/${rows.length}  (${((strong / rows.length) * 100).toFixed(0)}%)`);
console.log(`  weak    (ARI<0.8)     ${weak.length}/${rows.length}`);
for (const row of weak) {
  console.log(`      ${row.from.slice(0, 7)} -> ${row.to.slice(0, 7)}  ARI ${row.ari.toFixed(3)}  Jaccard ${row.jaccard.toFixed(3)}`);
}
console.log('');
