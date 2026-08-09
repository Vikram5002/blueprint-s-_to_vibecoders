/**
 * Violation precision and recall, against a hand-determined ground truth.
 *
 * Week 7 measured whether the right constraints came *out of the prose*. This
 * measures whether the right violations come out of the *graph*, which is a
 * different question and has a different failure mode: extraction can only miss
 * or invent a rule, while detection can point at an innocent file.
 *
 * ## How ground truth was established
 *
 * The three constraints Week 7 actually extracted are rules this project holds
 * about itself, so the answer is checkable by reading the source:
 *
 *   must-not-import(parser/ -> llm/)   no file under src/parser imports llm/
 *   must-not-import(graph/  -> llm/)   no file under src/graph  imports llm/
 *   must-not-import(ui/     -> src/)   no file under ui/src     imports src/
 *
 * Verified by grep over the real tree, including test files, before this was
 * written. **Expected violations: zero.** That is the correct answer and it is
 * a real result — the tool agreeing that a conformant repository is conformant
 * is the outcome most conformance tools get wrong by being too eager.
 *
 * ## Why that is not the whole test
 *
 * An all-negative ground truth measures precision and says nothing about
 * recall: a detector that returns `[]` unconditionally would score perfectly.
 * So the second half injects edges that are known violations by construction —
 * real files, real modules, edges that do not exist in the repository — and
 * checks that exactly those fire and nothing else moves.
 *
 * Injecting edges rather than editing files keeps the ground truth exact. There
 * is no question of what *should* have been detected, because the edge set is
 * the one written here.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseRepository, type Analysis } from '../pipeline/analyse.js';
import { detectViolations, type FileEdge } from './violations.js';
import { fileEdgesFrom, unresolvedByFile } from './graph-adapter.js';
import { resolveSubject, type ResolutionCandidate } from './resolve-subject.js';
import type { Constraint, ConstraintRelation, ResolvedSubject } from '../types/constraints.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let analysis: Analysis;
let modules: ResolutionCandidate[];
let directories: string[];
let realEdges: FileEdge[];

beforeAll(async () => {
  const analysed = await analyseRepository({ root: repoRoot });
  if (!analysed.ok) throw new Error(analysed.error.message);
  analysis = analysed.value;

  modules = analysis.clustering.modules.map((module) => ({
    moduleId: module.id,
    label: module.label,
    directories: module.directories,
    fileCount: module.files.length,
  }));
  directories = [...new Set(analysis.clustering.modules.flatMap((m) => m.directories))].sort();
  realEdges = fileEdgesFrom(analysis.graph);
}, 60_000);

function resolve(phrase: string): ResolvedSubject {
  return resolveSubject(phrase, { candidates: modules, directories });
}

/** The three constraints Week 7 extracted from this project's own CLAUDE.md. */
function extractedConstraints(): Constraint[] {
  const make = (subject: string, object: string, rawText: string): Constraint => ({
    id: `claude-${subject}-${object}`,
    relation: 'must-not-import' as ConstraintRelation,
    subject: resolve(subject),
    object: resolve(object),
    via: null,
    source: { type: 'agents-md', location: 'CLAUDE.md', line: 60, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText,
    provenance: 'STATED',
  });

  return [
    make('parser/', 'llm/', '`parser/` and `graph/` must NEVER import from `llm/`.'),
    make('graph/', 'llm/', '`parser/` and `graph/` must NEVER import from `llm/`.'),
    make('ui/', 'src/', '`ui/` must not import from `src/` directly.'),
  ];
}

function run(edges: readonly FileEdge[]): ReturnType<typeof detectViolations> {
  return detectViolations({
    constraints: extractedConstraints(),
    clustering: analysis.clustering,
    fileEdges: edges,
    unresolvedByFile: unresolvedByFile(analysis.graph),
  });
}

/** A file that really exists in the repository, under the given directory. */
function fileUnder(prefix: string): string {
  const found = [...analysis.clustering.modules.flatMap((m) => m.files)]
    .filter((file) => file.startsWith(prefix) && !file.endsWith('.test.ts'))
    .sort();
  if (found.length === 0) throw new Error(`no analysed file under ${prefix}`);
  return found[0] as string;
}

function injected(from: string, to: string): FileEdge {
  return {
    id: `INJECTED ${from}->${to}`,
    from,
    to,
    importCount: 2,
    evidence: [{ file: from, line: 1, snippet: `import { x } from '${to}';` }],
    provenance: 'DERIVED',
  };
}

describe('ground truth: this repository obeys its own rules', () => {
  it('resolves all three constraints, so they are actually checked', () => {
    const result = run(realEdges);
    expect(result.summary.checked).toBe(3);
    expect(result.summary.unchecked).toBe(0);
  });

  it('reports zero violations, which is the hand-verified answer', () => {
    const result = run(realEdges);
    expect(result.violations).toEqual([]);
    expect(result.summary.satisfied).toBe(3);
  });

  it('is looking at a real graph, not an empty one', () => {
    // Guards the guard: zero violations over zero edges would pass vacuously.
    expect(realEdges.length).toBeGreaterThan(200);
    expect(analysis.clustering.modules.length).toBeGreaterThan(5);
  });
});

describe('injected violations: known positives', () => {
  it('detects a parser -> llm edge and attributes it to the right rule', () => {
    const edge = injected(fileUnder('src/parser/'), fileUnder('src/llm/'));
    const result = run([...realEdges, edge]);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.constraintId).toBe('claude-parser/-llm/');
    expect(result.violations[0]?.kind).toBe('forbidden-import');
    expect(result.violations[0]?.edges.map((e) => e.edgeId)).toEqual([edge.id]);
  });

  it('detects a graph -> llm edge without also blaming the parser rule', () => {
    const edge = injected(fileUnder('src/graph/'), fileUnder('src/llm/'));
    const result = run([...realEdges, edge]);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.constraintId).toBe('claude-graph/-llm/');
  });

  it('detects both when both exist, as two separate findings', () => {
    const a = injected(fileUnder('src/parser/'), fileUnder('src/llm/'));
    const b = injected(fileUnder('src/graph/'), fileUnder('src/llm/'));
    const result = run([...realEdges, a, b]);

    expect(result.violations).toHaveLength(2);
    expect(result.summary.violated).toBe(2);
    expect(result.summary.satisfied).toBe(1);
  });

  it('carries real evidence on every injected finding (rule 3, one level up)', () => {
    const edge = injected(fileUnder('src/parser/'), fileUnder('src/llm/'));
    const violation = run([...realEdges, edge]).violations[0];

    expect(violation?.edges[0]?.evidence.length).toBeGreaterThan(0);
    expect(violation?.edges[0]?.evidence[0]?.file).toBe(edge.from);
    expect(violation?.edges[0]?.evidence[0]?.line).toBeGreaterThan(0);
  });

  it('does not fire on the reverse edge, which no rule forbids', () => {
    // llm/ importing parser/ is allowed — only the stated direction is a breach.
    const edge = injected(fileUnder('src/llm/'), fileUnder('src/parser/'));
    expect(run([...realEdges, edge]).violations).toEqual([]);
  });

  it('does not fire on an unrelated edge between two innocent modules', () => {
    const edge = injected(fileUnder('src/ingest/'), fileUnder('src/store/'));
    expect(run([...realEdges, edge]).violations).toEqual([]);
  });

  /**
   * Precision and recall over the injected set.
   *
   * Four known positives, two known negatives, checked together so a detector
   * that fires indiscriminately cannot score well on the positives alone.
   */
  it('scores 100% precision and 100% recall on the labelled edge set', () => {
    const positives = [
      injected(fileUnder('src/parser/'), fileUnder('src/llm/')),
      injected(fileUnder('src/graph/'), fileUnder('src/llm/')),
    ];
    const negatives = [
      injected(fileUnder('src/llm/'), fileUnder('src/parser/')),
      injected(fileUnder('src/ingest/'), fileUnder('src/store/')),
      injected(fileUnder('src/cli/'), fileUnder('src/server/')),
    ];

    const result = run([...realEdges, ...positives, ...negatives]);
    const fired = new Set(result.violations.flatMap((v) => v.edges.map((e) => e.edgeId)));

    const truePositives = positives.filter((edge) => fired.has(edge.id)).length;
    const falseNegatives = positives.length - truePositives;
    const falsePositives = [...fired].filter(
      (id) => !positives.some((edge) => edge.id === id),
    ).length;

    expect(truePositives).toBe(positives.length);
    expect(falseNegatives).toBe(0);
    expect(falsePositives).toBe(0);
  });
});

describe('severity on a real graph', () => {
  it('rates a certain rule broken in a cleanly resolved area as high', () => {
    const edge = injected(fileUnder('src/parser/'), fileUnder('src/llm/'));
    const violation = run([...realEdges, edge]).violations[0];
    expect(violation?.severity).toBe('high');
    expect(violation?.severityScore).toBeGreaterThan(0.7);
  });

  it('drops the same violation to low when the rule is barely trusted', () => {
    const edge = injected(fileUnder('src/parser/'), fileUnder('src/llm/'));
    const shaky = extractedConstraints().map((constraint) =>
      constraint.subject.phrase === 'parser/'
        ? { ...constraint, confidence: 0.25, lowConfidence: true }
        : constraint,
    );

    const result = detectViolations({
      constraints: shaky,
      clustering: analysis.clustering,
      fileEdges: [...realEdges, edge],
      unresolvedByFile: unresolvedByFile(analysis.graph),
    });

    expect(result.violations[0]?.severity).toBe('low');
  });
});

describe('determinism on a real graph', () => {
  it('produces byte-identical results across runs', () => {
    const edge = injected(fileUnder('src/parser/'), fileUnder('src/llm/'));
    const once = run([...realEdges, edge]);
    const twice = run([...realEdges, edge]);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});
