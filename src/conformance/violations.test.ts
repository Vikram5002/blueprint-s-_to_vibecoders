import { describe, expect, it } from 'vitest';
import { detectViolations, stronglyConnectedComponents, type FileEdge } from './violations.js';
import { scoreSeverity, bandOf, HIGH_THRESHOLD, MEDIUM_THRESHOLD } from './severity.js';
import type { Constraint, ConstraintRelation, ResolvedSubject } from '../types/constraints.js';
import type { ClusteringResult, Module, ModuleEdge } from '../types/modules.js';

// ---------------------------------------------------------------- fixtures

function subject(target: string, phrase = target): ResolvedSubject {
  return { phrase, status: 'MODULE', target, reason: null, similarity: 1, alternatives: [] };
}

function unresolved(phrase: string): ResolvedSubject {
  return { phrase, status: 'UNRESOLVED', target: null, reason: 'no-candidate', similarity: 0, alternatives: [] };
}

function constraint(
  relation: ConstraintRelation,
  subj: ResolvedSubject,
  obj: ResolvedSubject,
  overrides: Partial<Constraint> = {},
): Constraint {
  return {
    id: `c-${relation}-${subj.target ?? subj.phrase}-${obj.target ?? obj.phrase}`,
    relation,
    subject: subj,
    object: obj,
    via: null,
    source: { type: 'agents-md', location: 'AGENTS.md', line: 3, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText: 'A must not import B.',
    provenance: 'STATED',
    ...overrides,
  };
}

function module(id: string, files: string[]): Module {
  return {
    id,
    label: id,
    files,
    directories: [...new Set(files.map((f) => f.split('/').slice(0, -1).join('/')))],
    reason: 'import-coupling',
  } as unknown as Module;
}

function edge(from: string, to: string, importCount = 1): FileEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    importCount,
    evidence: [{ file: from, line: 1, snippet: `import x from '${to}';` }],
    provenance: 'DERIVED',
  };
}

function clustering(modules: Module[], moduleEdges: ModuleEdge[] = []): ClusteringResult {
  return { modules, edges: moduleEdges } as unknown as ClusteringResult;
}

function moduleEdge(from: string, to: string): ModuleEdge {
  return { id: `${from}=>${to}`, from, to, weight: 1, importCount: 1, fileEdges: [], provenance: 'DERIVED' };
}

const MODULES = [module('m-api', ['src/api/a.ts']), module('m-db', ['src/db/b.ts'])];

// ---------------------------------------------------------------- must-not-import

describe('must-not-import', () => {
  it('reports an edge that the constraint forbids', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-import', subject('m-api'), subject('m-db'))],
      clustering: clustering(MODULES),
      fileEdges: [edge('src/api/a.ts', 'src/db/b.ts')],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('forbidden-import');
    expect(result.summary.violated).toBe(1);
    expect(result.summary.satisfied).toBe(0);
  });

  it('reports nothing when the edge does not exist', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-import', subject('m-api'), subject('m-db'))],
      clustering: clustering(MODULES),
      fileEdges: [edge('src/db/b.ts', 'src/api/a.ts')],
    });

    expect(result.violations).toEqual([]);
    // A rule that was checked and held is a result, not an absence.
    expect(result.summary.checked).toBe(1);
    expect(result.summary.satisfied).toBe(1);
  });

  it('carries the evidence from every offending edge (rule 3)', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-import', subject('m-api'), subject('m-db'))],
      clustering: clustering([module('m-api', ['src/api/a.ts', 'src/api/c.ts']), MODULES[1] as Module]),
      fileEdges: [edge('src/api/a.ts', 'src/db/b.ts'), edge('src/api/c.ts', 'src/db/b.ts')],
    });

    const violation = result.violations[0];
    expect(violation?.edges).toHaveLength(2);
    for (const implicated of violation?.edges ?? []) {
      expect(implicated.evidence.length).toBeGreaterThan(0);
      expect(implicated.evidence[0]?.line).toBeGreaterThan(0);
      expect(implicated.evidence[0]?.file).toBe(implicated.fromFile);
    }
  });

  it('explains itself in the words the document used, not module ids', () => {
    const result = detectViolations({
      constraints: [
        constraint('must-not-import', subject('m-api', 'the api layer'), subject('m-db', 'the database')),
      ],
      clustering: clustering(MODULES),
      fileEdges: [edge('src/api/a.ts', 'src/db/b.ts')],
    });

    expect(result.violations[0]?.explanation).toContain('the api layer');
    expect(result.violations[0]?.explanation).toContain('the database');
    expect(result.violations[0]?.explanation).not.toContain('m-api');
  });
});

