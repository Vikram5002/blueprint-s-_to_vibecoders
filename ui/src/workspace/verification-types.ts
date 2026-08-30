/**
 * Mirrors src/types/violations.ts's `ConformanceResult` and src/types/
 * constraints.ts's `Constraint`, hand-duplicated rather than imported —
 * same discipline as ui/src/api-types.ts's header comment: architectural
 * rule 4 says ui/ must not import from src/ directly, so these declarations
 * are kept in step by hand. If the real types change, this file goes stale
 * silently rather than failing to compile; that tradeoff is accepted
 * elsewhere in this package and accepted here for the same reason.
 *
 * Do not add fields here that the real type does not have, and do not
 * rename anything — the whole point of this file is that it is NOT a new
 * shape, it is the existing one, copied.
 */

export type Severity = 'high' | 'medium' | 'low';

export type ViolationKind = 'forbidden-import' | 'bypassed-route' | 'cycle' | 'upward-dependency';

export interface Evidence {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface ViolatingEdge {
  readonly edgeId: string;
  readonly fromModule: string;
  readonly toModule: string;
  readonly fromFile: string;
  readonly toFile: string;
  readonly importCount: number;
  readonly evidence: readonly Evidence[];
}

export type ConstraintRelation =
  'must-not-import' | 'may-only-import-via' | 'must-not-cycle' | 'must-be-layer-above';

export type ConstraintSourceType =
  | 'chat-log'
  | 'agents-md'
  | 'readme'
  | 'adr'
  | 'commit-msg'
  | 'user-authored'
  | 'seeded-from-derived'
  | 'workflow-edge';

export interface ConstraintSource {
  readonly type: ConstraintSourceType;
  readonly location: string;
  readonly line: number | null;
  readonly timestamp: string | null;
}

export type SubjectResolutionStatus = 'MODULE' | 'PATH_PATTERN' | 'REGEX_PATTERN' | 'UNRESOLVED';

export interface ResolvedSubject {
  readonly phrase: string;
  readonly status: SubjectResolutionStatus;
  readonly target: string | null;
  readonly origin?: 'prose' | 'regex';
  readonly reason: string | null;
  readonly similarity: number;
  readonly alternatives: readonly string[];
}

export interface Constraint {
  readonly id: string;
  readonly relation: ConstraintRelation;
  readonly subject: ResolvedSubject;
  readonly object: ResolvedSubject;
  readonly via: ResolvedSubject | null;
  readonly source: ConstraintSource;
  readonly confidence: number;
  readonly lowConfidence: boolean;
  readonly rawText: string;
  /** Always 'STATED'. A constraint is a claim, never traced to an import. */
  readonly provenance: 'STATED';
}

export interface SeverityBreakdown {
  readonly score: number;
  readonly severity: Severity;
  readonly factors: readonly string[];
}

export interface Violation {
  readonly id: string;
  readonly constraintId: string;
  readonly kind: ViolationKind;
  readonly severity: Severity;
  readonly severityScore: number;
  readonly severityFactors: readonly string[];
  readonly edges: readonly ViolatingEdge[];
  readonly cycle: readonly string[];
  readonly explanation: string;
  readonly constraint: Constraint;
}

export type UncheckedReason = 'unresolved-role' | 'empty-target';

export interface UncheckedConstraint {
  readonly constraintId: string;
  readonly reason: UncheckedReason;
  readonly explanation: string;
  readonly constraint: Constraint;
}

export interface ViolationSummary {
  readonly constraints: number;
  readonly checked: number;
  readonly unchecked: number;
  readonly violated: number;
  readonly satisfied: number;
  readonly violations: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byKind: Readonly<Record<ViolationKind, number>>;
  readonly byUncheckedReason: Readonly<Record<UncheckedReason, number>>;
  readonly implicatedEdges: number;
}

export interface ConformanceResult {
  readonly violations: readonly Violation[];
  readonly unchecked: readonly UncheckedConstraint[];
  readonly summary: ViolationSummary;
}
