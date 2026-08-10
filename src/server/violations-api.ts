/**
 * The violation list, and one stored snapshot.
 *
 * Both routes are pure projections of data Weeks 8 and 9 already computed.
 * Nothing here detects, scores or diffs anything — Week 10 is a UI week, and a
 * server that recomputed on request would be a second implementation of the
 * conformance rules, quietly free to disagree with the first.
 *
 * The graph overlay on `/api/graph` stays as it is: it carries just enough to
 * mark an edge. This carries what a reader needs to *judge* a violation —
 * the sentence, its location, the import lines — which is too much to attach to
 * every edge in a graph response.
 */
import { createSnapshotStore } from '../store/snapshots.js';
import { resolveCommit } from './history-api.js';
import type { AnalysisContext } from './context.js';
import type { Snapshot } from '../types/snapshots.js';
import type { Severity } from '../types/violations.js';

export interface ViolationEvidenceResponse {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface ViolationEdgeResponse {
  readonly edgeId: string;
  readonly fromFile: string;
  readonly toFile: string;
  readonly fromModule: string;
  readonly toModule: string;
  readonly importCount: number;
  /** Never empty. Rule 3, one level up. */
  readonly evidence: readonly ViolationEvidenceResponse[];
}

export interface ViolationResponse {
  readonly id: string;
  readonly constraintId: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly severityScore: number;
  /** How the score was arrived at, so a surprising rating can be argued with. */
  readonly severityFactors: readonly string[];
  readonly explanation: string;
  readonly cycle: readonly string[];
  readonly edges: readonly ViolationEdgeResponse[];
  /** The STATED side. Kept nested so a client cannot flatten it into the edge. */
  readonly constraint: {
    readonly relation: string;
    readonly subject: string;
    readonly object: string;
    readonly via: string | null;
    readonly rawText: string;
    readonly confidence: number;
    readonly lowConfidence: boolean;
    readonly provenance: 'STATED';
    readonly source: { readonly type: string; readonly location: string; readonly line: number | null };
  };
}

export interface UncheckedResponse {
  readonly constraintId: string;
  readonly reason: string;
  readonly explanation: string;
  readonly rawText: string;
  readonly source: string;
}

/**
 * Why the list is empty, when it is.
 *
 * Week 8 already computes the distinction; this names it so the UI does not
 * have to re-derive it from counts. "No rules were broken" and "no rules were
 * stated" are opposite findings that both render as zero.
 */
export type EmptyReason = 'no-constraints' | 'all-unchecked' | 'all-satisfied' | null;

export interface ViolationsResponse {
  readonly violations: readonly ViolationResponse[];
  readonly unchecked: readonly UncheckedResponse[];
  readonly summary: {
    readonly constraints: number;
    readonly checked: number;
    readonly satisfied: number;
    readonly unchecked: number;
    readonly violated: number;
    readonly violations: number;
    readonly bySeverity: Readonly<Record<Severity, number>>;
    readonly implicatedEdges: number;
  };
  readonly emptyReason: EmptyReason;
  /**
   * Week 7's uncheckable count, surfaced here rather than only in the intent
   * panel. A user looking at three constraints from a document that made
   * sixty-odd architectural statements should not be left thinking the tool
   * read three sentences.
   */
  readonly uncheckableStatements: {
    readonly total: number;
    readonly byReason: Readonly<Record<string, number>>;
    readonly documents: number;
  };
  readonly drift: {
    readonly score: number;
    readonly explanation: string;
  };
}

export function buildViolationsResponse(context: AnalysisContext): ViolationsResponse {
  const { conformance, intent } = context;
  const { summary } = conformance;

  // Highest severity first, then by score, then by id so the order is stable.
  const ranked = [...conformance.violations].sort(
    (a, b) => b.severityScore - a.severityScore || a.id.localeCompare(b.id),
  );

  return {
    violations: ranked.map((violation) => ({
      id: violation.id,
      constraintId: violation.constraintId,
      kind: violation.kind,
      severity: violation.severity,
      severityScore: violation.severityScore,
      severityFactors: violation.severityFactors,
      explanation: violation.explanation,
      cycle: violation.cycle,
      edges: violation.edges.map((edge) => ({
        edgeId: edge.edgeId,
        fromFile: edge.fromFile,
        toFile: edge.toFile,
        fromModule: edge.fromModule,
        toModule: edge.toModule,
        importCount: edge.importCount,
        evidence: edge.evidence.map((entry) => ({
          file: entry.file,
          line: entry.line,
          snippet: entry.snippet,
        })),
      })),
      constraint: {
        relation: violation.constraint.relation,
        subject: violation.constraint.subject.phrase,
        object: violation.constraint.object.phrase,
        via: violation.constraint.via?.phrase ?? null,
        rawText: violation.constraint.rawText,
        confidence: violation.constraint.confidence,
        lowConfidence: violation.constraint.lowConfidence,
        provenance: 'STATED',
        source: {
          type: violation.constraint.source.type,
          location: violation.constraint.source.location,
          line: violation.constraint.source.line,
        },
      },
    })),

    unchecked: conformance.unchecked.map((entry) => ({
      constraintId: entry.constraintId,
      reason: entry.reason,
      explanation: entry.explanation,
      rawText: entry.constraint.rawText,
      source:
        entry.constraint.source.line === null
          ? entry.constraint.source.location
          : `${entry.constraint.source.location}:${entry.constraint.source.line}`,
    })),

    summary: {
      constraints: summary.constraints,
      checked: summary.checked,
      satisfied: summary.satisfied,
      unchecked: summary.unchecked,
      violated: summary.violated,
      violations: summary.violations,
      bySeverity: summary.bySeverity,
      implicatedEdges: summary.implicatedEdges,
    },

    emptyReason: emptyReasonFor(summary),

    uncheckableStatements: {
      total: intent.summary.uncheckable,
      byReason: intent.summary.byUncheckableReason,
      documents: intent.summary.documents,
    },

    drift: {
      score: driftFor(summary),
      explanation: driftExplanation(summary),
    },
  };
}

function emptyReasonFor(summary: AnalysisContext['conformance']['summary']): EmptyReason {
  if (summary.violations > 0) return null;
  if (summary.constraints === 0) return 'no-constraints';
  if (summary.checked === 0) return 'all-unchecked';
  return 'all-satisfied';
}

/**
 * The current run's drift, recomputed from counts already in the summary.
 *
 * This is arithmetic on data the server was handed, not a second evaluation of
 * the rules — the weights are the ones in ARCHITECTURE.md and the numerator
 * comes straight from `bySeverity`.
 */
function driftFor(summary: AnalysisContext['conformance']['summary']): number {
  if (summary.constraints === 0) return 0;
  const weighted = summary.bySeverity.high * 3 + summary.bySeverity.medium * 2 + summary.bySeverity.low;
  return Number(((weighted / summary.constraints) * 100).toFixed(4));
}

function driftExplanation(summary: AnalysisContext['conformance']['summary']): string {
  if (summary.constraints === 0) {
    return 'No constraints were stated, so there is nothing to drift from. This 0 means "not measured", not "perfect".';
  }
  const weighted = summary.bySeverity.high * 3 + summary.bySeverity.medium * 2 + summary.bySeverity.low;
  return (
    `${weighted} weighted point(s) (${summary.bySeverity.high}x3 + ${summary.bySeverity.medium}x2 + ` +
    `${summary.bySeverity.low}x1) over ${summary.constraints} stated constraint(s).`
  );
}

// ---------------------------------------------------------------- snapshot

export type SnapshotResponse =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly reason: string };

/**
 * One recorded snapshot, so the timeline can show what a past commit looked
 * like without recomputing it. Reads only; snapshots are written by
 * `--history=N`.
 */
export function buildSnapshotResponse(context: AnalysisContext, commit: string): SnapshotResponse {
  const store = createSnapshotStore(context.db);
  const available = store.commits();
  if (available.length === 0) {
    return { ok: false, reason: 'No snapshots recorded. Run with --history=N to build them.' };
  }

  const resolved = resolveCommit(commit, available);
  if ('error' in resolved) return { ok: false, reason: resolved.error };

  const snapshot = store.get(resolved.sha);
  return snapshot === null
    ? { ok: false, reason: 'snapshot missing from the store' }
    : { ok: true, snapshot };
}
