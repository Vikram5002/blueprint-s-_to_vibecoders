/**
 * Where STATED meets DERIVED.
 *
 * A violation is the first object in this project made from both halves of the
 * data model: a constraint somebody wrote, and an edge traced to a real import
 * statement. It is still not a third kind of truth — it is a *comparison*, and
 * it records both sides separately so a reader can disagree with either.
 *
 * That separation is what rule 2 asks for here. A violation never asserts that
 * the code is wrong; it asserts that the code and the documentation disagree,
 * and shows the sentence and the import line that disagree. Which of the two
 * should change is the developer's call, and quite often the answer is the
 * document.
 */
import type { Constraint } from './constraints.js';
import type { Evidence } from './graph.js';

export type Severity = 'high' | 'medium' | 'low';

/**
 * Why an edge breaks a constraint. Distinct from the relation, because one
 * relation can be broken in more than one way — `may-only-import-via` is
 * broken by a direct edge, and separately by the routing module being absent.
 */
export type ViolationKind =
  /** A forbidden edge exists. */
  | 'forbidden-import'
  /** An edge bypasses the module it was supposed to be routed through. */
  | 'bypassed-route'
  /** A dependency cycle touches the constrained module. */
  | 'cycle'
  /** An edge runs upward through a declared layering. */
  | 'upward-dependency';

/**
 * One edge that participates in a violation.
 *
 * `evidence` is copied from the graph edge rather than referenced, because rule
 * 3 has to hold one level up: a violation a user cannot trace to a file and a
 * line is an accusation without a source, which is precisely the thing this
 * project exists not to produce.
 */
export interface ViolatingEdge {
  readonly edgeId: string;
  /** Module ids, matching the constraint's resolved subjects. */
  readonly fromModule: string;
  readonly toModule: string;
  /** File-level source and target, so the report can point at real files. */
  readonly fromFile: string;
  readonly toFile: string;
  /** Distinct import statements behind this edge. */
  readonly importCount: number;
  /** Never empty. Rule 3. */
  readonly evidence: readonly Evidence[];
}

export interface SeverityBreakdown {
  readonly score: number;
  readonly severity: Severity;
  /** Human-readable contributions, so a surprising severity can be argued with. */
  readonly factors: readonly string[];
}

export interface Violation {
  /** Content-derived: same constraint and same edges give the same id. */
  readonly id: string;
  readonly constraintId: string;
  readonly kind: ViolationKind;
  readonly severity: Severity;
  readonly severityScore: number;
  readonly severityFactors: readonly string[];
  /** Every edge that breaks this constraint, sorted by id. */
  readonly edges: readonly ViolatingEdge[];
  /**
   * For `cycle`, the module ids forming the loop, in order. Empty otherwise.
   */
  readonly cycle: readonly string[];
  /** Plain-language description. No jargon, no ids. */
  readonly explanation: string;
  /** The constraint as it was when this was detected, for the report. */
  readonly constraint: Constraint;
}

/**
 * Why a constraint produced no verdict at all.
 *
 * Distinct from "no violations found", and the distinction matters as much as
 * it did in Week 7: a constraint that could not be checked reads exactly like a
 * constraint that passed, and reporting the two together would let a repository
 * look conformant because its rules were unevaluable.
 */
export type UncheckedReason =
  /** A subject, object or via did not resolve to anything in the graph. */
  | 'unresolved-role'
  /** Resolved, but the target holds no files the graph knows about. */
  | 'empty-target';

/**
 * Note what is *not* a reason to skip a constraint: low confidence.
 *
 * A shaky rule is still evaluated, and its doubt is carried by the severity
 * score instead. Skipping it would hide a real disagreement between code and
 * documentation behind a threshold, and the whole point of having a severity
 * formula is that it can express "this might not matter" without having to
 * discard the finding to say so.
 */

export interface UncheckedConstraint {
  readonly constraintId: string;
  readonly reason: UncheckedReason;
  readonly explanation: string;
  readonly constraint: Constraint;
}

export interface ViolationSummary {
  readonly constraints: number;
  /** Constraints actually evaluated against the graph. */
  readonly checked: number;
  readonly unchecked: number;
  readonly violated: number;
  /** Constraints checked and satisfied. The good case, counted explicitly. */
  readonly satisfied: number;
  readonly violations: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byKind: Readonly<Record<ViolationKind, number>>;
  readonly byUncheckedReason: Readonly<Record<UncheckedReason, number>>;
  /** Distinct file-level edges implicated in at least one violation. */
  readonly implicatedEdges: number;
}

export interface ConformanceResult {
  readonly violations: readonly Violation[];
  readonly unchecked: readonly UncheckedConstraint[];
  readonly summary: ViolationSummary;
}
