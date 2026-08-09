/**
 * Building and storing snapshots.
 *
 * Deterministic by construction: every list is sorted, every id is a hash of
 * content, and nothing reads the clock. `createdAt` on the stored row is the
 * one exception and is metadata only — it never enters the id and is never
 * diffed, so re-taking a snapshot of the same commit overwrites the row with an
 * identical body.
 */
import { createHash } from 'node:crypto';
import { SEVERITY_WEIGHTS } from '../types/snapshots.js';
import type {
  DriftScore,
  Snapshot,
  SnapshotConstraint,
  SnapshotEdge,
  SnapshotModule,
  SnapshotViolation,
} from '../types/snapshots.js';
import type { Severity } from '../types/violations.js';
import type { ConformanceResult } from '../types/violations.js';
import type { ClusteringResult } from '../types/modules.js';
import type { Constraint } from '../types/constraints.js';
import type { LabelSet } from '../types/labels.js';
import type { FileEdge } from '../conformance/violations.js';
import type { BlueprintDatabase } from './database.js';

export interface BuildSnapshotOptions {
  readonly commit: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly clustering: ClusteringResult;
  readonly labels: LabelSet;
  readonly fileEdges: readonly FileEdge[];
  readonly constraints: readonly Constraint[];
  readonly conformance: ConformanceResult;
  readonly activeCorrections: readonly string[];
  readonly fileCount: number;
}

/**
 * Drift, per docs/ARCHITECTURE.md.
 *
 *     driftScore = (weightedViolations / totalConstraints) * 100
 *     weights: high 3, medium 2, low 1
 *
 * Kept exactly as specified rather than improved. The point of the number is
 * that a reader can recompute it in their head from the violation counts, and
 * every refinement that made it more accurate would make it less checkable.
 *
 * The denominator is *total* constraints, not checked ones. A repository whose
 * rules cannot be evaluated should not score better than one whose rules pass —
 * dividing by the checked subset would let unevaluable rules quietly improve the
 * score, which is the same trap Week 8 avoided by counting `unchecked`
 * separately from `satisfied`.
 */
export function computeDrift(conformance: ConformanceResult): DriftScore {
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const violation of conformance.violations) bySeverity[violation.severity] += 1;

  const weightedViolations =
    bySeverity.high * SEVERITY_WEIGHTS.high +
    bySeverity.medium * SEVERITY_WEIGHTS.medium +
    bySeverity.low * SEVERITY_WEIGHTS.low;

  const totalConstraints = conformance.summary.constraints;
  const score =
    totalConstraints === 0 ? 0 : round((weightedViolations / totalConstraints) * 100);

  return {
    score,
    weightedViolations,
    totalConstraints,
    checkedConstraints: conformance.summary.checked,
    bySeverity,
    explanation:
      totalConstraints === 0
        ? 'No constraints were stated, so there is nothing to drift from. A score of 0 here means "not measured", not "perfect".'
        : `${weightedViolations} weighted violation point(s) ` +
          `(${bySeverity.high}x3 + ${bySeverity.medium}x2 + ${bySeverity.low}x1) ` +
          `over ${totalConstraints} stated constraint(s).`,
  };
}

