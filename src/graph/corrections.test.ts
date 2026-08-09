import { describe, expect, it } from 'vitest';
import { applyCorrections, correctionId, DEFAULT_MATCH_THRESHOLD } from './corrections.js';
import { jaccardSets } from './partition.js';
import type { Correction } from '../types/corrections.js';

function correction(overrides: Partial<Correction> & Pick<Correction, 'kind' | 'members'>): Correction {
  return {
    id: correctionId(overrides.kind, overrides.members),
    label: null,
    sides: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const groups = (record: Record<string, string[]>) => new Map(Object.entries(record));

describe('jaccardSets', () => {
  it('scores identical sets 1 and disjoint sets 0', () => {
    expect(jaccardSets(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccardSets(['a'], ['b'])).toBe(0);
  });

  it('treats two empty sets as identical', () => {
    expect(jaccardSets([], [])).toBe(1);
  });

  it('measures partial overlap', () => {
    // 2 shared of 4 combined.
    expect(jaccardSets(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5, 10);
  });
});

describe('applied — membership unchanged', () => {
  it('reapplies a rename and reports no drift', () => {
    const stored = correction({ kind: 'rename', members: ['a.ts', 'b.ts'], label: 'Auth' });
    const result = applyCorrections(groups({ 'module-000': ['a.ts', 'b.ts'] }), [stored]);

    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe('applied');
    expect(outcome?.overlap).toBe(1);
    expect(outcome?.joined).toEqual([]);
    expect(outcome?.left).toEqual([]);
    expect(outcome?.explanation).toContain('unchanged');
    expect([...result.labels.values()]).toContain('Auth');
  });

  it('moves every member into one unit for a merge', () => {
    const stored = correction({
      kind: 'merge',
      members: ['a.ts', 'b.ts', 'c.ts'],
      label: 'Combined',
    });
    const result = applyCorrections(
      groups({ 'module-000': ['a.ts', 'b.ts'], 'module-001': ['c.ts'] }),
      [stored],
    );

    const targets = new Set(['a.ts', 'b.ts', 'c.ts'].map((f) => result.overrides.get(f)));
    expect(targets.size).toBe(1);
    expect(result.outcomes[0]?.status).toBe('applied');
  });
});

describe('applied-with-drift — never silent', () => {
  it('names the files that joined and left', () => {
    const stored = correction({
      kind: 'rename',
      members: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      label: 'Auth',
    });
    // c.ts left, e.ts joined: 3 shared of 5 combined = 0.6.
    const result = applyCorrections(
      groups({ 'module-000': ['a.ts', 'b.ts', 'd.ts', 'e.ts'] }),
      [stored],
    );

    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe('applied-with-drift');
    expect(outcome?.joined).toEqual(['e.ts']);
    expect(outcome?.left).toEqual(['c.ts']);
    expect(outcome?.explanation).toContain('1 file joined');
    expect(outcome?.explanation).toContain('1 left');
  });

  it('still applies the correction despite the drift', () => {
    const stored = correction({ kind: 'rename', members: ['a.ts', 'b.ts', 'c.ts'], label: 'Auth' });
    const result = applyCorrections(groups({ 'module-000': ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }), [stored]);

    expect(result.outcomes[0]?.status).toBe('applied-with-drift');
    expect([...result.labels.values()]).toContain('Auth');
  });
});

describe('orphaned — below threshold', () => {
  it('does not reapply when the module is barely recognisable', () => {
    const stored = correction({
      kind: 'rename',
      members: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      label: 'Auth',
    });
    // Only a.ts survives: 1 shared of 7 combined = 0.14.
    const result = applyCorrections(
      groups({ 'module-000': ['a.ts', 'x.ts', 'y.ts', 'z.ts'] }),
      [stored],
    );

    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe('orphaned');
    expect(outcome?.moduleId).toBeNull();
    expect(result.overrides.size).toBe(0);
    expect(result.labels.size).toBe(0);
    expect(outcome?.explanation).toContain('Not reapplied');
  });

  it('orphans rather than matching a module that shares nothing', () => {
    const stored = correction({ kind: 'rename', members: ['gone.ts'], label: 'Ghost' });
    const result = applyCorrections(groups({ 'module-000': ['other.ts'] }), [stored]);

    expect(result.outcomes[0]?.status).toBe('orphaned');
    expect(result.outcomes[0]?.overlap).toBe(0);
  });

  it('reports the overlap it found, so the threshold is inspectable', () => {
    const stored = correction({ kind: 'rename', members: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] });
    const result = applyCorrections(groups({ 'module-000': ['a.ts', 'b.ts', 'x.ts', 'y.ts'] }), [stored]);

    // 2 shared of 6 combined = 0.33, below 0.6.
    expect(result.outcomes[0]?.status).toBe('orphaned');
    expect(result.outcomes[0]?.overlap).toBeCloseTo(1 / 3, 5);
  });

  it('honours a custom threshold', () => {
    const stored = correction({ kind: 'rename', members: ['a.ts', 'b.ts'], label: 'X' });
    const current = groups({ 'module-000': ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }); // overlap 0.5

    expect(applyCorrections(current, [stored], 0.6)[0]?.status ?? applyCorrections(current, [stored], 0.6).outcomes[0]?.status).toBe(
      'orphaned',
    );
    expect(applyCorrections(current, [stored], 0.4).outcomes[0]?.status).toBe('applied-with-drift');
  });
});

describe('split — a file in neither side has no correct answer', () => {
  it('assigns each side and leaves unclaimed files alone', () => {
    const stored = correction({
      kind: 'split',
      members: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      sides: [
        { label: 'Left', files: ['a.ts', 'b.ts'] },
        { label: 'Right', files: ['c.ts', 'd.ts'] },
      ],
    });
    // e.ts appeared after the split was made and is on neither list.
    const result = applyCorrections(
      groups({ 'module-000': ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }),
      [stored],
    );

    const outcome = result.outcomes[0];
    expect(outcome?.unresolved).toEqual(['e.ts']);
    expect(outcome?.explanation).toContain('neither side');

    // Placed nowhere — not guessed into either side.
    expect(result.overrides.has('e.ts')).toBe(false);
    expect(result.overrides.get('a.ts')).toBe(result.overrides.get('b.ts'));
    expect(result.overrides.get('c.ts')).toBe(result.overrides.get('d.ts'));
    expect(result.overrides.get('a.ts')).not.toBe(result.overrides.get('c.ts'));
  });

  it('reports no unresolved files when every file is claimed', () => {
    const stored = correction({
      kind: 'split',
      members: ['a.ts', 'b.ts'],
      sides: [
        { label: 'Left', files: ['a.ts'] },
        { label: 'Right', files: ['b.ts'] },
      ],
    });
    const result = applyCorrections(groups({ 'module-000': ['a.ts', 'b.ts'] }), [stored]);

    expect(result.outcomes[0]?.unresolved).toEqual([]);
    expect(result.outcomes[0]?.status).toBe('applied');
  });

  it('ignores a side naming a file that no longer exists', () => {
    const stored = correction({
      kind: 'split',
      members: ['a.ts', 'b.ts', 'c.ts'],
      sides: [
        { label: 'Left', files: ['a.ts', 'deleted.ts'] },
        { label: 'Right', files: ['b.ts', 'c.ts'] },
      ],
    });
    const result = applyCorrections(groups({ 'module-000': ['a.ts', 'b.ts', 'c.ts'] }), [stored]);

    expect(result.overrides.has('deleted.ts')).toBe(false);
    expect(result.overrides.has('a.ts')).toBe(true);
  });
});

describe('determinism', () => {
  it('produces identical output regardless of correction order', () => {
    const a = correction({ kind: 'rename', members: ['a.ts', 'b.ts'], label: 'A' });
    const b = correction({ kind: 'rename', members: ['c.ts', 'd.ts'], label: 'B' });
    const current = groups({ 'module-000': ['a.ts', 'b.ts'], 'module-001': ['c.ts', 'd.ts'] });

    const forward = applyCorrections(current, [a, b]);
    const backward = applyCorrections(current, [b, a]);

    expect(JSON.stringify(backward.outcomes)).toBe(JSON.stringify(forward.outcomes));
    expect([...backward.overrides.entries()].sort()).toEqual([...forward.overrides.entries()].sort());
  });

  it('breaks a tie between equally matching modules on module id', () => {
    const stored = correction({ kind: 'rename', members: ['a.ts'], label: 'X' });
    const current = groups({ 'module-001': ['a.ts'], 'module-000': ['a.ts'] });

    for (let run = 0; run < 5; run += 1) {
      expect(applyCorrections(current, [stored]).outcomes[0]?.moduleId).toBe('module-000');
    }
  });

  it('gives the same correction id for the same members in any order', () => {
    expect(correctionId('rename', ['b.ts', 'a.ts'])).toBe(correctionId('rename', ['a.ts', 'b.ts']));
    expect(correctionId('rename', ['a.ts'])).not.toBe(correctionId('merge', ['a.ts']));
  });
});

describe('threshold', () => {
  it('defaults to 0.6', () => {
    expect(DEFAULT_MATCH_THRESHOLD).toBe(0.6);
  });

  it('accepts a module that grew by two thirds', () => {
    const stored = correction({ kind: 'rename', members: ['a.ts', 'b.ts', 'c.ts'], label: 'X' });
    // 3 shared of 5 combined = 0.6, exactly at the boundary.
    const result = applyCorrections(groups({ 'module-000': ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }), [
      stored,
    ]);
    expect(result.outcomes[0]?.status).toBe('applied-with-drift');
  });
});

describe('no corrections', () => {
  it('returns nothing to do', () => {
    const result = applyCorrections(groups({ 'module-000': ['a.ts'] }), []);
    expect(result.outcomes).toEqual([]);
    expect(result.overrides.size).toBe(0);
  });
});
