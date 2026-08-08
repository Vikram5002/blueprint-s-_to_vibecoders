/**
 * JSON API payload builders.
 *
 * Pure functions from the analysis context to plain data — no framework types,
 * no I/O — so the API surface is testable without starting a server.
 *
 * The evidence endpoint is the important one. It is what makes "we never
 * hallucinate structure" checkable by a user instead of merely asserted, so it
 * returns the real file, line and source text behind every aggregated edge,
 * never a summary of them.
 */
import { decodeEdgeId, directoryOf, projectGraph, splitFileEdgeKey, type ViewLevel } from '../graph/aggregate.js';
import { computeLayout, type LayoutPositions } from '../graph/layout.js';
import type { Evidence } from '../types/graph.js';
import type { AnalysisContext } from './context.js';

export interface GraphResponse {
  readonly level: ViewLevel;
  readonly expanded: readonly string[];
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
  readonly positions: LayoutPositions;
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly files: number;
    readonly fileEdges: number;
  };
  readonly expandable: readonly string[];
}

export function buildGraphResponse(
  context: AnalysisContext,
  level: ViewLevel,
  expanded: readonly string[],
): GraphResponse {
  const view = projectGraph(context.graph, { level, expanded });

  return {
    level: view.level,
    expanded: view.expanded,
    nodes: view.nodes,
    edges: view.edges,
    positions: computeLayout(view),
    counts: {
      nodes: view.nodes.length,
      edges: view.edges.length,
      files: context.graph.graph.order,
      fileEdges: context.graph.graph.size,
    },
    expandable: view.expandable,
  };
}

export interface NodeNeighbour {
  readonly id: string;
  readonly weight: number;
  readonly importCount: number;
  readonly edgeId: string;
}

export interface NodeResponse {
  readonly id: string;
  readonly kind: 'directory' | 'file';
  readonly files: readonly string[];
  readonly inbound: readonly NodeNeighbour[];
  readonly outbound: readonly NodeNeighbour[];
  readonly externals: readonly { name: string; count: number }[];
}

export function buildNodeResponse(context: AnalysisContext, id: string): NodeResponse | null {
  const isFile = context.graph.graph.hasNode(id);
  const files = isFile
    ? [id]
    : context.graph.graph.filterNodes((filePath) => directoryOf(filePath) === id).sort();

  if (files.length === 0) {
    return null;
  }

  // Project at the level this node lives at, so neighbours are the ones the
  // user is actually looking at rather than raw file edges.
  const view = projectGraph(context.graph, {
    level: 'directory',
    expanded: isFile ? [directoryOf(id)] : [],
  });

  const inbound = view.edges
    .filter((edge) => edge.to === id)
    .map((edge) => ({ id: edge.from, weight: edge.weight, importCount: edge.importCount, edgeId: edge.id }));
  const outbound = view.edges
    .filter((edge) => edge.from === id)
    .map((edge) => ({ id: edge.to, weight: edge.weight, importCount: edge.importCount, edgeId: edge.id }));

  const owned = new Set(files);
  const externals = context.graph.externals
    .filter((external) => external.importers.some((importer) => owned.has(importer)))
    .map((external) => ({
      name: external.name,
      count: external.importers.filter((importer) => owned.has(importer)).length,
    }));

  return {
    id,
    kind: isFile ? 'file' : 'directory',
    files,
    inbound,
    outbound,
    externals,
  };
}

export interface EdgeEvidenceGroup {
  readonly source: string;
  readonly target: string;
  readonly evidence: readonly Evidence[];
}

export interface EdgeResponse {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly importCount: number;
  /** Every source line that produced this edge, grouped by file pair. */
  readonly groups: readonly EdgeEvidenceGroup[];
}

/**
 * Expands an aggregate edge back into the exact source lines beneath it.
 * An edge with no evidence cannot exist (rule 3), so an empty result here means
 * the id did not match anything, not that an edge lacks proof.
 */