export function buildSnapshot(options: BuildSnapshotOptions): Snapshot {
  const modules: SnapshotModule[] = options.clustering.modules
    .map((module) => ({
      id: module.id,
      label: options.labels.labels.get(module.id)?.label ?? module.label,
      files: [...module.files].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const edges: SnapshotEdge[] = options.fileEdges
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, importCount: edge.importCount }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const constraints: SnapshotConstraint[] = options.constraints
    .map((constraint) => ({
      id: constraint.id,
      relation: constraint.relation,
      subject: constraint.subject.phrase,
      object: constraint.object.phrase,
      rawText: constraint.rawText,
      source:
        constraint.source.line === null
          ? constraint.source.location
          : `${constraint.source.location}:${constraint.source.line}`,
      confidence: constraint.confidence,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const violations: SnapshotViolation[] = options.conformance.violations
    .map((violation) => ({
      id: violation.id,
      constraintId: violation.constraintId,
      kind: violation.kind,
      severity: violation.severity,
      explanation: violation.explanation,
      edgeIds: violation.edges.map((edge) => edge.edgeId).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const drift = computeDrift(options.conformance);
  const activeCorrections = [...options.activeCorrections].sort();

  const body = {
    commit: options.commit,
    modules,
    edges,
    constraints,
    violations,
    activeCorrections,
    drift,
  };

  return {
    id: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16),
    commit: options.commit,
    committedAt: options.committedAt,
    subject: options.subject,
    fileCount: options.fileCount,
    edgeCount: edges.length,
    moduleCount: modules.length,
    violationCount: violations.length,
    modules,
    edges,
    constraints,
    violations,
    activeCorrections,
    drift,
  };
}

// ---------------------------------------------------------------- storage

export interface SnapshotStore {
  save(snapshot: Snapshot): void;
  get(commit: string): Snapshot | null;
  /** Oldest first, so a chart reads left to right. */
  history(limit?: number): Snapshot[];
  commits(): string[];
  remove(commit: string): boolean;
}

interface SnapshotRow {
  readonly commit: string;
  readonly body: string;
}

export function createSnapshotStore(db: BlueprintDatabase): SnapshotStore {
  return {
    save: (snapshot) => {
      /**
       * Keyed on commit, not on snapshot id.
       *
       * One snapshot per commit is the invariant the diff relies on. Keying on
       * the content hash would let one commit accumulate several rows as the
       * analyser changed, and `history()` would then chart the same commit more
       * than once.
       */
      db.prepare(
        `INSERT INTO snapshots (commit_sha, snapshot_id, committed_at, subject,
                                file_count, edge_count, module_count, violation_count,
                                drift_score, body, created_at)
         VALUES (@commit, @id, @committedAt, @subject, @fileCount, @edgeCount,
                 @moduleCount, @violationCount, @driftScore, @body, @createdAt)
         ON CONFLICT(commit_sha) DO UPDATE SET
           snapshot_id     = excluded.snapshot_id,
           committed_at    = excluded.committed_at,
           subject         = excluded.subject,
           file_count      = excluded.file_count,
           edge_count      = excluded.edge_count,
           module_count    = excluded.module_count,
           violation_count = excluded.violation_count,
           drift_score     = excluded.drift_score,
           body            = excluded.body`,
      ).run({
        commit: snapshot.commit,
        id: snapshot.id,
        committedAt: snapshot.committedAt,
        subject: snapshot.subject,
        fileCount: snapshot.fileCount,
        edgeCount: snapshot.edgeCount,
        moduleCount: snapshot.moduleCount,
        violationCount: snapshot.violationCount,
        driftScore: snapshot.drift.score,
        body: JSON.stringify(snapshot),
        createdAt: new Date().toISOString(),
      });
    },

    get: (commit) => {
      const row = db.prepare('SELECT body FROM snapshots WHERE commit_sha = ?').get(commit) as
        | SnapshotRow
        | undefined;
      return row === undefined ? null : (JSON.parse(row.body) as Snapshot);
    },

    history: (limit) => {
      // Ordered by the commit's own date, then sha, so two commits sharing a
      // timestamp still order identically on every machine.
      const sql =
        'SELECT body FROM snapshots ORDER BY committed_at ASC, commit_sha ASC' +
        (limit === undefined ? '' : ' LIMIT ?');
      const rows = (limit === undefined
        ? db.prepare(sql).all()
        : db.prepare(sql).all(limit)) as SnapshotRow[];
      return rows.map((row) => JSON.parse(row.body) as Snapshot);
    },

    commits: () =>
      (
        db
          .prepare('SELECT commit_sha FROM snapshots ORDER BY committed_at ASC, commit_sha ASC')
          .all() as { commit_sha: string }[]
      ).map((row) => row.commit_sha),

    remove: (commit) => db.prepare('DELETE FROM snapshots WHERE commit_sha = ?').run(commit).changes > 0,
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
