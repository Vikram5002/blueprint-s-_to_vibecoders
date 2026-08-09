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
import type { LabelSet } from '../types/labels.js';
import type { CorrectionOutcome } from '../types/corrections.js';
import type { CorrectionsStore } from '../store/corrections-store.js';

export interface AnalysisContext {
  /** Absolute repository root. */
  readonly root: string;
  readonly graph: DependencyGraph;
  readonly ingest: IngestSummary;
  readonly parse: ParseSummary;
  readonly parseFailures: readonly ParseFailure[];
  /** Computed once per run — clustering is deterministic, so caching it is safe. */
  readonly clustering: ClusteringResult;
  /** Module names and where each came from: mechanical, model, or the user. */
  readonly labels: LabelSet;
  /** What happened to each stored correction on this run. */
  readonly correctionOutcomes: readonly CorrectionOutcome[];
  /** Open store, so corrections can be made while the server is up. */
  readonly store: CorrectionsStore;
}
