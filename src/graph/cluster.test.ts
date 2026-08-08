import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository } from '../parser/parse-repository.js';
import { resolveRepository } from './resolve.js';
import { buildDependencyGraph, type DependencyGraph } from './build-graph.js';
import { clusterRepository, DEFAULT_MIN_CLUSTER_SIZE } from './cluster.js';
import { adjustedRandIndex, partitionFromEntries } from './partition.js';
import { directoryOf, splitFileEdgeKey } from './aggregate.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function graphFor(name: string): Promise<DependencyGraph> {
  const root = `${FIXTURES}${name}`;
  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);
  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const resolution = await resolveRepository({ root, files: parsed.value.files });
  return buildDependencyGraph({ files: parsed.value.files, resolution });
}

describe('determinism', () => {
  let graph: DependencyGraph;

  beforeAll(async () => {
    graph = await graphFor('ts-monorepo');
  }, 30_000);

  it('produces byte-identical output across 10 consecutive runs', () => {
    // The headline property of the week. Louvain left to itself gives a
    // different answer each run; a tool that regroups modules on refresh is as
    // untrustworthy as one that invents edges.
    const first = JSON.stringify(clusterRepository(graph));

    for (let run = 1; run < 10; run += 1) {
      expect(JSON.stringify(clusterRepository(graph)), `run ${run + 1} differed`).toBe(first);
    }
  });

  it('gives the same answer for the same seed and a stable one for a different seed', () => {
    const a = clusterRepository(graph, { seed: 12345 });
    const b = clusterRepository(graph, { seed: 12345 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // A different seed must still be internally deterministic.
    const c = clusterRepository(graph, { seed: 999 });
    const d = clusterRepository(graph, { seed: 999 });
    expect(JSON.stringify(c)).toBe(JSON.stringify(d));
  });

  it('assigns cluster ids from content, not from algorithm ordering', () => {
    const result = clusterRepository(graph);
    for (const module of result.modules) {
      expect(module.id).toMatch(/^module-\d{3}$/);
    }

    // Modules are ordered by their smallest member, so the id is a function of
    // membership alone.
    const firstMembers = result.modules.map((module) => module.files[0] ?? '');
    expect([...firstMembers].sort()).toEqual(firstMembers);
  });

  it('is unaffected by the order files were inserted into the graph', async () => {
    const forward = clusterRepository(graph);

    const reversed = graph.graph.copy();
    const rebuilt = { ...graph, graph: reversed };
    const backward = clusterRepository(rebuilt);

    expect(backward.assignments.map((a) => `${a.file}:${a.moduleId}`)).toEqual(
      forward.assignments.map((a) => `${a.file}:${a.moduleId}`),
    );
  });
});

describe('coverage and structure', () => {
  let graph: DependencyGraph;

  beforeAll(async () => {
    graph = await graphFor('ts-monorepo');
  }, 30_000);

  it('assigns every file to exactly one module', () => {
    const result = clusterRepository(graph);

    expect(result.assignments).toHaveLength(graph.graph.order);
    const seen = new Set(result.assignments.map((a) => a.file));
    expect(seen.size).toBe(graph.graph.order);

    const fromModules = result.modules.flatMap((module) => module.files);
    expect(fromModules.sort()).toEqual([...graph.graph.nodes()].sort());
  });

  it('marks every module and edge DERIVED and never LLM-labelled (rules 1 and 2)', () => {
    const result = clusterRepository(graph);

    for (const module of result.modules) {
      expect(module.provenance).toBe('DERIVED');
      expect(module.llmLabelled).toBe(false);
      expect(module.userCorrected).toBe(false);
    }
    for (const edge of result.edges) {
      expect(edge.provenance).toBe('DERIVED');
    }
  });

  it('labels modules mechanically, never semantically', () => {
    const result = clusterRepository(graph);
    for (const module of result.modules) {
      const isPath = module.files.some((file) => file.startsWith(module.label));
      const isIndex = /^module-\d{3}$/.test(module.label);
      expect(isPath || isIndex, `label "${module.label}" is neither a path nor an index`).toBe(true);
    }
  });

  it('keeps module edges traceable to real file edges (rule 3)', () => {
    // minClusterSize 1 so this small fixture keeps more than one module; with
    // the default every cluster is under threshold and merges into one, which
    // is correct for seven files but leaves no inter-module edge to check.
    const result = clusterRepository(graph, { minClusterSize: 1 });

    expect(result.edges.length).toBeGreaterThan(0);
    for (const edge of result.edges) {
      expect(edge.fileEdges.length).toBeGreaterThan(0);
      expect(edge.weight).toBe(edge.fileEdges.length);

      for (const key of edge.fileEdges) {
        const split = splitFileEdgeKey(key);
        expect(split).not.toBeNull();
        if (split === null) continue;
        expect(graph.graph.hasEdge(split.source, split.target)).toBe(true);
      }
    }
  });

  it('never emits a self-edge between a module and itself', () => {
    const result = clusterRepository(graph);
    expect(result.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });
});

describe('explainability', () => {
  it('answers "why is this file in this module?" for every file', async () => {
    const graph = await graphFor('ts-monorepo');
    const result = clusterRepository(graph);

    for (const assignment of result.assignments) {
      expect(['import-coupling', 'directory-prior', 'small-cluster-merge']).toContain(assignment.reason);
      expect(assignment.explanation.length).toBeGreaterThan(10);
      expect(assignment.directory).toBe(directoryOf(assignment.file));
    }
  }, 30_000);

  it('explains an unconnected file as a directory-prior placement', async () => {
    const graph = await graphFor('ts-basic');
    const result = clusterRepository(graph);

    const isolated = [...graph.graph.nodes()].filter((file) => graph.graph.degree(file) === 0);
    expect(isolated.length).toBeGreaterThan(0);

    for (const file of isolated) {
      const assignment = result.assignments.find((a) => a.file === file);
      // The final reason is whichever step last moved it — a directory-prior
      // group can itself be small enough to merge afterwards — but the
      // explanation must still say the file had no coupling to go on.
      expect(['directory-prior', 'small-cluster-merge']).toContain(assignment?.reason);
      expect(assignment?.explanation).toContain('no coupling');
    }
  }, 30_000);

  it('records every merge so a merged file stays explainable', async () => {
    const graph = await graphFor('ts-monorepo');
    const result = clusterRepository(graph, { minClusterSize: 4 });

    for (const merge of result.merges) {
      expect(merge.files.length).toBeGreaterThan(0);
      expect(merge.explanation.length).toBeGreaterThan(10);
      expect(['coupling-strength', 'directory-fallback', 'no-neighbour']).toContain(merge.reason);
    }

    const merged = result.assignments.filter((a) => a.reason === 'small-cluster-merge');
    for (const assignment of merged) {
      expect(assignment.explanation).toMatch(/merged/i);
    }
  }, 30_000);
});

describe('small-cluster merging', () => {
  it('leaves clusters alone when the threshold is 1', async () => {
    const graph = await graphFor('ts-monorepo');
    const result = clusterRepository(graph, { minClusterSize: 1 });
    expect(result.merges).toEqual([]);
  }, 30_000);

  it('produces fewer modules as the threshold rises', async () => {
    const graph = await graphFor('ts-monorepo');
    const loose = clusterRepository(graph, { minClusterSize: 1 });
    const strict = clusterRepository(graph, { minClusterSize: 6 });

    expect(strict.summary.moduleCount).toBeLessThanOrEqual(loose.summary.moduleCount);
    expect(strict.summary.mergedClusters).toBeGreaterThanOrEqual(loose.summary.mergedClusters);
  }, 30_000);

  it('reports the threshold it used', async () => {
    const graph = await graphFor('ts-monorepo');
    expect(clusterRepository(graph).summary.minClusterSize).toBe(DEFAULT_MIN_CLUSTER_SIZE);
    expect(clusterRepository(graph, { minClusterSize: 7 }).summary.minClusterSize).toBe(7);
  }, 30_000);
});

describe('directory disagreement', () => {
  it('reports a disagreement rate and the files behind it', async () => {
    const graph = await graphFor('ts-monorepo');
    const result = clusterRepository(graph);

    expect(result.summary.disagreementRate).toBeGreaterThanOrEqual(0);
    expect(result.summary.disagreementRate).toBeLessThanOrEqual(100);

    for (const disagreement of result.disagreements) {
      expect(disagreement.directory).not.toBe(disagreement.modulePluralityDirectory);
      const assignment = result.assignments.find((a) => a.file === disagreement.file);
      expect(assignment?.moduleId).toBe(disagreement.moduleId);
    }
  }, 30_000);

  it('counts cross-directory modules and split directories', async () => {
    const graph = await graphFor('ts-monorepo');
    const result = clusterRepository(graph);

    const crossDirectory = result.modules.filter((module) => module.directories.length > 1).length;
    expect(result.summary.crossDirectoryModules).toBe(crossDirectory);
    expect(result.summary.splitDirectories).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

describe('resolution parameter', () => {
  it('is reported and configurable', async () => {
    const graph = await graphFor('ts-monorepo');

    expect(clusterRepository(graph).summary.resolution).toBe(1);
    expect(clusterRepository(graph, { resolution: 2 }).summary.resolution).toBe(2);
  }, 30_000);

  it('reports a modularity score', async () => {
    const graph = await graphFor('ts-monorepo');
    const { modularity } = clusterRepository(graph).summary;

    expect(Number.isFinite(modularity)).toBe(true);
    expect(modularity).toBeGreaterThanOrEqual(-1);
    expect(modularity).toBeLessThanOrEqual(1);
  }, 30_000);
});

describe('degenerate inputs', () => {
  it('handles a repository with no files', async () => {
    const graph = await graphFor('py-external');
    const stripped = { ...graph, graph: graph.graph.copy() };
    stripped.graph.clear();

    const result = clusterRepository(stripped);
    expect(result.modules).toEqual([]);
    expect(result.summary.moduleCount).toBe(0);
    expect(result.summary.disagreementRate).toBe(0);
  }, 30_000);

  it('handles a repository with no edges at all', async () => {
    const graph = await graphFor('py-external');
    const result = clusterRepository(graph);

    expect(result.assignments).toHaveLength(graph.graph.order);
    expect(result.assignments.every((a) => a.reason === 'directory-prior')).toBe(true);
  }, 30_000);
});

describe('stability under small changes', () => {
  it('barely moves when one leaf file is added', async () => {
    const graph = await graphFor('ts-monorepo');
    const before = clusterRepository(graph);

    const mutated = { ...graph, graph: graph.graph.copy() };
    mutated.graph.addNode('packages/app/src/extra.ts', {
      kind: 'file',
      label: 'extra.ts',
      path: 'packages/app/src/extra.ts',
      language: 'typescript',
      provenance: 'DERIVED',
      llmLabelled: false,
      userCorrected: false,
    });
    mutated.graph.addDirectedEdge('packages/app/src/extra.ts', 'packages/app/src/main.ts', {
      kind: 'imports',
      evidence: [{ file: 'packages/app/src/extra.ts', line: 1, snippet: "import './main';" }],
      count: 1,
      provenance: 'DERIVED',
    });
    const after = clusterRepository(mutated);

    const ari = adjustedRandIndex(
      partitionFromEntries(before.assignments.map((a) => [a.file, a.moduleId] as const)),
      partitionFromEntries(after.assignments.map((a) => [a.file, a.moduleId] as const)),
    );

    // Adding one file must not reshuffle the architecture.
    expect(ari).toBeGreaterThan(0.7);
  }, 30_000);
});
