/**
 * The drift chart: a score per commit, and why it moved.
 *
 * Week 5's standard applied to a time series. A number with no explanation is
 * not explainable, so every point carries the diff entries that moved it and
 * every step reports its own cause. A chart a reader cannot interrogate is a
 * chart they have to take on faith, which is the opposite of what this tool is
 * for.
 */
import { diffSnapshots, type DiffEntry, type SnapshotDiff } from '../conformance/diff.js';
import type { Snapshot } from '../types/snapshots.js';

export interface DriftPoint {
  readonly commit: string;
  readonly shortCommit: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly score: number;
  /** Change from the previous point. 0 at the first. */
  readonly delta: number;
  readonly fileCount: number;
  readonly moduleCount: number;
  readonly edgeCount: number;
  readonly violationCount: number;
  readonly constraintCount: number;
  /**
   * Why the score moved. Empty when it did not — an unchanged score with a
   * long list of causes would mean the causes cancelled out, which is worth
   * seeing, so the entries are kept whenever any exist.
   */
  readonly causes: readonly string[];
  /** Architectural changes at this commit, whether or not they moved drift. */
  readonly changeCount: number;
}

export interface DriftHistory {
  readonly points: readonly DriftPoint[];
  readonly summary: {
    readonly commits: number;
    readonly first: number;
    readonly last: number;
    readonly peak: number;
    readonly trough: number;
    /** Steps where the score moved at all. */
    readonly movingSteps: number;
    /** Steps with architectural change but no drift movement. */
    readonly structuralOnlySteps: number;
    readonly note: string;
  };
}

/** Diffs between each consecutive pair, oldest first. */
export function stepDiffs(snapshots: readonly Snapshot[]): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    diffs.push(diffSnapshots(snapshots[index - 1] as Snapshot, snapshots[index] as Snapshot));
  }
  return diffs;
}

/**
 * Which diff entries are responsible for a change in score.
 *
 * Only violations move drift — the formula's numerator is weighted violations
 * — so a commit that adds fifty edges without breaking a rule moves the chart
 * not at all. That is correct and worth stating in the output, because a flat
 * line next to a large refactor otherwise looks like a bug.
 */
function causesFor(diff: SnapshotDiff): string[] {
  const driftMoving = diff.entries.filter((entry: DiffEntry) => entry.drift !== undefined);

  if (driftMoving.length > 0) {
    return driftMoving.map((entry) => entry.description);
  }

  if (diff.summary.driftDelta !== 0) {
    /**
     * The score moved without a violation appearing or resolving, which means
     * the denominator changed: a constraint was added or removed. Same
     * violations over more rules is a lower score, and that is not an
     * improvement in the code.
     */
    const constraintChanges = diff.entries.filter(
      (entry) => entry.kind === 'constraint-added' || entry.kind === 'constraint-removed',
    );
    if (constraintChanges.length > 0) {
      return [
        'The score moved because the number of stated rules changed, not because the code did:',
        ...constraintChanges.map((entry) => `  ${entry.description}`),
      ];
    }
    return ['Score changed with no violation or constraint difference recorded — investigate.'];
  }

  return [];
}

export function buildDriftHistory(snapshots: readonly Snapshot[]): DriftHistory {
  const diffs = stepDiffs(snapshots);
  const points: DriftPoint[] = [];

  for (const [index, snapshot] of snapshots.entries()) {
    const diff = index === 0 ? null : (diffs[index - 1] as SnapshotDiff);
    const previous = index === 0 ? null : (snapshots[index - 1] as Snapshot);

    points.push({
      commit: snapshot.commit,
      shortCommit: snapshot.commit.slice(0, 7),
      committedAt: snapshot.committedAt,
      subject: snapshot.subject,
      score: snapshot.drift.score,
      delta:
        previous === null ? 0 : Number((snapshot.drift.score - previous.drift.score).toFixed(4)),
      fileCount: snapshot.fileCount,
      moduleCount: snapshot.moduleCount,
      edgeCount: snapshot.edgeCount,
      violationCount: snapshot.violationCount,
      constraintCount: snapshot.constraints.length,
      causes: diff === null ? [] : causesFor(diff),
      changeCount: diff === null ? 0 : diff.entries.length,
    });
  }

  const scores = points.map((point) => point.score);
  const movingSteps = points.slice(1).filter((point) => point.delta !== 0).length;
  const structuralOnlySteps = points
    .slice(1)
    .filter((point) => point.delta === 0 && point.changeCount > 0).length;

  return {
    points,
    summary: {
      commits: points.length,
      first: scores[0] ?? 0,
      last: scores.at(-1) ?? 0,
      peak: scores.length === 0 ? 0 : Math.max(...scores),
      trough: scores.length === 0 ? 0 : Math.min(...scores),
      movingSteps,
      structuralOnlySteps,
      note:
        structuralOnlySteps > 0 && movingSteps === 0
          ? `The line is flat across ${structuralOnlySteps} commit(s) that did change the architecture. ` +
            'Drift only moves when a stated rule is broken or fixed, so structural change with no ' +
            'rule broken is correctly scored as no drift.'
          : 'Drift moves only when a stated rule breaks or is fixed.',
    },
  };
}
