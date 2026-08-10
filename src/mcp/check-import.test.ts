import { describe, expect, it } from 'vitest';
import { checkImport, shortestPath } from './check-import.js';
import { detectViolations, type FileEdge } from '../conformance/violations.js';
import type { Constraint, ConstraintRelation, ResolvedSubject } from '../types/constraints.js';
import type { ClusteringResult, ModuleNode, ModuleEdge } from '../types/modules.js';

// ---------------------------------------------------------------- fixtures
// Deliberately the same shapes as violations.test.ts, so the agreement tests
// at the bottom are comparing like with like.

function subject(target: string, phrase = target): ResolvedSubject {
  return { phrase, status: 'MODULE', target, reason: null, similarity: 1, alternatives: [] };
}

function unresolved(phrase: string): ResolvedSubject {
  return {
    phrase,
    status: 'UNRESOLVED',
    target: null,
    reason: 'no-candidate',
    similarity: 0,
    alternatives: [],
  };
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

function module(id: string, files: string[]): ModuleNode {
  return {
    id,
    label: id,
    files,
    directories: [...new Set(files.map((f) => f.split('/').slice(0, -1).join('/')))],
  } as unknown as ModuleNode;
}

function moduleEdge(from: string, to: string): ModuleEdge {
  return { id: `${from}=>${to}`, from, to, weight: 1, importCount: 1, fileEdges: [], provenance: 'DERIVED' };
}

function edge(from: string, to: string): FileEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    importCount: 1,
    evidence: [{ file: from, line: 1, snippet: `import x from '${to}';` }],
    provenance: 'DERIVED',
  };
}

function clustering(modules: ModuleNode[], edges: ModuleEdge[] = []): ClusteringResult {
  return { modules, edges } as unknown as ClusteringResult;
}

const MODULES = [
  module('m-parser', ['src/parser/parse.ts']),
  module('m-llm', ['src/llm/anthropic.ts']),
  module('m-api', ['src/api/handler.ts']),
];

function check(
  from: string,
  to: string,
  constraints: Constraint[],
  modules: ModuleNode[] = MODULES,
  edges: ModuleEdge[] = [],
  fileEdges: FileEdge[] = [],
) {
  return checkImport({ from, to, constraints, clustering: clustering(modules, edges), fileEdges });
}

// ---------------------------------------------------------------- the verdicts

describe('the answer an agent gets before writing the line', () => {
  it('forbids the import the documentation forbids, and quotes the sentence', () => {
    const result = check('src/parser/parse.ts', 'src/llm/anthropic.ts', [
      constraint('must-not-import', subject('m-parser'), subject('m-llm'), {
        rawText: 'parser/ and graph/ must NEVER import from llm/.',
      }),
    ]);

    expect(result.verdict).toBe('forbidden');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe('forbidden-import');
    // The agent has to be able to quote *why*, not just be told no.
    expect(result.explanation).toContain('must NEVER import from llm/');
    expect(result.explanation).toContain('AGENTS.md:3');
  });

  it('allows an import no stated rule covers, and says that is what it means', () => {
    const result = check('src/api/handler.ts', 'src/parser/parse.ts', [
      constraint('must-not-import', subject('m-parser'), subject('m-llm')),
    ]);

    expect(result.verdict).toBe('allowed');
    expect(result.findings).toEqual([]);
    expect(result.constraintsConsidered).toBe(1);
  });

  it('distinguishes "nothing forbids it" from "the architecture endorses it"', () => {
    // No constraints at all. A bare "allowed" here would be a much stronger
    // claim than the tool is entitled to make.
    const result = check('src/api/handler.ts', 'src/parser/parse.ts', []);

    expect(result.verdict).toBe('allowed');
    expect(result.explanation).toContain('no stated rule applies');
    expect(result.constraintsConsidered).toBe(0);
  });

  it('does not answer at all when a path does not resolve', () => {
    const result = check('src/api/handler.ts', 'src/brand/new/file.ts', [
      constraint('must-not-import', subject('m-parser'), subject('m-llm')),
    ]);

    expect(result.verdict).toBe('cannot-determine');
    expect(result.to.status).toBe('unknown');
    expect(result.to.reason).toContain('matched no file');
    expect(result.explanation).toContain('would be a guess');
  });

  it('refuses to say "allowed" when a rule that might apply could not be evaluated', () => {
    const result = check('src/parser/parse.ts', 'src/llm/anthropic.ts', [
      constraint('must-not-import', unresolved('the parser layer'), subject('m-llm')),
    ]);

    expect(result.verdict).toBe('cannot-determine');
    expect(result.indeterminate).toHaveLength(1);
    expect(result.explanation).toContain('not as permission');
  });

  it('still answers "forbidden" when one rule breaks and another is unevaluable', () => {
    // A definite breach is a definite answer. Downgrading it to
    // cannot-determine because some unrelated rule was fuzzy would let a real
    // violation through.
    const result = check('src/parser/parse.ts', 'src/llm/anthropic.ts', [
      constraint('must-not-import', subject('m-parser'), subject('m-llm')),
      constraint('must-not-import', unresolved('the parser layer'), subject('m-llm'), {
        id: 'c-fuzzy',
      }),
    ]);

    expect(result.verdict).toBe('forbidden');
  });

  it('does not list unevaluable rules that had nothing to do with the question', () => {
    const result = check('src/api/handler.ts', 'src/parser/parse.ts', [
      constraint('must-not-import', unresolved('the billing subsystem'), subject('m-llm')),
    ]);

    expect(result.indeterminate).toEqual([]);
    expect(result.verdict).toBe('allowed');
  });
});

