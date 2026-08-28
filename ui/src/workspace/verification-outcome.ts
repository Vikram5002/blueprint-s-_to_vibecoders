import type { Constraint, ConformanceResult } from './verification-types';

/**
 * The one derivation this feature is built around. `ConformanceResult` alone
 * (violations + unchecked + a summary) is Layer 4's shape, not a UI state —
 * this file is the only place that turns it into a mutually exclusive,
 * exhaustively-handled outcome. `VerificationResultPanel.tsx` never inspects
 * `conformance.summary` or `.violations` directly; it only ever switches on
 * `VerificationOutcome.kind`, which is impossible to construct in a
 * contradictory shape (e.g. "kind: verified" carrying a non-empty violations
 * list) because each branch's fields only exist on that branch. That is what
 * makes "unverifiable rendering as verified" a compile-time impossibility
 * rather than a discipline someone has to remember.
 */

export interface VerificationInput {
  /** Every constraint considered for this piece of generated code. */
  readonly constraints: readonly Constraint[];
  readonly conformance: ConformanceResult;
}

/**
 * Layer 4 already computes this exact three-way split for "why is the
 * violation count zero" (see src/server/violations-api.ts's `EmptyReason`).
 * Reproduced here at the level of one generation's result rather than
 * imported, for the same rule-4 reason every other type in this file is
 * hand-duplicated — but the VALUES and the PRECEDENCE are copied exactly:
 * "no constraints" is checked before "all unchecked", because a document
 * that stated nothing and a document whose rules all failed to resolve are
 * different failures with different fixes.
 */
export type UnverifiableReason = 'no-constraints' | 'all-unchecked';

export type VerificationOutcome =
  | { readonly kind: 'verified'; readonly checked: readonly Constraint[] }
  | { readonly kind: 'violated'; readonly violations: ConformanceResult['violations'] }
  | { readonly kind: 'unverifiable'; readonly reason: UnverifiableReason };

/**
 * Precedence, in order: a real violation always wins — even a single stated
 * rule resolving is enough evidence to call the artefact broken if it broke
 * that rule, regardless of how many other rules went unchecked. Only once
 * there are zero violations does "was anything actually checked" decide
 * between VERIFIED and UNVERIFIABLE.
 */
export function deriveOutcome(input: VerificationInput): VerificationOutcome {
  const { conformance } = input;

  if (conformance.violations.length > 0) {
    return { kind: 'violated', violations: conformance.violations };
  }

  if (conformance.summary.checked === 0) {
    return {
      kind: 'unverifiable',
      reason: conformance.summary.constraints === 0 ? 'no-constraints' : 'all-unchecked',
    };
  }

  return { kind: 'verified', checked: satisfiedConstraints(input) };
}

/**
 * The constraints that were both stated and held — Layer 4's `summary.satisfied`
 * count, but as the actual list "VERIFIED" is required to show rather than a
 * bare number. Derived, not requested separately: a constraint is satisfied
 * iff it is neither violated nor unchecked.
 */
function satisfiedConstraints(input: VerificationInput): readonly Constraint[] {
  const violatedIds = new Set(input.conformance.violations.map((v) => v.constraintId));
  const uncheckedIds = new Set(input.conformance.unchecked.map((u) => u.constraintId));
  return input.constraints.filter((c) => !violatedIds.has(c.id) && !uncheckedIds.has(c.id));
}
