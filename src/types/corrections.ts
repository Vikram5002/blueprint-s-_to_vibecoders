/**
 * User corrections to the clustering.
 *
 * "Losing user corrections between runs is the fastest way to make the tool
 * feel useless" (docs/ARCHITECTURE.md). But reapplying a correction to a module
 * that has since become something else is worse than losing it, because it is
 * wrong and silent. Every correction therefore reports one of three outcomes on
 * every run, and drift is never applied quietly.
 */

export type CorrectionKind = 'rename' | 'merge' | 'split';

export interface SplitSide {
  readonly label: string;
  /** Explicit file list. A split never infers which side a file belongs to. */
  readonly files: readonly string[];
}

export interface Correction {
  /** Content-derived and stable: hash of kind plus the member set. */
  readonly id: string;
  readonly kind: CorrectionKind;
  /**
   * The module's members when the correction was made. This is the key the
   * correction is matched by on later runs — see docs/CORRECTIONS.md.
   */
  readonly members: readonly string[];
  /** New name, for rename and merge. */
  readonly label: string | null;
  /** Sides, for split. Empty otherwise. */
  readonly sides: readonly SplitSide[];
  readonly createdAt: string;
}

export type CorrectionStatus =
  /** Membership matched closely enough and is unchanged. */
  | 'applied'
  /**
   * Matched, but membership moved. Applied, and the change is reported —
   * never silently.
   */
  | 'applied-with-drift'
  /** No current module resembles the stored member set. Not applied. */
  | 'orphaned';

export interface CorrectionOutcome {
  readonly correctionId: string;
  readonly kind: CorrectionKind;
  readonly status: CorrectionStatus;
  /** Jaccard overlap with the best-matching module, 0 when nothing matched. */
  readonly overlap: number;
  /** Module the correction was applied to, when it was. */
  readonly moduleId: string | null;
  /** Files in the module now that were not in the stored set. */
  readonly joined: readonly string[];
  /** Files in the stored set that are no longer in the module. */
  readonly left: readonly string[];
  /**
   * Split only: files present in the module that appear in no side's list.
   * They have no correct answer, so they are placed on neither side and
   * surfaced here rather than guessed at.
   */
  readonly unresolved: readonly string[];
  /** Plain-language summary for the CLI and UI. */
  readonly explanation: string;
}

/**
 * Which corrections were active in a run.
 *
 * Corrections change membership, so two snapshots taken under different
 * corrections are not comparable. Week 9 needs to know what was in force.
 */
export interface CorrectionRunRecord {
  readonly runId: string;
  readonly createdAt: string;
  readonly outcomes: readonly CorrectionOutcome[];
}
