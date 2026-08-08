import { describe, expect, it } from 'vitest';
import { computeLayout } from './layout.js';
import { encodeEdgeId, type GraphView, type ViewEdge, type ViewNode } from './aggregate.js';

function node(id: string): ViewNode {
  return {
    id,
    kind: 'directory',
    path: id,
    label: id,
    fileCount: 1,
    languages: { typescript: 1 },
    parent: null,
    provenance: 'DERIVED',
  };
}

function edge(from: string, to: string): ViewEdge {
  return {
    id: encodeEdgeId(from, to),
    from,
    to,
    weight: 1,
    importCount: 1,
    fileEdges: [`${from} ${to}`],
    provenance: 'DERIVED',
  };
}

function view(nodeIds: readonly string[], edges: readonly ViewEdge[]): GraphView {
  return {
    level: 'directory',
    expanded: [],
    nodes: nodeIds.map(node),
    edges,
    expandable: [],
  };
}

describe('computeLayout', () => {
  it('positions every node', () => {
    const positions = computeLayout(view(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')]));

    expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'c']);
    for (const position of Object.values(positions)) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
  });

  it('places dependents to the right of what they depend on', () => {
    const positions = computeLayout(view(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')]));

    expect(positions['a']!.x).toBeLessThan(positions['b']!.x);
    expect(positions['b']!.x).toBeLessThan(positions['c']!.x);
  });

  it('puts nodes with no dependencies in the first column', () => {
    const positions = computeLayout(view(['root', 'leaf'], [edge('root', 'leaf')]));
    expect(positions['root']!.x).toBe(0);
  });

  it('separates unconnected nodes vertically rather than stacking them', () => {
    const positions = computeLayout(view(['a', 'b', 'c'], []));
    const ys = ['a', 'b', 'c'].map((id) => positions[id]!.y);
    expect(new Set(ys).size).toBe(3);
  });

  it('is deterministic across runs', () => {
    const graph = view(
      ['a', 'b', 'c', 'd', 'e'],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'e')],
    );

    expect(computeLayout(graph)).toEqual(computeLayout(graph));
  });

  it('is unaffected by the order edges arrive in', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('d', 'c')];

    const forward = computeLayout(view(ids, edges));
    const reversed = computeLayout(view(ids, [...edges].reverse()));

    expect(forward).toEqual(reversed);
  });

  it('terminates on a cycle instead of hanging', () => {
    const positions = computeLayout(view(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]));
    expect(Object.keys(positions)).toHaveLength(3);
  });

  it('handles a node that depends on itself', () => {
    const positions = computeLayout(view(['a'], [edge('a', 'a')]));
    expect(positions['a']).toBeDefined();
  });

  it('handles an empty graph', () => {
    expect(computeLayout(view([], []))).toEqual({});
  });

  it('never overlaps two nodes', () => {
    const ids = Array.from({ length: 40 }, (_, index) => `n${String(index).padStart(2, '0')}`);
    const edges = ids.slice(1).map((id, index) => edge(ids[index]!, id));

    const positions = computeLayout(view(ids, edges));
    const seen = new Set(Object.values(positions).map((p) => `${p.x},${p.y}`));

    expect(seen.size).toBe(ids.length);
  });

  it('lays out a large graph quickly', () => {
    // pyright-scale: the layout must not become the bottleneck it replaced.
    const ids = Array.from({ length: 400 }, (_, index) => `n${String(index).padStart(3, '0')}`);
    const edges: ViewEdge[] = [];
    for (let index = 0; index < ids.length - 1; index += 1) {
      edges.push(edge(ids[index]!, ids[index + 1]!));
      if (index % 3 === 0 && index + 7 < ids.length) {
        edges.push(edge(ids[index]!, ids[index + 7]!));
      }
    }

    const started = Date.now();
    const positions = computeLayout(view(ids, edges));

    expect(Object.keys(positions)).toHaveLength(400);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('respects custom spacing', () => {
    const positions = computeLayout(view(['a', 'b'], [edge('a', 'b')]), {
      rankSpacing: 500,
      nodeSpacing: 10,
    });
    expect(positions['b']!.x).toBe(500);
  });
});
