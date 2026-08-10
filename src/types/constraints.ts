/**
 * The STATED half of the data model.
 *
 * Everything before this week was DERIVED: traceable to an import statement in
 * a real file, and therefore true by construction. A constraint is the opposite
 * kind of object. It is a claim someone wrote in prose, and it can be wrong,
 * stale, aspirational, or a description of a system that was never built.
 *
 * Rule 2 exists for this moment. A constraint never becomes an edge, never
 * enters the graph, and never acquires DERIVED provenance no matter how
 * confident the extraction was. The two halves are compared in Week 8; they are
 * never merged.
 */

/**
 * The four relations, and only these four.
 *
 * The test for membership is not "is this architectural?" but "can this be
 * decided by looking at the import graph?". A README says a great deal that is
 * architectural and true and completely uncheckable — "we favour composition
 * over inheritance", "keep functions small", "prefer pure functions". Extracting
 * those produces constraints that can never be evaluated, and an unevaluatable
 * constraint is worse than a missing one: it sits in the denominator of Week
 * 14's violation rate and quietly deflates every number computed from it.
 *
 * So the schema is deliberately narrow, and what falls outside it is counted
 * rather than kept. See UncheckableReason.
 */
export type ConstraintRelation =
  /** `subject` must contain no import edge to `object`. */
  | 'must-not-import'
  /** `subject` may reach `object` only through the module named in `via`. */
  | 'may-only-import-via'
  /** No import cycle may exist within `subject` (or between subject and object). */
  | 'must-not-cycle'
  /** `subject` sits above `object`: edges may run down, never up. */
  | 'must-be-layer-above';

export const CONSTRAINT_RELATIONS: readonly ConstraintRelation[] = [
  'must-not-import',
  'may-only-import-via',
  'must-not-cycle',
  'must-be-layer-above',
];

/**
 * Why an architectural-sounding statement was recognised but not kept.
 *
 * These are counted and reported. The count is a finding in its own right: it
 * measures how much of what a repository says about itself this tool is
 * structurally unable to check, which is a fair and useful limitation to state
 * out loud rather than hide behind a high precision score.
 */
export type UncheckableReason =
  /** A style or taste preference: "favour composition", "keep functions small". */
  | 'style-preference'
  /** About process, not structure: "all PRs need review", "write tests first". */
  | 'process-rule'
  /** Names a runtime or behavioural property no import graph can show. */
  | 'runtime-behaviour'
  /** Architectural but not one of the four relations: "use dependency injection". */
  | 'unsupported-relation'
  /** A description of what the code does, carrying no obligation at all. */
  | 'descriptive-not-normative'
  /** Names a technology choice rather than a dependency rule: "we use Postgres". */
  | 'technology-choice';

export interface UncheckableStatement {
  readonly rawText: string;
  readonly reason: UncheckableReason;
  readonly source: ConstraintSource;
}

export type ConstraintSourceType =
  | 'chat-log'
  | 'agents-md'
  | 'readme'
  | 'adr'
  | 'commit-msg'
  | 'user-authored';

/**
 * Rule 3 applied to STATED data.
 *
 * Rule 3 says an edge without evidence must not exist, because a dependency you
 * cannot point at is a dependency you invented. The same argument applies with
 * more force here: prose extraction is fallible in a way that import parsing is
 * not, so a constraint that cannot be traced back to a sentence someone
 * actually wrote is indistinguishable from a hallucination.
 *
 * `location` is a file path (with line, where known) or a message id.
 */
export interface ConstraintSource {
  readonly type: ConstraintSourceType;
  readonly location: string;
  /** 1-indexed line the statement starts on, where the source has lines. */
  readonly line: number | null;
  /** ISO 8601. Commit dates and chat timestamps; null for plain files. */
  readonly timestamp: string | null;
}

/**
 * How a prose noun phrase was mapped onto something the graph can name.
 *
 * Deliberately mirrors the Week 3 import resolver, including the insistence on
 * a reason code for every failure. The failure mode is the same shape too:
 * quietly guessing which module "the domain layer" means produces a constraint
 * that generates false violations against an innocent module, and a false
 * violation costs more trust than a missed one.
 */