// ---------------------------------------------------------------- layering

describe('must-be-layer-above', () => {
  /**
   * The direction is the whole test. `must-be-layer-above(A, B)` means A sits
   * above B, so A may depend on B and B may not depend on A. Getting this
   * backwards flags every correct layered design.
   */
  it('permits the downward edge', () => {
    const result = detectViolations({
      constraints: [constraint('must-be-layer-above', subject('m-api'), subject('m-db'))],
      clustering: clustering(MODULES),
      fileEdges: [edge('src/api/a.ts', 'src/db/b.ts')],
    });
    expect(result.violations).toEqual([]);
    expect(result.summary.satisfied).toBe(1);
  });

  it('reports the upward edge', () => {
    const result = detectViolations({
      constraints: [constraint('must-be-layer-above', subject('m-api'), subject('m-db'))],
      clustering: clustering(MODULES),
      fileEdges: [edge('src/db/b.ts', 'src/api/a.ts')],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('upward-dependency');
  });
});

// ---------------------------------------------------------------- routing

describe('may-only-import-via', () => {
  const MODULES3 = [
    module('m-ui', ['ui/src/app.tsx']),
    module('m-core', ['src/core/x.ts']),
    module('m-server', ['src/server/s.ts']),
  ];
  const routed = (overrides: Partial<Constraint> = {}): Constraint =>
    constraint('may-only-import-via', subject('m-ui'), subject('m-core'), {
      via: subject('m-server'),
      ...overrides,
    });

  it('reports a direct edge that bypasses the route', () => {
    const result = detectViolations({
      constraints: [routed()],
      clustering: clustering(MODULES3),
      fileEdges: [edge('ui/src/app.tsx', 'src/core/x.ts')],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('bypassed-route');
  });

  it('permits the routed path, which is the design the rule asked for', () => {
    const result = detectViolations({
      constraints: [routed()],
      clustering: clustering(MODULES3),
      fileEdges: [edge('ui/src/app.tsx', 'src/server/s.ts'), edge('src/server/s.ts', 'src/core/x.ts')],
    });
    expect(result.violations).toEqual([]);
    expect(result.summary.satisfied).toBe(1);
  });

  it('does not fire on transitive reachability through the route', () => {
    // A -> C -> B means A can eventually reach B. That is the rule working.
    const result = detectViolations({
      constraints: [routed()],
      clustering: clustering(MODULES3),
      fileEdges: [
        edge('ui/src/app.tsx', 'src/server/s.ts'),
        edge('src/server/s.ts', 'src/core/x.ts'),
      ],
    });
    expect(result.violations).toEqual([]);
  });

  it('does not blame the routing module for reaching the object', () => {
    const result = detectViolations({
      constraints: [routed()],
      clustering: clustering(MODULES3),
      fileEdges: [edge('src/server/s.ts', 'src/core/x.ts')],
    });
    expect(result.violations).toEqual([]);
  });

  it('reports both the direct edge and nothing else when both paths exist', () => {
    const result = detectViolations({
      constraints: [routed()],
      clustering: clustering(MODULES3),
      fileEdges: [
        edge('ui/src/app.tsx', 'src/core/x.ts'),
        edge('ui/src/app.tsx', 'src/server/s.ts'),
        edge('src/server/s.ts', 'src/core/x.ts'),
      ],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.edges.map((e) => e.edgeId)).toEqual(['ui/src/app.tsx->src/core/x.ts']);
  });
});

// ---------------------------------------------------------------- cycles

describe('must-not-cycle', () => {
  const CYCLE_MODULES = [
    module('m-a', ['a/1.ts']),
    module('m-b', ['b/1.ts']),
    module('m-c', ['c/1.ts']),
  ];

  it('reports a cycle touching the subject', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-cycle', subject('m-a'), subject('m-a'))],
      clustering: clustering(CYCLE_MODULES, [
        moduleEdge('m-a', 'm-b'),
        moduleEdge('m-b', 'm-c'),
        moduleEdge('m-c', 'm-a'),
      ]),
      fileEdges: [edge('a/1.ts', 'b/1.ts'), edge('b/1.ts', 'c/1.ts'), edge('c/1.ts', 'a/1.ts')],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('cycle');
    expect(result.violations[0]?.cycle).toEqual(['m-a', 'm-b', 'm-c']);
  });

  it('ignores a cycle that does not touch the subject', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-cycle', subject('m-a'), subject('m-a'))],
      clustering: clustering(CYCLE_MODULES, [moduleEdge('m-b', 'm-c'), moduleEdge('m-c', 'm-b')]),
      fileEdges: [edge('b/1.ts', 'c/1.ts'), edge('c/1.ts', 'b/1.ts')],
    });
    expect(result.violations).toEqual([]);
  });

  it('reports an acyclic graph as satisfied', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-cycle', subject('m-a'), subject('m-a'))],
      clustering: clustering(CYCLE_MODULES, [moduleEdge('m-a', 'm-b'), moduleEdge('m-b', 'm-c')]),
      fileEdges: [edge('a/1.ts', 'b/1.ts')],
    });
    expect(result.violations).toEqual([]);
    expect(result.summary.satisfied).toBe(1);
  });

  it('reports a three-module tangle once, not once per traceable loop', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-cycle', subject('m-a'), subject('m-a'))],
      clustering: clustering(CYCLE_MODULES, [
        moduleEdge('m-a', 'm-b'),
        moduleEdge('m-b', 'm-a'),
        moduleEdge('m-b', 'm-c'),
        moduleEdge('m-c', 'm-a'),
      ]),
      fileEdges: [edge('a/1.ts', 'b/1.ts'), edge('b/1.ts', 'a/1.ts'), edge('c/1.ts', 'a/1.ts')],
    });
    expect(result.violations).toHaveLength(1);
  });
});

