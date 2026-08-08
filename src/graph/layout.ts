/**
 * Deterministic hierarchical layout.
 *
 * Computed once, server-side, and shipped with the graph. No physics
 * simulation and no continuous force ticking: a force-directed layout over
 * pyright's edge count would peg a CPU core and never settle, and the result
 * would differ on every run, which makes it impossible to say "the diagram
 * changed because the code changed".
 *
 * Layered, in the Sugiyama sense but deliberately simple:
 *   1. rank nodes by dependency depth, breaking cycles at a stable point
 *   2. order nodes within a rank to reduce crossings, by barycentre
 *   3. assign coordinates on a fixed grid
 *
 * Every step is a pure function of the input, so the same graph always lays
 * out identically.
 */
import type { GraphView, ViewEdge } from './aggregate.js';

export interface LayoutPosition {
  readonly x: number;
  readonly y: number;
}

export type LayoutPositions = Readonly<Record<string, LayoutPosition>>;

export interface LayoutOptions {
  /** Horizontal distance between ranks. */
  readonly rankSpacing?: number;
  /** Vertical distance between nodes inside a rank. */
  readonly nodeSpacing?: number;
  /** Nodes stacked in one rank before it wraps into another sub-column. */
  readonly maxRankHeight?: number;
}

const DEFAULT_RANK_SPACING = 340;
const DEFAULT_NODE_SPACING = 78;
const DEFAULT_MAX_RANK_HEIGHT = 14;
const SUBCOLUMN_SPACING = 150;
const ISOLATED_GUTTER = 200;
const BARYCENTRE_PASSES = 4;

/**
 * Nodes with no edges are laid out apart from the ranked ones.
 *
 * Measured on pyright: 34 of its 61 directories have no internal dependencies
 * at all (test-sample directories, mostly). Ranking puts every one of them at
 * rank 0, which produced a 43-node column spanning 3,780px and squeezed the 27
 * directories that actually carry the structure into a thin band. The diagram
 * has to answer "what depends on what", and the nodes that depend on nothing
 * and are depended on by nothing were drowning out the ones that do.
 */
