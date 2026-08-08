import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository } from '../parser/parse-repository.js';
import { resolveRepository } from './resolve.js';
import { buildDependencyGraph } from './build-graph.js';
import type { DependencyGraph } from './build-graph.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function graphFor(name: string): Promise<DependencyGraph> {
  const root = `${FIXTURES}${name}`;

  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);

  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);

  const resolved = await resolveRepository({ root, files: parsed.value.files });
  return buildDependencyGraph({ files: parsed.value.files, resolution: resolved });
}

describe('graph structure', () => {
  it('creates one node per source file', async () => {
    const graph = await graphFor('ts-basic');

    expect(graph.graph.order).toBeGreaterThan(0);
    for (const nodeId of graph.graph.nodes()) {
      const node = graph.graph.getNodeAttributes(nodeId);
      expect(node['kind']).toBe('file');
    }
    expect(graph.graph.hasNode('src/index.ts')).toBe(true);
    expect(graph.graph.hasNode('src/util.ts')).toBe(true);
  }, 30_000);

  it('creates an edge for every internal import', async () => {
    const graph = await graphFor('ts-basic');

    expect(graph.graph.hasEdge('src/index.ts', 'src/util.ts')).toBe(true);
    expect(graph.graph.hasEdge('src/index.ts', 'src/folder/index.ts')).toBe(true);
  }, 30_000);

  it('excludes external targets from the graph but keeps them queryable', async () => {
    const graph = await graphFor('ts-basic');

    expect(graph.graph.hasNode('react')).toBe(false);
    expect(graph.externals.map((e) => e.name)).toContain('react');
    expect(graph.externals.map((e) => e.name)).toContain('node:path');

    const react = graph.externals.find((e) => e.name === 'react');
    expect(react?.importers).toContain('src/index.ts');
  }, 30_000);
});

describe('architectural rules', () => {
  it('gives every node provenance DERIVED (rule 2)', async () => {
    const graph = await graphFor('ts-basic');

    for (const nodeId of graph.graph.nodes()) {
      expect(graph.graph.getNodeAttribute(nodeId, 'provenance')).toBe('DERIVED');
    }
  }, 30_000);

  it('gives every edge provenance DERIVED (rule 2)', async () => {
    const graph = await graphFor('ts-basic');

    for (const edgeId of graph.graph.edges()) {
      expect(graph.graph.getEdgeAttribute(edgeId, 'provenance')).toBe('DERIVED');
    }
  }, 30_000);

  it('gives every edge non-empty evidence pointing at a real line (rule 3)', async () => {
    for (const fixture of ['ts-basic', 'ts-monorepo', 'py-package']) {
      const graph = await graphFor(fixture);
      expect(graph.graph.size).toBeGreaterThan(0);

      for (const edgeId of graph.graph.edges()) {
        const evidence = graph.graph.getEdgeAttribute(edgeId, 'evidence');
        expect(Array.isArray(evidence)).toBe(true);
        expect((evidence as unknown[]).length).toBeGreaterThan(0);

        for (const item of evidence as { file: string; line: number; snippet: string }[]) {
          expect(item.file.length).toBeGreaterThan(0);
          expect(item.line).toBeGreaterThan(0);
          expect(item.snippet.length).toBeGreaterThan(0);
          // Evidence must belong to the file the edge starts at.
          expect(item.file).toBe(graph.graph.source(edgeId));
        }
      }
    }
  }, 60_000);

  it('never creates an edge to a node that does not exist', async () => {
    for (const fixture of ['ts-basic', 'ts-monorepo', 'py-package', 'py-namespace']) {
      const graph = await graphFor(fixture);
      for (const edgeId of graph.graph.edges()) {
        expect(graph.graph.hasNode(graph.graph.source(edgeId))).toBe(true);
        expect(graph.graph.hasNode(graph.graph.target(edgeId))).toBe(true);
      }
    }
  }, 60_000);
});

describe('edge merging', () => {
  it('merges repeated imports of the same target into one edge with both evidences', async () => {
    const graph = await graphFor('py-package');

    // myapp/main.py imports myapp/helpers.py several ways: absolute, `from .`,
    // and `from .helpers`. That is one dependency with several proofs.
    const edge = graph.graph.edge('myapp/main.py', 'myapp/helpers.py');
    expect(edge).toBeDefined();
    if (edge === undefined) return;

    const evidence = graph.graph.getEdgeAttribute(edge, 'evidence') as unknown[];
    expect(evidence.length).toBeGreaterThan(1);
    expect(graph.graph.getEdgeAttribute(edge, 'count')).toBe(evidence.length);

    const lines = (evidence as { line: number }[]).map((e) => e.line);
    expect(new Set(lines).size).toBe(lines.length);
  }, 30_000);

  it('does not create self-edges for a file importing itself', async () => {
    const graph = await graphFor('ts-basic');
    for (const edgeId of graph.graph.edges()) {
      expect(graph.graph.source(edgeId)).not.toBe(graph.graph.target(edgeId));
    }
  }, 30_000);
});

describe('unresolved imports', () => {
  it('records unresolved imports with their reason rather than dropping them', async () => {
    const graph = await graphFor('ts-basic');

    const missing = graph.unresolved.find((item) => item.specifier === './does-not-exist');
    expect(missing).toBeDefined();
    expect(missing?.reason).toBe('relative-target-missing');
    expect(missing?.evidence.file).toBe('src/index.ts');
    expect(missing?.evidence.line).toBeGreaterThan(0);
  }, 30_000);

  it('accounts for every import exactly once', async () => {
    const graph = await graphFor('ts-basic');
    const { summary } = graph;

    expect(summary.internal + summary.external + summary.unresolved).toBe(summary.total);
  }, 30_000);
});