describe('an unread document is not an absent rule', () => {
  /**
   * Found in Week 11 acceptance, on this repository. The Gemini daily quota
   * was exhausted, CLAUDE.md was never read, and asking whether `parser/` may
   * import `llm/` came back "allowed — no stated rule applies" against a
   * document that forbids exactly that in capital letters.
   *
   * Same shape as the truncation bug in Week 10 and the drift bug before it:
   * an empty result and an unmeasured one are byte-identical unless something
   * insists on telling them apart. Here it matters most, because this is the
   * answer an agent acts on before writing the line.
   */
  const healthy = { degraded: false, failures: 0, incompleteDocuments: 0 };

  function withHealth(extraction: typeof healthy) {
    return checkImport({
      from: 'src/parser/parse.ts',
      to: 'src/llm/anthropic.ts',
      constraints: [],
      clustering: clustering(MODULES),
      fileEdges: [],
      extraction,
    });
  }

  it('says allowed when every document was read and none forbids it', () => {
    const result = withHealth(healthy);
    expect(result.verdict).toBe('allowed');
    expect(result.extractionIncomplete).toBe(false);
    expect(result.explanation).toContain('Every document was read');
  });

  it.each([
    ['a document failed to read', { ...healthy, failures: 1 }],
    ['no model was available', { ...healthy, degraded: true }],
    ['a document was truncated', { ...healthy, incompleteDocuments: 1 }],
  ])('refuses to say allowed when %s', (_name, extraction) => {
    const result = withHealth(extraction);
    expect(result.verdict).toBe('cannot-determine');
    expect(result.extractionIncomplete).toBe(true);
    expect(result.explanation).toContain('did not finish reading');
  });

  it('still says forbidden when a rule breaks, even with documents unread', () => {
    // Missing data cannot un-find a finding.
    const result = checkImport({
      from: 'src/parser/parse.ts',
      to: 'src/llm/anthropic.ts',
      constraints: [constraint('must-not-import', subject('m-parser'), subject('m-llm'))],
      clustering: clustering(MODULES),
      fileEdges: [],
      extraction: { degraded: false, failures: 3, incompleteDocuments: 0 },
    });
    expect(result.verdict).toBe('forbidden');
  });
});

// ---------------------------------------------------------------- directions

describe('layering, which is the easy thing to get backwards', () => {
  const layered = [
    constraint('must-be-layer-above', subject('m-api'), subject('m-parser'), {
      rawText: 'The API sits above the parser.',
    }),
  ];

  it('allows the downward import', () => {
    expect(check('src/api/handler.ts', 'src/parser/parse.ts', layered).verdict).toBe('allowed');
  });

  it('forbids the upward one', () => {
    const result = check('src/parser/parse.ts', 'src/api/handler.ts', layered);
    expect(result.verdict).toBe('forbidden');
    expect(result.findings[0]?.kind).toBe('upward-dependency');
  });
});

describe('may-only-import-via keeps the detector’s direct-edge rule', () => {
  const routed = [
    constraint('may-only-import-via', subject('m-api'), subject('m-llm'), {
      via: subject('m-parser'),
      rawText: 'The API may reach the model only through the parser.',
    }),
  ];

  it('forbids the direct import that bypasses the route', () => {
    const result = check('src/api/handler.ts', 'src/llm/anthropic.ts', routed);
    expect(result.verdict).toBe('forbidden');
    expect(result.findings[0]?.kind).toBe('bypassed-route');
  });

  it('allows the route itself to make the import', () => {
    // An import written from inside the routing module is the route working,
    // not a breach of it.
    expect(check('src/parser/parse.ts', 'src/llm/anthropic.ts', routed).verdict).toBe('allowed');
  });
});

describe('cycles, which depend on the graph that already exists', () => {
  const noCycles = [
    constraint('must-not-cycle', subject('m-api'), subject('m-api'), {
      rawText: 'The API must not participate in a dependency cycle.',
    }),
  ];

  it('forbids an import that would close a loop', () => {
    // m-llm already reaches m-api, so m-api -> m-llm closes it.
    const result = check(
      'src/api/handler.ts',
      'src/llm/anthropic.ts',
      noCycles,
      MODULES,
      [moduleEdge('m-llm', 'm-api')],
    );

    expect(result.verdict).toBe('forbidden');
    expect(result.findings[0]?.kind).toBe('cycle');
    expect(result.findings[0]?.cycle).toEqual(['m-llm', 'm-api']);
  });

  it('allows it when no return path exists', () => {
    const result = check('src/api/handler.ts', 'src/llm/anthropic.ts', noCycles, MODULES, [
      moduleEdge('m-parser', 'm-llm'),
    ]);
    expect(result.verdict).toBe('allowed');
  });
});