export function computeLayout(view: GraphView, options: LayoutOptions = {}): LayoutPositions {
  const rankSpacing = options.rankSpacing ?? DEFAULT_RANK_SPACING;
  const nodeSpacing = options.nodeSpacing ?? DEFAULT_NODE_SPACING;
  const maxRankHeight = options.maxRankHeight ?? DEFAULT_MAX_RANK_HEIGHT;

  const ids = view.nodes.map((node) => node.id);
  const connected = new Set<string>();
  for (const edge of view.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const ranked = ids.filter((id) => connected.has(id));
  const isolated = ids.filter((id) => !connected.has(id)).sort();

  const acyclic = removeCycles(ranked, view.edges);
  const ranks = assignRanks(ranked, acyclic);
  const ordered = orderWithinRanks(ranked, acyclic, ranks);

  const positions = toPositions(ordered, rankSpacing, nodeSpacing, maxRankHeight);
  return { ...positions, ...placeIsolated(isolated, positions, nodeSpacing, maxRankHeight) };
}

/** Isolated nodes go in a compact grid to the right of the ranked structure. */
function placeIsolated(
  isolated: readonly string[],
  ranked: LayoutPositions,
  nodeSpacing: number,
  maxRankHeight: number,
): LayoutPositions {
  if (isolated.length === 0) {
    return {};
  }

  const xs = Object.values(ranked).map((position) => position.x);
  const startX = (xs.length === 0 ? 0 : Math.max(...xs)) + ISOLATED_GUTTER;

  const positions: Record<string, LayoutPosition> = {};
  isolated.forEach((id, index) => {
    positions[id] = {
      x: startX + Math.floor(index / maxRankHeight) * SUBCOLUMN_SPACING,
      y: (index % maxRankHeight) * nodeSpacing,
    };
  });
  return positions;
}

/**
 * Drops the edges that close a cycle, found by depth-first search over nodes in
 * sorted order. Import graphs contain cycles; ranking needs a DAG. The dropped
 * edges are only excluded from the ranking maths — they are still drawn.
 */
function removeCycles(ids: readonly string[], edges: readonly ViewEdge[]): ViewEdge[] {
  const outgoing = new Map<string, ViewEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const backEdges = new Set<ViewEdge>();

  const visit = (id: string): void => {
    state.set(id, 'visiting');
    for (const edge of outgoing.get(id) ?? []) {
      const target = state.get(edge.to);
      if (target === 'visiting') {
        backEdges.add(edge);
      } else if (target === undefined) {
        visit(edge.to);
      }
    }
    state.set(id, 'done');
  };

  for (const id of [...ids].sort()) {
    if (!state.has(id)) {
      visit(id);
    }
  }

  return edges.filter((edge) => !backEdges.has(edge));
}

/** Longest-path ranking: a node sits one rank right of its deepest dependent. */
function assignRanks(ids: readonly string[], edges: readonly ViewEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  const outDegree = new Map<string, number>();

  for (const id of ids) {
    incoming.set(id, []);
    outDegree.set(id, 0);
  }
  for (const edge of edges) {
    incoming.get(edge.to)?.push(edge.from);
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
  }

  const ranks = new Map<string, number>();
  const sorted = [...ids].sort();

  // Iterate to a fixed point. The graph is acyclic here, so this terminates in
  // at most depth passes; the bound is a guard, not an expectation.
  for (let pass = 0; pass <= sorted.length; pass += 1) {
    let changed = false;
    for (const id of sorted) {
      const sources = incoming.get(id) ?? [];
      const rank = sources.length === 0
        ? 0
        : Math.max(...sources.map((source) => (ranks.get(source) ?? 0) + 1));
      if (rank !== (ranks.get(id) ?? 0)) {
        ranks.set(id, rank);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  for (const id of sorted) {
    if (!ranks.has(id)) {
      ranks.set(id, 0);
    }
  }
  return ranks;
}

/**
 * Orders each rank by the mean position of its neighbours in the previous rank,
 * sweeping a few times. Cheap, and it removes most of the crossings a naive
 * alphabetical order would produce. Ties break on id so the result is stable.
 */
function orderWithinRanks(
  ids: readonly string[],
  edges: readonly ViewEdge[],
  ranks: ReadonlyMap<string, number>,
): Map<number, string[]> {
  const byRank = new Map<number, string[]>();
  for (const id of [...ids].sort()) {
    const rank = ranks.get(id) ?? 0;
    byRank.set(rank, [...(byRank.get(rank) ?? []), id]);
  }

  const predecessors = new Map<string, string[]>();
  for (const edge of edges) {
    predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
  }

  const rankNumbers = [...byRank.keys()].sort((a, b) => a - b);

  for (let pass = 0; pass < BARYCENTRE_PASSES; pass += 1) {
    const index = positionIndex(byRank);

    for (const rank of rankNumbers) {
      const row = byRank.get(rank);
      if (row === undefined || rank === 0) {
        continue;
      }
      const scored = row.map((id) => ({ id, score: barycentre(id, predecessors, index) }));
      scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
      byRank.set(rank, scored.map((entry) => entry.id));
    }
  }

  return byRank;
}

function positionIndex(byRank: ReadonlyMap<number, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of byRank.values()) {
    row.forEach((id, position) => index.set(id, position));
  }
  return index;
}

function barycentre(
  id: string,
  predecessors: ReadonlyMap<string, string[]>,
  index: ReadonlyMap<string, number>,
): number {
  const sources = predecessors.get(id) ?? [];
  if (sources.length === 0) {
    return index.get(id) ?? 0;
  }
  const total = sources.reduce((sum, source) => sum + (index.get(source) ?? 0), 0);
  return total / sources.length;
}

/**
 * Grid coordinates: each rank is a column, centred vertically. A rank taller
 * than `maxRankHeight` wraps into sub-columns rather than becoming a wall of
 * boxes no one can read.
 */
function toPositions(
  byRank: ReadonlyMap<number, string[]>,
  rankSpacing: number,
  nodeSpacing: number,
  maxRankHeight: number,
): LayoutPositions {
  const tallest = Math.max(1, ...[...byRank.values()].map((row) => Math.min(row.length, maxRankHeight)));
  const positions: Record<string, LayoutPosition> = {};

  // Ranks widen as they wrap, so each column starts after the previous one ends.
  let x = 0;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const row = byRank.get(rank) ?? [];
    const height = Math.min(row.length, maxRankHeight);
    const offset = ((tallest - height) * nodeSpacing) / 2;

    row.forEach((id, index) => {
      positions[id] = {
        x: x + Math.floor(index / maxRankHeight) * SUBCOLUMN_SPACING,
        y: offset + (index % maxRankHeight) * nodeSpacing,
      };
    });

    const subColumns = Math.ceil(row.length / maxRankHeight);
    x += Math.max(rankSpacing, (subColumns - 1) * SUBCOLUMN_SPACING + rankSpacing);
  }

  return positions;
}