export type SubjectResolutionStatus =
  /** Mapped to one specific module id. */
  | 'MODULE'
  /** Mapped to a path glob — narrower than a module, still checkable. */
  | 'PATH_PATTERN'
  /** Could not be mapped. The constraint is kept but cannot be evaluated. */
  | 'UNRESOLVED';

export type SubjectUnresolvedReason =
  /** The phrase matched nothing in the repository at all. */
  | 'no-candidate'
  /** Several modules matched about equally well; picking one would be a guess. */
  | 'ambiguous'
  /** Matched, but below the confidence floor for acting on it. */
  | 'low-similarity'
  /** Names a layer the repository has no equivalent of ("the service tier"). */
  | 'no-such-layer'
  /** Refers to something outside the repository ("the payments API"). */
  | 'external-subject';

export interface ResolvedSubject {
  /** The noun phrase exactly as it appeared in the prose. */
  readonly phrase: string;
  readonly status: SubjectResolutionStatus;
  /** Module id for MODULE, glob for PATH_PATTERN, null for UNRESOLVED. */
  readonly target: string | null;
  readonly reason: SubjectUnresolvedReason | null;
  /** 0-1 similarity of the winning candidate. 0 when nothing matched. */
  readonly similarity: number;
  /**
   * Runners-up, so an ambiguous result can show its working rather than just
   * refusing. Ordered best first.
   */
  readonly alternatives: readonly string[];
}

export interface Constraint {
  /** Content-derived: same statement extracted twice gives the same id. */
  readonly id: string;
  readonly relation: ConstraintRelation;
  readonly subject: ResolvedSubject;
  readonly object: ResolvedSubject;
  /** Only meaningful for `may-only-import-via`. Null otherwise. */
  readonly via: ResolvedSubject | null;
  readonly source: ConstraintSource;
  /** 0-1. See docs/INTENT.md for what moves it. */
  readonly confidence: number;
  /** Below CONFIDENCE_THRESHOLD. Recorded, reported, and flagged. */
  readonly lowConfidence: boolean;
  /** The sentence this came from, verbatim. Never paraphrased. */
  readonly rawText: string;
  /** STATED, always. There is no code path that sets this to DERIVED. */
  readonly provenance: 'STATED';
}

/**
 * A constraint is evaluable only if every role it uses resolved. An
 * unevaluable constraint is still recorded — the user should see that their
 * README says something the tool could not act on — but it must never be
 * counted as coverage.
 */
export function isEvaluable(constraint: Constraint): boolean {
  const roles = [constraint.subject, constraint.object, constraint.via];
  return roles.every((role) => role === null || role.status !== 'UNRESOLVED');
}

export interface SubjectResolutionSummary {
  /** Every subject, object and via across all constraints. */
  readonly total: number;
  readonly module: number;
  readonly pathPattern: number;
  readonly unresolved: number;
  /** Percentage resolved. 100 when there is nothing to resolve. */
  readonly resolutionRate: number;
  readonly byReason: Readonly<Record<SubjectUnresolvedReason, number>>;
}

export interface ExtractionSummary {
  /** Documents read. */
  readonly documents: number;
  /** Statements the extractor flagged as architectural. */
  readonly architecturalStatements: number;
  /** Of those, how many mapped onto the four relations. */
  readonly constraints: number;
  /** Of those, how many did not, and why. */
  readonly uncheckable: number;
  readonly byUncheckableReason: Readonly<Record<UncheckableReason, number>>;
  readonly byRelation: Readonly<Record<ConstraintRelation, number>>;
  readonly lowConfidence: number;
  readonly evaluable: number;
  readonly subjects: SubjectResolutionSummary;
  /** True when no model was consulted. */
  readonly degraded: boolean;
  /**
   * Documents whose extraction was cut off at the token limit.
   *
   * Reported alongside the constraint count and never folded into it. A run
   * with incomplete documents has not measured those documents at all, and a
   * zero from such a run is not a finding about the repository — it is a fact
   * about the budget. Every consumer of `constraints` has to be able to see
   * this to know whether the number means anything.
   */
  readonly incompleteDocuments: number;
}

export interface IntentResult {
  readonly constraints: readonly Constraint[];
  readonly uncheckable: readonly UncheckableStatement[];
  readonly summary: ExtractionSummary;
}
