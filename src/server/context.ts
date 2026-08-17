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
import type { BlueprintStore } from '../store/blueprint-store.js';
import type { IntentRunResult } from '../pipeline/intent.js';
import type { ConformanceResult } from '../types/violations.js';
import type { BlueprintDatabase } from '../store/database.js';

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
  /**
   * Open store for the authored blueprint (Type-1, Part A.2/A.3). Reading it
   * is how `/api/blueprint/*` reflects what `--blueprint` last compiled;
   * writing to it is the *only* effect the visual editor or the seed-accept
   * endpoint has — never the graph, never `intent`, never `conformance`,
   * which all reflect the run that already finished.
   */
  readonly blueprintStore: BlueprintStore;
  /**
   * Open handle, so the history routes can read snapshots the CLI recorded.
   * They never write: a snapshot costs a worktree and a full re-analysis, and
   * an HTTP handler that does that will be called twice by a page refresh.
   */
  readonly db: BlueprintDatabase;
  /**
   * What the repository says about itself. STATED, and served on its own
   * route so the UI cannot accidentally render a claim inside the graph.
   */
  readonly intent: IntentRunResult;
  /**
   * Where STATED and DERIVED disagree. A comparison, not a third truth — the
   * graph and the constraints are both served unchanged alongside it.
   */
  readonly conformance: ConformanceResult;
}
