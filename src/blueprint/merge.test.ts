import { describe, expect, it } from 'vitest';
import { mergeAuthoredConstraints } from './merge.js';
import type { IntentRunResult } from '../pipeline/intent.js';
import type { Constraint, ResolvedSubject } from '../types/constraints.js';

function subject(target: string): ResolvedSubject {
  return { phrase: target, status: 'MODULE', target, reason: null, similarity: 1, alternatives: [] };
}

function extractedConstraint(id: string): Constraint {
  return {
    id,
    relation: 'must-not-import',
    subject: subject('m-a'),
    object: subject('m-b'),
    via: null,
    source: { type: 'readme', location: 'README.md', line: 3, timestamp: null },
    confidence: 0.8,
    lowConfidence: false,
    rawText: 'A must not import B.',
    provenance: 'STATED',
  };
}

function authoredConstraint(id: string): Constraint {
  return {
    id,
    relation: 'must-not-import',
    subject: subject('m-c'),
    object: subject('m-d'),
    via: null,
    source: { type: 'user-authored', location: 'blueprint.txt', line: 1, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText: 'c must not import d',
    provenance: 'STATED',
  };
}

function emptyIntent(): IntentRunResult {
  return {
    constraints: [],
    uncheckable: [],
    summary: {
      documents: 2,
      architecturalStatements: 5,
      constraints: 0,
      uncheckable: 0,
      byUncheckableReason: {
        'style-preference': 0,
        'process-rule': 0,
        'runtime-behaviour': 0,
        'unsupported-relation': 0,
        'descriptive-not-normative': 0,
        'technology-choice': 0,
      },
      byRelation: {
        'must-not-import': 0,
        'may-only-import-via': 0,
        'must-not-cycle': 0,
        'must-be-layer-above': 0,
      },
      lowConfidence: 0,
      evaluable: 0,
      subjects: {
        total: 0,
        module: 0,
        pathPattern: 0,
        regexPattern: 0,
        unresolved: 0,
        byOrigin: { prose: { total: 0, resolved: 0 }, regex: { total: 0, resolved: 0 } },
        resolutionRate: 100,
        byReason: {
          'no-candidate': 0,
          ambiguous: 0,
          'low-similarity': 0,
          'no-such-layer': 0,
          'external-subject': 0,
          'pattern-matched-nothing': 0,
          'pattern-invalid': 0,
          'capture-group-backreference': 0,
        },
      },
      degraded: false,
      incompleteDocuments: 0,
    },
    usage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, cacheHits: 0, cacheMisses: 0 },
    failures: [],
  };
}

describe('mergeAuthoredConstraints', () => {
  it('returns the intent unchanged when there is nothing authored', () => {
    const intent = emptyIntent();
    expect(mergeAuthoredConstraints(intent, [])).toBe(intent);
  });

  it('concatenates authored constraints into the extracted set', () => {
    const intent: IntentRunResult = { ...emptyIntent(), constraints: [extractedConstraint('e1')] };
    const merged = mergeAuthoredConstraints(intent, [authoredConstraint('a1')]);
    expect(merged.constraints.map((c) => c.id).sort()).toEqual(['a1', 'e1']);
  });

  it('recomputes the summary rather than just appending a count', () => {
    const intent: IntentRunResult = { ...emptyIntent(), constraints: [extractedConstraint('e1')] };
    const merged = mergeAuthoredConstraints(intent, [authoredConstraint('a1'), authoredConstraint('a2')]);
    expect(merged.summary.constraints).toBe(3);
    expect(merged.summary.byRelation['must-not-import']).toBe(3);
    expect(merged.summary.evaluable).toBe(3);
  });

  it('leaves uncheckable statements untouched', () => {
    const intent: IntentRunResult = {
      ...emptyIntent(),
      uncheckable: [{ rawText: 'keep functions small', reason: 'style-preference', source: extractedConstraint('e1').source }],
    };
    const merged = mergeAuthoredConstraints(intent, [authoredConstraint('a1')]);
    expect(merged.uncheckable).toBe(intent.uncheckable);
    expect(merged.summary.uncheckable).toBe(1);
  });

  it('does not mutate the extracted constraints array', () => {
    const original = [extractedConstraint('e1')];
    const intent: IntentRunResult = { ...emptyIntent(), constraints: original };
    mergeAuthoredConstraints(intent, [authoredConstraint('a1')]);
    expect(original).toHaveLength(1);
  });
});
