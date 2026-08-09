/**
 * Flattens the dependency graph into the shape the detector walks.
 *
 * `violations.ts` deliberately knows nothing about graphology. Keeping the
 * library at this boundary means the detector can be tested with three
 * hand-written edges instead of a constructed graph object, and the tests that
 * matter most — is the layer direction the right way round — stay readable.
 */
import type { DependencyGraph } from '../graph/build-graph.js';
import type { FileEdge } from './violations.js';

export function fileEdgesFrom(dependency: DependencyGraph): FileEdge[] {
  const edges = dependency.graph.mapEdges((id, attributes, source, target) => ({
    id,
    from: source,
    to: target,
    importCount: attributes.count,
    evidence: attributes.evidence,
    provenance: attributes.provenance,
  }));

  // Sorted so a run does not inherit graphology's internal iteration order.
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Unresolved import counts per importing file.
 *
 * Feeds the local resolution term in the severity score: a violation found
 * among files whose imports we largely failed to resolve is a violation we are
 * less sure about, because we are only partly seeing that corner of the graph.
 */
export function unresolvedByFile(dependency: DependencyGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of dependency.unresolved) {
    const file = entry.evidence.file;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}
