import { describe, expect, it } from 'vitest';
import { compileCandidates, type RawCandidate } from './compile.js';
import { scoreConfidence, CONFIDENCE_THRESHOLD } from './confidence.js';
import { resolveSubject, type ResolutionCandidate } from './resolve-subject.js';
import type { ConstraintSource } from '../types/constraints.js';

const modules: ResolutionCandidate[] = [
  { moduleId: 'm-api', label: 'HTTP API', directories: ['src/api'], fileCount: 8 },
  { moduleId: 'm-db', label: 'Database Access', directories: ['src/database'], fileCount: 6 },
  { moduleId: 'm-core', label: 'Domain Core', directories: ['src/domain'], fileCount: 11 },
];

const source: ConstraintSource = {
  type: 'agents-md',
  location: 'AGENTS.md',
  line: 4,
  timestamp: null,
};

const DOCUMENT = [
  'The api must not import the database directly.',
  'The api may only import the database via the domain.',
  'The domain must not cycle.',
  'The domain must be a layer above the api.',
  'We favour composition over inheritance.',
].join('\n');

function compile(candidates: RawCandidate[], documentText = DOCUMENT): ReturnType<typeof compileCandidates> {
  return compileCandidates({ candidates, source, documentText, modules });
}

describe('the four relations', () => {
  it('compiles must-not-import with both roles resolved', () => {
    const result = compile([
      {
        rawText: 'The api must not import the database directly.',
        relation: 'must-not-import',
        subject: 'the api',
        object: 'the database',
      },
    ]);

    expect(result.constraints).toHaveLength(1);
    const [constraint] = result.constraints;
    expect(constraint?.relation).toBe('must-not-import');
    expect(constraint?.subject.target).toBe('m-api');
    expect(constraint?.object.target).toBe('m-db');
    expect(constraint?.provenance).toBe('STATED');
  });

  it('requires a via for may-only-import-via', () => {
    const result = compile([
      {
        rawText: 'The api may only import the database via the domain.',
        relation: 'may-only-import-via',
        subject: 'the api',
        object: 'the database',
      },
    ]);
    expect(result.constraints).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('incomplete-roles');
  });

  it('accepts must-not-cycle without an object, since it is unary', () => {
    const result = compile([
      { rawText: 'The domain must not cycle.', relation: 'must-not-cycle', subject: 'the domain' },
    ]);
    expect(result.constraints).toHaveLength(1);
  });

  it('rejects a relation outside the four', () => {
    const result = compile([
      { rawText: 'The api must not import the database directly.', relation: 'must-be-tested-by', subject: 'the api', object: 'the database' },
    ]);
    expect(result.constraints).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('unknown-relation');
  });
});

describe('uncheckable statements are counted, not kept', () => {
  it('records a style preference as uncheckable rather than as a constraint', () => {
    const result = compile([
      { rawText: 'We favour composition over inheritance.', uncheckableReason: 'style-preference' },
    ]);
    expect(result.constraints).toEqual([]);
    expect(result.uncheckable).toHaveLength(1);
    expect(result.uncheckable[0]?.reason).toBe('style-preference');
  });

  it('keeps the source on an uncheckable statement, so it can still be shown', () => {
    const result = compile([
      { rawText: 'We favour composition over inheritance.', uncheckableReason: 'style-preference' },
    ]);
    expect(result.uncheckable[0]?.source.location).toBe('AGENTS.md');
  });

  it('counts an explicit not-checkable even without a reason', () => {
    // The schema forces a classification precisely so a statement cannot come
    // back unclassified and vanish. Dropping it here would undercount the
    // number the uncheckable report exists to show.
    const result = compile([
      { rawText: 'We favour composition over inheritance.', relation: 'not-checkable' },
    ]);
    expect(result.constraints).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.uncheckable[0]?.reason).toBe('unsupported-relation');
  });

  it('prefers the stated reason over the generic one', () => {
    const result = compile([
      {
        rawText: 'We favour composition over inheritance.',
        relation: 'not-checkable',
        uncheckableReason: 'style-preference',
      },
    ]);
    expect(result.uncheckable[0]?.reason).toBe('style-preference');
  });

  it('prefers the uncheckable reason when the model supplies both', () => {
    const result = compile([
      {
        rawText: 'We favour composition over inheritance.',
        relation: 'must-not-import',
        subject: 'the api',
        object: 'the database',
        uncheckableReason: 'style-preference',
      },
    ]);
    expect(result.constraints).toEqual([]);
    expect(result.uncheckable).toHaveLength(1);
  });
});

