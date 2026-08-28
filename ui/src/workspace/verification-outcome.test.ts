import { describe, expect, it } from 'vitest';
import { deriveOutcome } from './verification-outcome';
import {
  VERIFIED_MOCK,
  VIOLATED_MOCK,
  UNVERIFIABLE_NO_CONSTRAINTS_MOCK,
  UNVERIFIABLE_ALL_UNCHECKED_MOCK,
} from './verification-mocks';
import type { Constraint, ConformanceResult, ResolvedSubject } from './verification-types';
import type { VerificationInput } from './verification-outcome';

/**
 * The hard requirement this whole feature exists to satisfy: there must be
 * no input for which an "unverifiable" result derives to "verified". Every
 * test here is either pinning one of the four mock scenarios to its correct
 * outcome, or trying to construct a case that would break the invariant.
 */

function resolved(target: string): ResolvedSubject {
  return {
    phrase: target,
    status: 'MODULE',
    target,
    reason: null,
    similarity: 1,
    alternatives: [],
  };
}

function emptySummary(
  overrides: Partial<ConformanceResult['summary']> = {},
): ConformanceResult['summary'] {
  return {
    constraints: 0,
    checked: 0,
    unchecked: 0,
    violated: 0,
    satisfied: 0,
    violations: 0,
    bySeverity: { high: 0, medium: 0, low: 0 },
    byKind: { 'forbidden-import': 0, 'bypassed-route': 0, cycle: 0, 'upward-dependency': 0 },
    byUncheckedReason: { 'unresolved-role': 0, 'empty-target': 0 },
    implicatedEdges: 0,
    ...overrides,
  };
}

function constraint(id: string): Constraint {
  return {
    id,
    relation: 'must-not-import',
    subject: resolved('module-a'),
    object: resolved('module-b'),
    via: null,
    source: { type: 'agents-md', location: 'AGENTS.md', line: 1, timestamp: null },
    confidence: 0.9,
    lowConfidence: false,
    rawText: 'a must not import b',
    provenance: 'STATED',
  };
}

describe('deriveOutcome: the four mock scenarios', () => {
  it('VERIFIED_MOCK derives to verified with a non-empty checked list', () => {
    const outcome = deriveOutcome(VERIFIED_MOCK.input);
    expect(outcome.kind).toBe('verified');
    if (outcome.kind !== 'verified') throw new Error('expected verified');
    expect(outcome.checked.length).toBeGreaterThan(0);
    expect(outcome.checked.length).toBe(VERIFIED_MOCK.input.conformance.summary.satisfied);
  });

  it('VIOLATED_MOCK derives to violated', () => {
    const outcome = deriveOutcome(VIOLATED_MOCK.input);
    expect(outcome.kind).toBe('violated');
    if (outcome.kind !== 'violated') throw new Error('expected violated');
    expect(outcome.violations.length).toBeGreaterThan(0);
  });

  it('UNVERIFIABLE_NO_CONSTRAINTS_MOCK derives to unverifiable, reason no-constraints', () => {
    const outcome = deriveOutcome(UNVERIFIABLE_NO_CONSTRAINTS_MOCK.input);
    expect(outcome.kind).toBe('unverifiable');
    if (outcome.kind !== 'unverifiable') throw new Error('expected unverifiable');
    expect(outcome.reason).toBe('no-constraints');
  });

  it('UNVERIFIABLE_ALL_UNCHECKED_MOCK derives to unverifiable, reason all-unchecked', () => {
    const outcome = deriveOutcome(UNVERIFIABLE_ALL_UNCHECKED_MOCK.input);
    expect(outcome.kind).toBe('unverifiable');
    if (outcome.kind !== 'unverifiable') throw new Error('expected unverifiable');
    expect(outcome.reason).toBe('all-unchecked');
  });
});

describe('deriveOutcome: the hard requirement — never unverifiable-as-verified', () => {
  it('a violation always wins, even when most other constraints were satisfied', () => {
    const input: VerificationInput = {
      constraints: [constraint('c1'), constraint('c2'), constraint('c3')],
      conformance: {
        violations: [
          {
            id: 'v1',
            constraintId: 'c3',
            kind: 'forbidden-import',
            severity: 'high',
            severityScore: 0.9,
            severityFactors: [],
            edges: [],
            cycle: [],
            explanation: 'broken',
            constraint: constraint('c3'),
          },
        ],
        unchecked: [],
        summary: emptySummary({
          constraints: 3,
          checked: 3,
          satisfied: 2,
          violated: 1,
          violations: 1,
        }),
      },
    };

    expect(deriveOutcome(input).kind).toBe('violated');
  });

  it('zero checked constraints never derives to verified, regardless of how many were stated', () => {
    const input: VerificationInput = {
      constraints: [constraint('c1'), constraint('c2')],
      conformance: {
        violations: [],
        unchecked: [
          {
            constraintId: 'c1',
            reason: 'unresolved-role',
            explanation: 'no match',
            constraint: constraint('c1'),
          },
          {
            constraintId: 'c2',
            reason: 'unresolved-role',
            explanation: 'no match',
            constraint: constraint('c2'),
          },
        ],
        summary: emptySummary({ constraints: 2, checked: 0, unchecked: 2 }),
      },
    };

    const outcome = deriveOutcome(input);
    expect(outcome.kind).not.toBe('verified');
    expect(outcome.kind).toBe('unverifiable');
  });

  it('an empty constraint list never derives to verified', () => {
    const input: VerificationInput = {
      constraints: [],
      conformance: {
        violations: [],
        unchecked: [],
        summary: emptySummary(),
      },
    };

    expect(deriveOutcome(input).kind).toBe('unverifiable');
  });

  it('"verified" is only reachable with checked.length > 0 — the type itself enforces this', () => {
    // Every input with zero violations and checked > 0 must derive verified,
    // and its checked list must be exactly the satisfied constraints.
    const input: VerificationInput = {
      constraints: [constraint('c1'), constraint('c2')],
      conformance: {
        violations: [],
        unchecked: [],
        summary: emptySummary({ constraints: 2, checked: 2, satisfied: 2 }),
      },
    };

    const outcome = deriveOutcome(input);
    expect(outcome.kind).toBe('verified');
    if (outcome.kind !== 'verified') throw new Error('expected verified');
    expect(outcome.checked.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('a constraint that is both unchecked and not violated is excluded from the checked list', () => {
    const input: VerificationInput = {
      constraints: [constraint('c1'), constraint('c2')],
      conformance: {
        violations: [],
        unchecked: [
          {
            constraintId: 'c2',
            reason: 'empty-target',
            explanation: 'target has no files',
            constraint: constraint('c2'),
          },
        ],
        summary: emptySummary({ constraints: 2, checked: 1, unchecked: 1, satisfied: 1 }),
      },
    };

    const outcome = deriveOutcome(input);
    expect(outcome.kind).toBe('verified');
    if (outcome.kind !== 'verified') throw new Error('expected verified');
    expect(outcome.checked.map((c) => c.id)).toEqual(['c1']);
  });
});
