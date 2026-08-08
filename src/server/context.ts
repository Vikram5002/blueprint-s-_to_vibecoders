/**
 * The analysed repository, held in memory for the lifetime of one run.
 *
 * No persistence: SQLite snapshots are Week 9. Restarting re-analyses.
 */
import type { DependencyGraph } from '../graph/build-graph.js';
import type { IngestSummary } from '../ingest/summary.js';
import type { ParseSummary } from '../parser/parse-repository.js';
import type { ParseFailure } from '../types/symbols.js';
import type { ClusteringResult } from '../types/modules.js';

export interface AnalysisContext {
  /** Absolute repository root. */
  readonly root: string;
  readonly graph: DependencyGraph;
  readonly ingest: IngestSummary;
  readonly parse: ParseSummary;
  readonly parseFailures: readonly ParseFailure[];
  /** Computed once per run — clustering is deterministic, so caching it is safe. */
  readonly clustering: ClusteringResult;
}