describe('strongly connected components', () => {
  it('finds nothing in a chain', () => {
    const graph = new Map([['a', new Set(['b'])], ['b', new Set(['c'])]]);
    expect(stronglyConnectedComponents(graph).filter((c) => c.length > 1)).toEqual([]);
  });

  it('finds a two-node loop', () => {
    const graph = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]);
    expect(stronglyConnectedComponents(graph).filter((c) => c.length > 1)).toEqual([['a', 'b']]);
  });

  it('handles a self-loop without reporting it as a multi-module cycle', () => {
    const graph = new Map([['a', new Set(['a'])]]);
    expect(stronglyConnectedComponents(graph).filter((c) => c.length > 1)).toEqual([]);
  });

  it('survives a deep chain without blowing the stack', () => {
    // Recursive Tarjan dies here; a 1,900-file repo produces chains like this.
    const graph = new Map<string, Set<string>>();
    for (let i = 0; i < 20_000; i += 1) graph.set(`n${i}`, new Set([`n${i + 1}`]));
    expect(() => stronglyConnectedComponents(graph)).not.toThrow();
  });

  it('gives the same components regardless of insertion order', () => {
    const forward = new Map([['a', new Set(['b'])], ['b', new Set(['a'])], ['c', new Set(['a'])]]);
    const backward = new Map([['c', new Set(['a'])], ['b', new Set(['a'])], ['a', new Set(['b'])]]);
    expect(stronglyConnectedComponents(forward)).toEqual(stronglyConnectedComponents(backward));
  });
});

// ---------------------------------------------------------------- unchecked

describe('constraints that cannot be checked', () => {
  it('does not check a constraint with an unresolved role', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-import', subject('m-api'), unresolved('the billing engine'))],
      clustering: clustering(MODULES),
      fileEdges: [edge('src/api/a.ts', 'src/db/b.ts')],
    });

    expect(result.violations).toEqual([]);
    expect(result.unchecked).toHaveLength(1);
    expect(result.unchecked[0]?.reason).toBe('unresolved-role');
    // Not counted as satisfied: unevaluable is not the same as passing.
    expect(result.summary.satisfied).toBe(0);
    expect(result.summary.checked).toBe(0);
  });

  it('does not check a constraint whose target holds no analysed files', () => {
    const result = detectViolations({
      constraints: [constraint('must-not-import', subject('m-api'), subject('m-ghost'))],
      clustering: clustering(MODULES),
      fileEdges: [],
    });
    expect(result.unchecked[0]?.reason).toBe('empty-target');
  });

  it('still checks a low-confidence constraint, letting severity carry the doubt', () => {
    const result = detectViolations({
      constraints: [
        constraint('must-not-import', subject('m-api'), subject('m-db'), {
          confidence: 0.3,
          lowConfidence: true,
        }),
      ],
      clustering: clustering(MODULES),
      fileEdges: [edge('src/api/a.ts', 'src/db/b.ts')],
    });

    expect(result.unchecked).toEqual([]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.severity).toBe('low');
  });
});