describe('rule 3 for prose — the quote must exist', () => {
  it('rejects a constraint whose sentence is nowhere in the document', () => {
    const result = compile([
      {
        rawText: 'The api must never import the payment gateway.',
        relation: 'must-not-import',
        subject: 'the api',
        object: 'the database',
      },
    ]);
    expect(result.constraints).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('quote-not-in-source');
  });

  it('accepts a quote that wrapped across lines in the source', () => {
    const wrapped = 'The api must not\nimport the database directly.';
    const result = compile(
      [
        {
          rawText: 'The api must not import the database directly.',
          relation: 'must-not-import',
          subject: 'the api',
          object: 'the database',
        },
      ],
      wrapped,
    );
    expect(result.constraints).toHaveLength(1);
  });

  it('accepts a quote whose markdown emphasis the model dropped', () => {
    const emphasised = 'The *api* must not import the `database` directly.';
    const result = compile(
      [
        {
          rawText: 'The api must not import the database directly.',
          relation: 'must-not-import',
          subject: 'the api',
          object: 'the database',
        },
      ],
      emphasised,
    );
    expect(result.constraints).toHaveLength(1);
  });

  it('rejects an absurdly long payload without trying to resolve it', () => {
    const result = compile([{ rawText: 'x'.repeat(900), relation: 'must-not-import', subject: 'a', object: 'b' }]);
    expect(result.rejected[0]?.reason).toBe('malformed-text');
  });
});

describe('determinism', () => {
  const candidates: RawCandidate[] = [
    { rawText: 'The domain must not cycle.', relation: 'must-not-cycle', subject: 'the domain' },
    {
      rawText: 'The api must not import the database directly.',
      relation: 'must-not-import',
      subject: 'the api',
      object: 'the database',
    },
  ];

  it('produces the same ids for the same input', () => {
    expect(compile(candidates).constraints.map((c) => c.id)).toEqual(
      compile(candidates).constraints.map((c) => c.id),
    );
  });

  it('does not depend on the order the model answered in', () => {
    const forward = compile(candidates).constraints.map((c) => c.id);
    const backward = compile([...candidates].reverse()).constraints.map((c) => c.id);
    expect(forward).toEqual(backward);
  });

  it('drops a duplicate rather than counting the same rule twice', () => {
    const result = compile([candidates[1] as RawCandidate, candidates[1] as RawCandidate]);
    expect(result.constraints).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe('duplicate');
  });

  it('treats the same rule in two documents as two constraints', () => {
    const readme: ConstraintSource = { type: 'readme', location: 'README.md', line: 9, timestamp: null };
    const one = compile([candidates[1] as RawCandidate]).constraints[0];
    const two = compileCandidates({
      candidates: [candidates[1] as RawCandidate],
      source: readme,
      documentText: DOCUMENT,
      modules,
    }).constraints[0];
    // Independently stale-able claims, so they stay distinct.
    expect(one?.id).not.toBe(two?.id);
  });
});

describe('confidence', () => {
  const resolved = (phrase: string): ReturnType<typeof resolveSubject> =>
    resolveSubject(phrase, { candidates: modules });

  const base = {
    subject: resolved('the api'),
    object: resolved('the database'),
    via: null,
    quoteVerified: true,
  };

  it('scores a rule in an agent file above a preference in a readme', () => {
    const rule = scoreConfidence({ ...base, sourceType: 'agents-md', rawText: 'The api must never import the database.' });
    const preference = scoreConfidence({ ...base, sourceType: 'readme', rawText: 'We prefer the api not to import the database.' });
    expect(rule.score).toBeGreaterThan(preference.score);
  });

  it('marks a preference as low confidence', () => {
    const preference = scoreConfidence({
      ...base,
      sourceType: 'chat-log',
      rawText: 'We generally prefer the api not to import the database.',
    });
    expect(preference.lowConfidence).toBe(true);
    expect(preference.score).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('penalises a hedged or historical statement', () => {
    const current = scoreConfidence({ ...base, sourceType: 'readme', rawText: 'The api must not import the database.' });
    const historical = scoreConfidence({
      ...base,
      sourceType: 'readme',
      rawText: 'The api used to import the database, but it must not.',
    });
    expect(historical.score).toBeLessThan(current.score);
  });

  it('penalises an unresolved role, because the constraint cannot be checked', () => {
    const bad = scoreConfidence({
      ...base,
      object: resolved('the billing engine'),
      sourceType: 'agents-md',
      rawText: 'The api must not import the billing engine.',
    });
    const good = scoreConfidence({ ...base, sourceType: 'agents-md', rawText: 'The api must not import the database.' });
    expect(bad.score).toBeLessThan(good.score);
  });

  it('explains itself, so a surprising score can be argued with', () => {
    const scored = scoreConfidence({ ...base, sourceType: 'readme', rawText: 'We prefer the api not to import the database.' });
    expect(scored.factors.join(' ')).toContain('preference');
  });

  it('never leaves the 0-1 range', () => {
    const worst = scoreConfidence({
      subject: resolved('nothing at all here'),
      object: resolved('nothing at all there'),
      via: resolved('nothing at all elsewhere'),
      quoteVerified: false,
      sourceType: 'chat-log',
      rawText: 'We might eventually prefer to avoid this, generally.',
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(1);
  });
});
