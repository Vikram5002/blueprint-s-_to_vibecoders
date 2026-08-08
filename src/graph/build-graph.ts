/**
 * Stage 2b: graph construction.
 *
 * File nodes and import edges, built in graphology.
 *
 * Architectural rules made concrete here:
 *   - rule 2: every node and edge carries provenance 'DERIVED'. Nothing in this
 *     graph is claimed, everything is traced.
 *   - rule 3: every edge carries non-empty evidence[]. An import that cannot be
 *     tied to a file and line does not become an edge — it is recorded as
 *     unresolved instead, so it is visible rather than silently missing.
 *
 * EXTERNAL targets are kept out of the graph by default, since a node for
 * `react` says nothing about this repository's architecture. They stay
 * queryable on the result, with the list of files that import them.
 */
import { DirectedGraph } from 'graphology';
import type { Evidence, Provenance } from '../types/graph.js';
import type { ParsedFile } from '../types/symbols.js';
import type { ResolutionSummary, ResolvedImport, UnresolvedReason } from '../types/resolution.js';
import type { ResolutionResult } from './resolve.js';

const DERIVED: Provenance = 'DERIVED';

export interface FileNodeAttributes {
  readonly kind: 'file';
  readonly label: string;
  readonly path: string;
  readonly language: string;
  readonly provenance: Provenance;
  readonly llmLabelled: false;
  readonly userCorrected: false;
}

export interface ImportEdgeAttributes {
  readonly kind: 'imports';
  /** Never empty — see rule 3. */
  readonly evidence: readonly Evidence[];
  /** Number of distinct import statements that produced this edge. */
  readonly count: number;
  readonly provenance: Provenance;
}

export interface ExternalDependency {
  /** Package or module name, e.g. `react`, `os.path`. */
  readonly name: string;
  /** Repo-relative paths of the files importing it. */
  readonly importers: readonly string[];
  readonly count: number;
}

export interface UnresolvedImport {
  readonly specifier: string;
  readonly reason: UnresolvedReason;
  readonly evidence: Evidence;
}

export interface DependencyGraph {
  readonly graph: DirectedGraph<FileNodeAttributes, ImportEdgeAttributes>;
  readonly externals: readonly ExternalDependency[];
  readonly unresolved: readonly UnresolvedImport[];
  readonly summary: ResolutionSummary;
}

export interface BuildGraphOptions {
  readonly files: readonly ParsedFile[];
  readonly resolution: ResolutionResult;
}

export function buildDependencyGraph(options: BuildGraphOptions): DependencyGraph {
  const graph = new DirectedGraph<FileNodeAttributes, ImportEdgeAttributes>();

  for (const file of options.files) {
    graph.addNode(file.path, {
      kind: 'file',
      label: file.path,
      path: file.path,
      language: file.language,
      provenance: DERIVED,
      llmLabelled: false,
      userCorrected: false,
    });
  }

  const externals = new Map<string, { importers: Set<string>; count: number }>();
  const unresolved: UnresolvedImport[] = [];

  for (const item of options.resolution.imports) {
    if (item.status === 'INTERNAL') {
      addImportEdge(graph, item);
    } else if (item.status === 'EXTERNAL') {
      recordExternal(externals, item);
    } else if (item.reason !== null) {
      unresolved.push({
        specifier: item.record.specifier,
        reason: item.reason as UnresolvedReason,
        evidence: item.record.evidence,
      });
    }
  }

  return {
    graph,
    externals: toExternalList(externals),
    unresolved,
    summary: options.resolution.summary,
  };
}

function addImportEdge(
  graph: DirectedGraph<FileNodeAttributes, ImportEdgeAttributes>,
  item: ResolvedImport,
): void {
  const source = item.record.evidence.file;
  const target = item.targetPath;

  // Rule 3 in force: no target node means no traceable edge, so none is made.
  if (target === null || source === target || !graph.hasNode(source) || !graph.hasNode(target)) {
    return;
  }

  const existing = graph.edge(source, target);
  if (existing === undefined) {
    graph.addDirectedEdge(source, target, {
      kind: 'imports',
      evidence: [item.record.evidence],
      count: 1,
      provenance: DERIVED,
    });
    return;
  }

  // The same dependency stated twice is one edge with two proofs.
  const evidence = [...graph.getEdgeAttribute(existing, 'evidence'), item.record.evidence];
  graph.setEdgeAttribute(existing, 'evidence', evidence);
  graph.setEdgeAttribute(existing, 'count', evidence.length);
}

function recordExternal(
  externals: Map<string, { importers: Set<string>; count: number }>,
  item: ResolvedImport,
): void {
  const name = item.externalName ?? item.record.specifier;
  const entry = externals.get(name) ?? { importers: new Set<string>(), count: 0 };
  entry.importers.add(item.record.evidence.file);
  entry.count += 1;
  externals.set(name, entry);
}

function toExternalList(
  externals: ReadonlyMap<string, { importers: Set<string>; count: number }>,
): ExternalDependency[] {
  return [...externals.entries()]
    .map(([name, entry]) => ({
      name,
      importers: [...entry.importers].sort(),
      count: entry.count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