export function buildEdgeResponse(context: AnalysisContext, id: string): EdgeResponse | null {
  const endpoints = decodeEdgeId(id);
  if (endpoints === null) {
    return null;
  }

  const view = projectGraph(context.graph, {
    level: 'directory',
    expanded: expansionFor(context, endpoints.from, endpoints.to),
  });
  const edge = view.edges.find((candidate) => candidate.id === id);
  if (edge === undefined) {
    return null;
  }

  const groups: EdgeEvidenceGroup[] = [];
  for (const key of edge.fileEdges) {
    const split = splitFileEdgeKey(key);
    if (split === null || !context.graph.graph.hasEdge(split.source, split.target)) {
      continue;
    }
    const graphEdge = context.graph.graph.edge(split.source, split.target);
    if (graphEdge === undefined) {
      continue;
    }
    groups.push({
      source: split.source,
      target: split.target,
      evidence: context.graph.graph.getEdgeAttribute(graphEdge, 'evidence'),
    });
  }

  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    weight: edge.weight,
    importCount: edge.importCount,
    groups,
  };
}

/**
 * An edge id may name file endpoints, which only exist in the projection when
 * their directories are expanded. Expanding both makes the lookup work for
 * directory-level and file-level ids alike.
 */
function expansionFor(context: AnalysisContext, from: string, to: string): string[] {
  const expansion: string[] = [];
  if (context.graph.graph.hasNode(from)) {
    expansion.push(directoryOf(from));
  }
  if (context.graph.graph.hasNode(to)) {
    expansion.push(directoryOf(to));
  }
  return expansion;
}

export interface ModuleViewResponse {
  readonly nodes: readonly {
    id: string;
    kind: 'module';
    label: string;
    fileCount: number;
    directories: readonly string[];
    /** Files placed here by coupling despite living elsewhere on disk. */
    disagreeingFiles: number;
    provenance: string;
    llmLabelled: boolean;
  }[];
  readonly edges: readonly {
    id: string;
    from: string;
    to: string;
    weight: number;
    importCount: number;
    provenance: string;
  }[];
  readonly positions: LayoutPositions;
  readonly summary: unknown;
  readonly counts: { nodes: number; edges: number; files: number };
}

/**
 * The module-level view: Louvain communities rather than folders.
 *
 * Reuses the same layout as the directory view so switching between them does
 * not also change how the picture is drawn — only what it groups by.
 */
export function buildModuleViewResponse(context: AnalysisContext): ModuleViewResponse {
  const { clustering } = context;

  const disagreementCounts = new Map<string, number>();
  for (const disagreement of clustering.disagreements) {
    disagreementCounts.set(
      disagreement.moduleId,
      (disagreementCounts.get(disagreement.moduleId) ?? 0) + 1,
    );
  }

  const view = {
    level: 'directory' as const,
    expanded: [],
    expandable: [],
    nodes: clustering.modules.map((module) => ({
      id: module.id,
      kind: 'directory' as const,
      path: module.id,
      label: module.label,
      fileCount: module.files.length,
      languages: {},
      parent: null,
      provenance: module.provenance,
    })),
    edges: clustering.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      weight: edge.weight,
      importCount: edge.importCount,
      fileEdges: edge.fileEdges,
      provenance: edge.provenance,
    })),
  };

  return {
    nodes: clustering.modules.map((module) => ({
      id: module.id,
      kind: 'module' as const,
      label: module.label,
      fileCount: module.files.length,
      directories: module.directories,
      disagreeingFiles: disagreementCounts.get(module.id) ?? 0,
      provenance: module.provenance,
      llmLabelled: module.llmLabelled,
    })),
    edges: clustering.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      weight: edge.weight,
      importCount: edge.importCount,
      provenance: edge.provenance,
    })),
    positions: computeLayout(view),
    summary: clustering.summary,
    counts: {
      nodes: clustering.modules.length,
      edges: clustering.edges.length,
      files: context.graph.graph.order,
    },
  };
}

export interface ModuleDetailResponse {
  readonly id: string;
  readonly label: string;
  readonly files: readonly {
    path: string;
    directory: string;
    reason: string;
    explanation: string;
    disagrees: boolean;
  }[];
  readonly directories: readonly string[];
  readonly inbound: readonly { id: string; weight: number; importCount: number; edgeId: string }[];
  readonly outbound: readonly { id: string; weight: number; importCount: number; edgeId: string }[];
}

