/**
 * A snapshot is the whole architectural picture at one commit.
 *
 * Everything Week 9 does rests on one property: **the same commit must always
 * produce the same snapshot**. A diff between two snapshots is only meaningful
 * if neither side moves on its own, and a drift chart is only readable if a
 * flat line means nothing changed rather than nothing changed *much*.
 *
 * So there is no timestamp of when the snapshot was taken, no run id, no
 * hostname, and no random component anywhere in the identity. The id is a hash
 * of the content. Two machines analysing the same commit produce byte-identical
 * snapshots, and `takenAt` is deliberately absent — the only time that matters
 * is the commit's own.
 */
import type { Severity } from './violations.js';

/** Per-severity weights from docs/ARCHITECTURE.md. */
export const SEVERITY_WEIGHTS: Readonly<Record<Severity, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Drift, and the parts it was built from.
 *
 * ARCHITECTURE.md asks for the components stored alongside the total so the UI
 * can break it down, and Week 5's standard applies: a score the user cannot
 * reason about is worse than no score.
 */
export interface DriftScore {
  /** `(weightedViolations / totalConstraints) * 100`, or 0 with no constraints. */
  readonly score: number;
  readonly weightedViolations: number;
  readonly totalConstraints: number;
  /** Constraints that could be evaluated. Not part of the formula; reported. */
  readonly checkedConstraints: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /** One sentence explaining how this number came about. */
  readonly explanation: string;
}

/** A module as it stood at one commit. Membership is what diffs compare. */
export interface SnapshotModule {
  readonly id: string;
  readonly label: string;
  /** Sorted, so the same membership always serialises identically. */
  readonly files: readonly string[];
}

export interface SnapshotEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly importCount: number;
}

/** A constraint reduced to what a diff needs. The full text lives in the run. */
export interface SnapshotConstraint {
  readonly id: string;
  readonly relation: string;
  readonly subject: string;
  readonly object: string;
  readonly rawText: string;
  readonly source: string;
  readonly confidence: number;
}

export interface SnapshotViolation {
  readonly id: string;
  readonly constraintId: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly explanation: string;
  /** File-level edge ids, sorted. */
  readonly edgeIds: readonly string[];
}

export interface Snapshot {
  /** Content-derived. Same commit, same repository state, same id. */
  readonly id: string;
  /** Full commit sha. */
  readonly commit: string;
  /** Author date of the commit, ISO 8601 — not when this was computed. */
  readonly committedAt: string;
  readonly subject: string;

  readonly fileCount: number;
  readonly edgeCount: number;
  readonly moduleCount: number;
  readonly violationCount: number;

  readonly modules: readonly SnapshotModule[];
  readonly edges: readonly SnapshotEdge[];
  readonly constraints: readonly SnapshotConstraint[];
  readonly violations: readonly SnapshotViolation[];

  /**
   * Correction ids in force when this was taken, sorted.
   *
   * Week 6 recorded these per run; a snapshot needs them too, because two
   * snapshots taken under different corrections are not comparable. A module
   * that "changed" between them may only have been renamed by hand in between.
   */
  readonly activeCorrections: readonly string[];

  readonly drift: DriftScore;
}
