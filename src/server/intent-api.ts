/**
 * The constraints route.
 *
 * Served separately from `/api/graph` and `/api/modules` on purpose. Rule 2
 * says STATED and DERIVED never mix, and the cheapest way to keep a UI honest
 * is to make the mixing physically awkward: a component that wants to draw a
 * claim on the graph has to go and fetch it from somewhere else, deliberately.
 *
 * Every constraint leaves here carrying its provenance, its source location and
 * the verbatim sentence it came from, because those are what let a reader
 * disagree with it — and against a constraint planted in a hostile README, the
 * ability to disagree is the entire defence.
 */
import type { AnalysisContext } from './context.js';
import type {
  ConstraintRelation,
  ExtractionSummary,
  SubjectResolutionStatus,
  UncheckableReason,
} from '../types/constraints.js';

export interface ConstraintRoleResponse {
  readonly phrase: string;
  readonly status: SubjectResolutionStatus;
  readonly target: string | null;
  readonly reason: string | null;
  readonly similarity: number;
}

export interface ConstraintResponse {
  readonly id: string;
  readonly relation: ConstraintRelation;
  readonly subject: ConstraintRoleResponse;
  readonly object: ConstraintRoleResponse;
  readonly via: ConstraintRoleResponse | null;
  readonly confidence: number;
  readonly lowConfidence: boolean;
  /** True when every role resolved, so Week 8 can actually check it. */
  readonly evaluable: boolean;
  readonly rawText: string;
  readonly source: {
    readonly type: string;
    readonly location: string;
    readonly line: number | null;
    readonly timestamp: string | null;
  };
  /** Always 'STATED'. Sent explicitly so the UI never has to assume. */
  readonly provenance: 'STATED';
}

export interface UncheckableResponse {
  readonly rawText: string;
  readonly reason: UncheckableReason;
  readonly location: string;
}

export interface IntentResponse {
  readonly degraded: boolean;
  readonly summary: ExtractionSummary;
  readonly constraints: readonly ConstraintResponse[];
  readonly uncheckable: readonly UncheckableResponse[];
  readonly failures: readonly { readonly location: string; readonly reason: string }[];
  /**
   * Why the panel is empty, in words, when it is empty. "Not attempted" and
   * "nothing stated" look identical in a count and mean opposite things.
   */
  readonly emptyReason: 'not-attempted' | 'no-documents' | 'nothing-stated' | null;
}

export function buildIntentResponse(context: AnalysisContext): IntentResponse {
  const { intent } = context;
  const evaluableIds = new Set(
    intent.constraints
      .filter((constraint) =>
        [constraint.subject, constraint.object, constraint.via].every(
          (role) => role === null || role.status !== 'UNRESOLVED',
        ),
      )
      .map((constraint) => constraint.id),
  );

  return {
    degraded: intent.summary.degraded,
    summary: intent.summary,
    constraints: intent.constraints.map((constraint) => ({
      id: constraint.id,
      relation: constraint.relation,
      subject: role(constraint.subject),
      object: role(constraint.object),
      via: constraint.via === null ? null : role(constraint.via),
      confidence: constraint.confidence,
      lowConfidence: constraint.lowConfidence,
      evaluable: evaluableIds.has(constraint.id),
      rawText: constraint.rawText,
      source: {
        type: constraint.source.type,
        location: constraint.source.location,
        line: constraint.source.line,
        timestamp: constraint.source.timestamp,
      },
      provenance: 'STATED',
    })),
    uncheckable: intent.uncheckable.map((statement) => ({
      rawText: statement.rawText,
      reason: statement.reason,
      location: statement.source.location,
    })),
    failures: intent.failures,
    emptyReason: emptyReason(context),
  };
}

function role(resolved: {
  phrase: string;
  status: SubjectResolutionStatus;
  target: string | null;
  reason: string | null;
  similarity: number;
}): ConstraintRoleResponse {
  return {
    phrase: resolved.phrase,
    status: resolved.status,
    target: resolved.target,
    reason: resolved.reason,
    similarity: resolved.similarity,
  };
}

function emptyReason(context: AnalysisContext): IntentResponse['emptyReason'] {
  const { intent } = context;
  if (intent.constraints.length > 0) return null;
  if (intent.summary.degraded) {
    return intent.summary.documents === 0 ? 'no-documents' : 'not-attempted';
  }
  return intent.summary.documents === 0 ? 'no-documents' : 'nothing-stated';
}