// ---------------------------------------------------------------- severity

describe('severity', () => {
  const base = { constraintConfidence: 1, localResolutionRate: 1, importCount: 1, allEdgesDerived: true };

  it('treats a single clear breach of a certain rule as high', () => {
    // A breach is a breach at one import; entrenchment adjusts within a band.
    expect(scoreSeverity(base).severity).toBe('high');
  });

  it('rises with entrenchment', () => {
    const once = scoreSeverity(base).score;
    const often = scoreSeverity({ ...base, importCount: 40 }).score;
    expect(often).toBeGreaterThan(once);
  });

  it('falls when the rule is shaky', () => {
    expect(scoreSeverity({ ...base, constraintConfidence: 0.3 }).score).toBeLessThan(
      scoreSeverity(base).score,
    );
  });

  it('falls when the surrounding imports resolved poorly', () => {
    expect(scoreSeverity({ ...base, localResolutionRate: 0.4 }).score).toBeLessThan(
      scoreSeverity(base).score,
    );
  });

  it('lets any one weak factor veto, which is why it multiplies', () => {
    // Heavily entrenched but the rule is barely trusted: still not a crisis.
    const entrenchedButDoubtful = scoreSeverity({
      ...base,
      constraintConfidence: 0.2,
      importCount: 100,
    });
    expect(entrenchedButDoubtful.severity).toBe('low');
  });

  it('scores zero when an edge is not DERIVED, because it should not exist', () => {
    const scored = scoreSeverity({ ...base, allEdgesDerived: false });
    expect(scored.score).toBe(0);
    expect(scored.factors.join(' ')).toContain('should not have been built');
  });

  it('explains every contribution', () => {
    const scored = scoreSeverity(base);
    expect(scored.factors.join(' ')).toContain('rule confidence');
    expect(scored.factors.join(' ')).toContain('resolution');
    expect(scored.factors.join(' ')).toContain('entrenchment');
  });

  it('stays inside 0..1 for absurd input', () => {
    const scored = scoreSeverity({
      constraintConfidence: 99,
      localResolutionRate: -5,
      importCount: 1e9,
      allEdgesDerived: true,
    });
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.score).toBeLessThanOrEqual(1);
  });

  it('bands on the documented thresholds', () => {
    expect(bandOf(HIGH_THRESHOLD)).toBe('high');
    expect(bandOf(MEDIUM_THRESHOLD)).toBe('medium');
    expect(bandOf(MEDIUM_THRESHOLD - 0.001)).toBe('low');
  });
});

// ---------------------------------------------------------------- determinism

describe('determinism', () => {
  const constraints = [
    constraint('must-not-import', subject('m-api'), subject('m-db')),
    constraint('must-be-layer-above', subject('m-api'), subject('m-db')),
  ];
  const edges = [edge('src/api/a.ts', 'src/db/b.ts'), edge('src/db/b.ts', 'src/api/a.ts')];

  it('produces byte-identical output across repeated runs', () => {
    const once = detectViolations({ constraints, clustering: clustering(MODULES), fileEdges: edges });
    const twice = detectViolations({ constraints, clustering: clustering(MODULES), fileEdges: edges });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('does not depend on the order constraints or edges are supplied in', () => {
    const forward = detectViolations({ constraints, clustering: clustering(MODULES), fileEdges: edges });
    const backward = detectViolations({
      constraints: [...constraints].reverse(),
      clustering: clustering(MODULES),
      fileEdges: [...edges].reverse(),
    });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it('gives the same violation id for the same constraint and edges', () => {
    const a = detectViolations({ constraints, clustering: clustering(MODULES), fileEdges: edges });
    const b = detectViolations({ constraints, clustering: clustering(MODULES), fileEdges: edges });
    expect(a.violations.map((v) => v.id)).toEqual(b.violations.map((v) => v.id));
  });
});
