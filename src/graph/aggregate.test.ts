import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository } from '../parser/parse-repository.js';
import { resolveRepository } from './resolve.js';
import { buildDependencyGraph, type DependencyGraph } from './build-graph.js';
import { decodeEdgeId, directoryOf, encodeEdgeId, projectGraph, splitFileEdgeKey } from './aggregate.js';

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

describe('directoryOf', () => {
  it('uses the containing directory', () => {
    expect(directoryOf('src/graph/aggregate.ts')).toBe('src/graph');
  });

  it('maps repository-root files to a single root node', () => {
    expect(directoryOf('index.ts')).toBe('.');
  });
});

describe('edge id encoding', () => {
  it('round-trips paths containing slashes and spaces', () => {
    const id = encodeEdgeId('src/a b/c.ts', 'lib/d.ts');
    expect(decodeEdgeId(id)).toEqual({ from: 'src/a b/c.ts', to: 'lib/d.ts' });
  });

  it('produces URL-safe ids', () => {
    const id = encodeEdgeId('packages/app/src/main.ts', 'packages/utils/src/index.ts');
    expect(id).toBe(encodeURIComponent(id));
  });

  it('returns null for a malformed id', () => {
    expect(decodeEdgeId(Buffer.from('nosep', 'utf8').toString('base64url'))).toBeNull();
  });
});

describe('directory projection', () => {
  let graph: DependencyGraph;

  beforeAll(async () => {
    graph = await graphFor('ts-monorepo');
  }, 30_000);

  it('collapses files into directory nodes', () => {
    const view = projectGraph(graph, { level: 'directory' });

    expect(view.nodes.length).toBeLessThan(graph.graph.order);
    expect(view.nodes.every((node) => node.kind === 'directory')).toBe(true);
    expect(view.nodes.map((n) => n.id)).toContain('packages/app/src');
    expect(view.nodes.map((n) => n.id)).toContain('packages/utils/src');
  });

  it('counts the files behind each directory node', () => {
    const view = projectGraph(graph, { level: 'directory' });
    const utils = view.nodes.find((node) => node.id === 'packages/utils/src');

    expect(utils?.fileCount).toBe(2); // index.ts + sub.ts
    expect(utils?.languages['typescript']).toBe(2);
  });

  it('accounts for every file exactly once', () => {
    const view = projectGraph(graph, { level: 'directory' });
    const total = view.nodes.reduce((sum, node) => sum + node.fileCount, 0);
    expect(total).toBe(graph.graph.order);
  });

  it('aggregates file edges into weighted directory edges', () => {
    const view = projectGraph(graph, { level: 'directory' });
    const edge = view.edges.find((e) => e.from === 'packages/app/src' && e.to === 'packages/utils/src');

    expect(edge).toBeDefined();
    // main.ts imports both index.ts and sub.ts: two file edges, one directory edge.
    expect(edge?.weight).toBe(2);
    expect(edge?.fileEdges).toHaveLength(2);
  });

  it('keeps every aggregate edge traceable to real file edges', () => {
    const view = projectGraph(graph, { level: 'directory' });

    expect(view.edges.length).toBeGreaterThan(0);
    for (const edge of view.edges) {
      expect(edge.fileEdges.length).toBeGreaterThan(0);
      expect(edge.weight).toBe(edge.fileEdges.length);
      expect(edge.importCount).toBeGreaterThanOrEqual(edge.weight);

      for (const key of edge.fileEdges) {
        const split = splitFileEdgeKey(key);
        expect(split).not.toBeNull();
        if (split === null) continue;
        expect(graph.graph.hasEdge(split.source, split.target)).toBe(true);
        expect(directoryOf(split.source)).toBe(edge.from);
        expect(directoryOf(split.target)).toBe(edge.to);
      }
    }
  });

  it('drops edges that are internal to one directory rather than drawing self-loops', () => {
    const view = projectGraph(graph, { level: 'directory' });
    expect(view.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });

  it('marks multi-file directories as expandable', () => {
    const view = projectGraph(graph, { level: 'directory' });
    expect(view.expandable).toContain('packages/utils/src');
    expect(view.expandable).not.toContain('packages/app/src'); // single file
  });

  it('is deterministic', () => {
    const a = projectGraph(graph, { level: 'directory' });
    const b = projectGraph(graph, { level: 'directory' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('expansion', () => {
  let graph: DependencyGraph;

  beforeAll(async () => {
    graph = await graphFor('ts-monorepo');
  }, 30_000);

  it('replaces an expanded directory with its files', () => {
    const view = projectGraph(graph, { level: 'directory', expanded: ['packages/utils/src'] });

    expect(view.nodes.map((n) => n.id)).not.toContain('packages/utils/src');
    expect(view.nodes.map((n) => n.id)).toContain('packages/utils/src/index.ts');
    expect(view.nodes.map((n) => n.id)).toContain('packages/utils/src/sub.ts');
  });

  it('records which directory an expanded file came from', () => {
    const view = projectGraph(graph, { level: 'directory', expanded: ['packages/utils/src'] });
    const file = view.nodes.find((n) => n.id === 'packages/utils/src/index.ts');

    expect(file?.kind).toBe('file');
    expect(file?.parent).toBe('packages/utils/src');
    expect(file?.label).toBe('index.ts');
  });

  it('leaves other directories collapsed', () => {
    const view = projectGraph(graph, { level: 'directory', expanded: ['packages/utils/src'] });
    expect(view.nodes.map((n) => n.id)).toContain('packages/exported/src');
  });

  it('re-points edges at the expanded files', () => {
    const view = projectGraph(graph, { level: 'directory', expanded: ['packages/utils/src'] });

    expect(view.edges.some((e) => e.to === 'packages/utils/src/index.ts')).toBe(true);
    expect(view.edges.some((e) => e.to === 'packages/utils/src/sub.ts')).toBe(true);
    expect(view.edges.some((e) => e.to === 'packages/utils/src')).toBe(false);
  });

  it('still accounts for every file after expanding', () => {
    const view = projectGraph(graph, { level: 'directory', expanded: ['packages/utils/src'] });
    const total = view.nodes.reduce((sum, node) => sum + node.fileCount, 0);
    expect(total).toBe(graph.graph.order);
  });

  it('ignores an expand request for a directory that does not exist', () => {
    const view = projectGraph(graph, { level: 'directory', expanded: ['nope/not/here'] });
    const plain = projectGraph(graph, { level: 'directory' });
    expect(view.nodes.map((n) => n.id)).toEqual(plain.nodes.map((n) => n.id));
  });
});

describe('file level', () => {
  it('returns one node per file and ignores expansion', async () => {
    const graph = await graphFor('ts-basic');
    const view = projectGraph(graph, { level: 'file', expanded: ['src'] });

    expect(view.nodes).toHaveLength(graph.graph.order);
    expect(view.nodes.every((node) => node.kind === 'file')).toBe(true);
    expect(view.edges.length).toBe(graph.graph.size);
  }, 30_000);
});
