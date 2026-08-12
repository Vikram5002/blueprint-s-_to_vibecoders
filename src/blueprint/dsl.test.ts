import { describe, expect, it } from 'vitest';
import { compileBlueprint } from './dsl.js';
import type { ResolutionCandidate } from '../conformance/resolve-subject.js';

const MODULES: ResolutionCandidate[] = [
  { moduleId: 'm-domain', label: 'domain', directories: ['src/domain'], fileCount: 3 },
  { moduleId: 'm-infra', label: 'infra', directories: ['src/infra'], fileCount: 2 },
  { moduleId: 'm-api', label: 'api', directories: ['src/api'], fileCount: 2 },
];

function compile(text: string) {
  return compileBlueprint({ text, location: 'blueprint.txt', modules: MODULES });
}

describe('compileBlueprint: line shapes', () => {
  it('compiles must-not-import', () => {
    const result = compile('domain must not import infra');
    expect(result.rejected).toEqual([]);
    expect(result.constraints).toHaveLength(1);
    const c = result.constraints[0];
    if (c === undefined) throw new Error('no constraint');
    expect(c.relation).toBe('must-not-import');
    expect(c.subject.target).toBe('m-domain');
    expect(c.object.target).toBe('m-infra');
  });

  it('compiles may-only-import-via', () => {
    const result = compile('infra may only import domain via api');
    const c = result.constraints[0];
    if (c === undefined) throw new Error('no constraint');
    expect(c.relation).toBe('may-only-import-via');
    expect(c.subject.target).toBe('m-infra');
    expect(c.object.target).toBe('m-domain');
    expect(c.via?.target).toBe('m-api');
  });

  it('compiles must-not-cycle, which is unary', () => {
    const result = compile('domain must not cycle');
    const c = result.constraints[0];
    if (c === undefined) throw new Error('no constraint');
    expect(c.relation).toBe('must-not-cycle');
    expect(c.subject.target).toBe('m-domain');
    expect(c.object.target).toBe('m-domain');
  });

  it('compiles must-be-layer-above', () => {
    const result = compile('api must be layer above domain');
    const c = result.constraints[0];
    if (c === undefined) throw new Error('no constraint');
    expect(c.relation).toBe('must-be-layer-above');
    expect(c.subject.target).toBe('m-api');
    expect(c.object.target).toBe('m-domain');
  });

  it('is case-insensitive on the relation keywords', () => {
    const result = compile('domain MUST NOT IMPORT infra');
    expect(result.constraints).toHaveLength(1);
  });
});

describe('compileBlueprint: provenance and source', () => {
  it('marks every constraint STATED with source type user-authored', () => {
    const result = compile('domain must not import infra');
    const c = result.constraints[0];
    if (c === undefined) throw new Error('no constraint');
    expect(c.provenance).toBe('STATED');
    expect(c.source.type).toBe('user-authored');
    expect(c.source.location).toBe('blueprint.txt');
  });

  it('records the 1-indexed source line', () => {
    const result = compile('# comment\n\ndomain must not import infra');
    expect(result.constraints[0]?.source.line).toBe(3);
  });

  it('scores full confidence for a clearly-worded authored rule', () => {
    // source-weight 1.0 for user-authored, +0.10 for the strong modal "must",
    // both roles resolved cleanly -> clamps to the maximum, 1.
    const result = compile('domain must not import infra');
    expect(result.constraints[0]?.confidence).toBe(1);
    expect(result.constraints[0]?.lowConfidence).toBe(false);
  });
});

describe('compileBlueprint: comments, blanks, and rejects', () => {
  it('skips blank lines and comments', () => {
    const result = compile('\n# a comment\n   \ndomain must not import infra\n');
    expect(result.constraints).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it('rejects a line matching no relation', () => {
    const result = compile('domain hates infra');
    expect(result.constraints).toHaveLength(0);
    expect(result.rejected).toEqual([{ line: 1, text: 'domain hates infra', reason: 'no-relation-matched' }]);
  });

  it('rejects may-only-import-via missing its via phrase', () => {
    // "via" absent entirely falls through to no-relation-matched, since the
    // pattern requires the keyword.
    const result = compile('domain may only import infra');
    expect(result.rejected[0]?.reason).toBe('no-relation-matched');
  });

  it('compiles the same rule stated on two lines as two constraints', () => {
    // Content-derived ids include the source line (see compile.ts's own
    // rationale: the same rule in two places is two independent claims that
    // can go stale independently), so repeating a line is not a duplicate.
    const result = compile('domain must not import infra\ndomain must not import infra');
    expect(result.constraints).toHaveLength(2);
    expect(result.rejected).toEqual([]);
    expect(result.constraints[0]?.id).not.toBe(result.constraints[1]?.id);
  });
});

describe('compileBlueprint: unresolved subjects', () => {
  it('keeps a constraint whose phrase resolves to nothing, flagged UNRESOLVED', () => {
    const result = compile('domain must not import the payments gateway over there');
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0]?.object.status).toBe('UNRESOLVED');
  });
});

describe('compileBlueprint: determinism', () => {
  it('produces byte-identical output across repeated calls', () => {
    const text = 'domain must not import infra\napi must be layer above domain\ninfra must not cycle';
    const first = compile(text);
    const second = compile(text);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('orders constraints by id regardless of source line order', () => {
    const result = compile('api must be layer above domain\ndomain must not import infra');
    const ids = result.constraints.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });
});
