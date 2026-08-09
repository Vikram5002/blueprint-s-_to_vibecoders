/**
 * Stage 5: compare what the documentation said against what the code does.
 *
 * A thin composition root. All the reasoning lives in `conformance/`, which is
 * deterministic and does not know a model exists — this file only assembles the
 * inputs, and it deliberately has no options to tune. There is nothing to
 * configure about "is this edge present", and a knob here would be a knob that
 * changes what counts as a violation, which is not a thing a user should be
 * able to quietly move.
 */
import { detectViolations } from '../conformance/violations.js';
import { fileEdgesFrom, unresolvedByFile } from '../conformance/graph-adapter.js';
import type { DependencyGraph } from '../graph/build-graph.js';
import type { ClusteringResult } from '../types/modules.js';
import type { Constraint } from '../types/constraints.js';
import type { ConformanceResult } from '../types/violations.js';

export interface ConformanceOptions {
  readonly graph: DependencyGraph;
  readonly clustering: ClusteringResult;
  readonly constraints: readonly Constraint[];
}

export function checkConformance(options: ConformanceOptions): ConformanceResult {
  return detectViolations({
    constraints: options.constraints,
    clustering: options.clustering,
    fileEdges: fileEdgesFrom(options.graph),
    unresolvedByFile: unresolvedByFile(options.graph),
  });
}