/** Per-module detail, including why each file landed here (property 3). */
export function buildModuleDetailResponse(
  context: AnalysisContext,
  id: string,
): ModuleDetailResponse | null {
  const module = context.clustering.modules.find((candidate) => candidate.id === id);
  if (module === undefined) {
    return null;
  }

  const disagreeing = new Set(context.clustering.disagreements.map((d) => d.file));
  const assignments = new Map(context.clustering.assignments.map((a) => [a.file, a]));

  return {
    id: module.id,
    label: module.label,
    directories: module.directories,
    files: module.files.map((file) => {
      const assignment = assignments.get(file);
      return {
        path: file,
        directory: assignment?.directory ?? '',
        reason: assignment?.reason ?? 'import-coupling',
        explanation: assignment?.explanation ?? '',
        disagrees: disagreeing.has(file),
      };
    }),
    inbound: context.clustering.edges
      .filter((edge) => edge.to === id)
      .map((edge) => ({ id: edge.from, weight: edge.weight, importCount: edge.importCount, edgeId: edge.id })),
    outbound: context.clustering.edges
      .filter((edge) => edge.from === id)
      .map((edge) => ({ id: edge.to, weight: edge.weight, importCount: edge.importCount, edgeId: edge.id })),
  };
}

/** Every source line behind a module-to-module edge (rule 3 at module level). */
export function buildModuleEdgeResponse(context: AnalysisContext, id: string): EdgeResponse | null {
  const edge = context.clustering.edges.find((candidate) => candidate.id === id);
  if (edge === undefined) {
    return null;
  }

  const groups: EdgeEvidenceGroup[] = [];
  for (const key of edge.fileEdges) {
    const split = splitFileEdgeKey(key);
    if (split === null || !context.graph.graph.hasEdge(split.source, split.target)) {
      continue;
    }
    const graphEdge = context.graph.graph.edge(split.source, split.target);
    if (graphEdge === undefined) {
      continue;
    }
    groups.push({
      source: split.source,
      target: split.target,
      evidence: context.graph.graph.getEdgeAttribute(graphEdge, 'evidence'),
    });
  }

  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    weight: edge.weight,
    importCount: edge.importCount,
    groups,
  };
}

export interface SummaryResponse {
  readonly root: string;
  readonly files: number;
  readonly fileEdges: number;
  readonly imports: {
    readonly total: number;
    readonly internal: number;
    readonly external: number;
    readonly unresolved: number;
  };
  readonly resolutionRate: number;
  readonly unresolvedByReason: Readonly<Partial<Record<string, number>>>;
  readonly externalByReason: Readonly<Partial<Record<string, number>>>;
  readonly unresolvedExamples: readonly { specifier: string; reason: string; file: string; line: number }[];
  readonly parse: {
    readonly filesParsed: number;
    readonly filesFailed: number;
    readonly filesWithSyntaxErrors: number;
    readonly durationMs: number;
  };
  readonly languages: Readonly<Record<string, number>>;
  readonly topExternals: readonly { name: string; count: number }[];
  readonly clustering: {
    readonly moduleCount: number;
    readonly modularity: number;
    readonly resolution: number;
    readonly seed: number;
    readonly minClusterSize: number;
    readonly mergedClusters: number;
    readonly disagreementRate: number;
    readonly crossDirectoryModules: number;
    readonly splitDirectories: number;
    readonly byReason: Readonly<Record<string, number>>;
    /** A few real cases, so the disagreement rate is inspectable. */
    readonly disagreementExamples: readonly {
      file: string;
      directory: string;
      moduleId: string;
      modulePluralityDirectory: string;
    }[];
  };
}

export function buildSummaryResponse(context: AnalysisContext): SummaryResponse {
  const { summary } = context.graph;

  return {
    root: context.root,
    files: context.graph.graph.order,
    fileEdges: context.graph.graph.size,
    imports: {
      total: summary.total,
      internal: summary.internal,
      external: summary.external,
      unresolved: summary.unresolved,
    },
    resolutionRate: summary.resolutionRate,
    unresolvedByReason: summary.unresolvedByReason,
    externalByReason: summary.externalByReason,
    unresolvedExamples: context.graph.unresolved.slice(0, 50).map((item) => ({
      specifier: item.specifier,
      reason: item.reason,
      file: item.evidence.file,
      line: item.evidence.line,
    })),
    parse: {
      filesParsed: context.parse.filesParsed,
      filesFailed: context.parse.filesFailed,
      filesWithSyntaxErrors: context.parse.filesWithSyntaxErrors,
      durationMs: context.parse.durationMs,
    },
    languages: context.ingest.byLanguage,
    topExternals: context.graph.externals.slice(0, 20).map((external) => ({
      name: external.name,
      count: external.count,
    })),
    clustering: {
      ...context.clustering.summary,
      disagreementExamples: context.clustering.disagreements.slice(0, 50),
    },
  };
}