// ---------------------------------------------------------------- resolution

describe('resolving what the agent typed', () => {
  it('accepts a file path', () => {
    expect(check('src/parser/parse.ts', 'src/llm/anthropic.ts', []).from.status).toBe('file');
  });

  it('accepts a directory', () => {
    const result = check('src/parser', 'src/llm', []);
    expect(result.from.status).toBe('directory');
    expect(result.from.modules).toEqual(['m-parser']);
  });

  it('accepts a module id', () => {
    expect(check('m-parser', 'm-llm', []).from.status).toBe('module');
  });

  it('accepts a windows-style path, since an agent on windows will send one', () => {
    expect(check('src\\parser\\parse.ts', 'src/llm/anthropic.ts', []).from.status).toBe('file');
  });

  it('marks the endpoints DERIVED, never STATED', () => {
    const result = check('src/parser/parse.ts', 'src/llm/anthropic.ts', []);
    expect(result.from.provenance).toBe('DERIVED');
    expect(result.to.provenance).toBe('DERIVED');
  });

  it('labels the verdict a comparison rather than a fact about either side', () => {
    expect(check('src/parser/parse.ts', 'src/llm/anthropic.ts', []).provenance).toBe('COMPARISON');
  });
});

// ---------------------------------------------------------------- agreement

describe('the prospective check agrees with the detector', () => {
  /**
   * The real risk in this file is drift. `check_import` re-implements the four
   * detectors against a hypothetical edge, so it can quietly start disagreeing
   * with `detectViolations` — and then the tool would bless an import that the
   * conformance report flags the moment it is written, which is worse than
   * having no tool at all.
   *
   * These pin the two together: for each relation, an edge the detector calls
   * a violation must be an edge the checker calls forbidden.
   */
  const cases: readonly {
    name: string;
    constraints: Constraint[];
    from: string;
    to: string;
    modules?: ModuleNode[];
    moduleEdges?: ModuleEdge[];
  }[] = [
    {
      name: 'must-not-import',
      constraints: [constraint('must-not-import', subject('m-parser'), subject('m-llm'))],
      from: 'src/parser/parse.ts',
      to: 'src/llm/anthropic.ts',
    },
    {
      name: 'must-be-layer-above',
      constraints: [constraint('must-be-layer-above', subject('m-api'), subject('m-parser'))],
      from: 'src/parser/parse.ts',
      to: 'src/api/handler.ts',
    },
    {
      name: 'may-only-import-via',
      constraints: [
        constraint('may-only-import-via', subject('m-api'), subject('m-llm'), {
          via: subject('m-parser'),
        }),
      ],
      from: 'src/api/handler.ts',
      to: 'src/llm/anthropic.ts',
    },
  ];

  it.each(cases)('$name: forbidden before the edge, a violation after it', (testCase) => {
    const fileEdge = edge(testCase.from, testCase.to);
    const modules = testCase.modules ?? MODULES;

    const before = checkImport({
      from: testCase.from,
      to: testCase.to,
      constraints: testCase.constraints,
      clustering: clustering(modules, testCase.moduleEdges ?? []),
      fileEdges: [],
    });

    const after = detectViolations({
      constraints: testCase.constraints,
      clustering: clustering(modules, testCase.moduleEdges ?? []),
      fileEdges: [fileEdge],
    });

    expect(before.verdict).toBe('forbidden');
    expect(after.violations).toHaveLength(1);
    expect(before.findings[0]?.kind).toBe(after.violations[0]?.kind);
  });

  it('and agrees on the allowed case too', () => {
    const constraints = [constraint('must-not-import', subject('m-parser'), subject('m-llm'))];

    const before = check('src/api/handler.ts', 'src/parser/parse.ts', constraints);
    const after = detectViolations({
      constraints,
      clustering: clustering(MODULES),
      fileEdges: [edge('src/api/handler.ts', 'src/parser/parse.ts')],
    });

    expect(before.verdict).toBe('allowed');
    expect(after.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------- determinism

describe('determinism', () => {
  it('gives byte-identical answers to the same question', () => {
    const constraints = [
      constraint('must-not-import', subject('m-parser'), subject('m-llm')),
      constraint('must-be-layer-above', subject('m-api'), subject('m-parser')),
    ];
    const once = check('src/parser/parse.ts', 'src/llm/anthropic.ts', constraints);
    const twice = check('src/parser/parse.ts', 'src/llm/anthropic.ts', [...constraints].reverse());

    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('finds the same path regardless of insertion order', () => {
    const outbound = new Map([
      ['a', new Set(['b', 'c'])],
      ['b', new Set(['d'])],
      ['c', new Set(['d'])],
    ]);
    expect(shortestPath(['a'], ['d'], outbound)).toEqual(['a', 'b', 'd']);
  });

  it('returns null when there is no path rather than an empty one', () => {
    expect(shortestPath(['a'], ['z'], new Map([['a', new Set(['b'])]]))).toBeNull();
  });
});
