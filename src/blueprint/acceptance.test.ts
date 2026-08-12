/**
 * Part D's acceptance criterion, verified directly: a hand-authored
 * constraint must flow through the SAME conformance engine as an extracted
 * one — same model, same evaluator, same violation output — with no parallel
 * code path between them.
 */
import { describe, expect, it } from 'vitest';
import { compileBlueprint } from './dsl.js';
import { compileCandidates } from '../conformance/compile.js';
import { detectViolations, type FileEdge } from '../conformance/violations.js';
import type { ResolutionCandidate } from '../conformance/resolve-subject.js';
import type { ClusteringResult, Module } from '../types/modules.js';
import type { ConstraintSource } from '../types/constraints.js';

const MODULES: ResolutionCandidate[] = [
  { moduleId: 'm-api', label: 'api', directories: ['src/api'], fileCount: 1 },
  { moduleId: 'm-db', label: 'db', directories: ['src/db'], fileCount: 1 },
];

function module(id: string, files: string[]): Module {
  return {
    id,
    label: id,
    files,
    directories: [...new Set(files.map((f) => f.split('/').slice(0, -1).join('/')))],
    reason: 'import-coupling',
  } as unknown as Module;
}

const CLUSTERING = {
  modules: [module('m-api', ['src/api/a.ts']), module('m-db', ['src/db/b.ts'])],
  edges: [],
} as unknown as ClusteringResult;

const FILE_EDGES: FileEdge[] = [
  {
    id: 'src/api/a.ts->src/db/b.ts',
    from: 'src/api/a.ts',
    to: 'src/db/b.ts',
    importCount: 1,
    evidence: [{ file: 'src/api/a.ts', line: 1, snippet: "import x from '../db/b';" }],
    provenance: 'DERIVED',
  },
];

describe('authored and extracted constraints share one path', () => {
  it('produces the same violation for the same rule, authored or extracted', () => {
    // Authored: compiled directly from DSL text.
    const authored = compileBlueprint({
      text: 'api must not import db',
      location: 'blueprint.txt',
      modules: MODULES,
    });
    expect(authored.constraints).toHaveLength(1);

    // Extracted: compiled from an LLM-shaped candidate over the same document.
    const documentText = 'The api layer must not import the db layer.';
    const source: ConstraintSource = { type: 'readme', location: 'README.md', line: 1, timestamp: null };
    const extracted = compileCandidates({
      candidates: [
        {
          rawText: documentText,
          relation: 'must-not-import',
          subject: 'the api layer',
          object: 'the db layer',
        },
      ],
      source,
      documentText,
      modules: MODULES,
    });
    expect(extracted.constraints).toHaveLength(1);

    // Same evaluator, called once per constraint set — not a special path for
    // either. Both resolve to the same modules, so both produce a violation
    // for the exact same edge.
    const authoredResult = detectViolations({
      constraints: authored.constraints,
      clustering: CLUSTERING,
      fileEdges: FILE_EDGES,
    });
    const extractedResult = detectViolations({
      constraints: extracted.constraints,
      clustering: CLUSTERING,
      fileEdges: FILE_EDGES,
    });

    expect(authoredResult.violations).toHaveLength(1);
    expect(extractedResult.violations).toHaveLength(1);

    const [a] = authoredResult.violations;
    const [e] = extractedResult.violations;
    if (a === undefined || e === undefined) throw new Error('missing violation');

    // Identical shape and outcome, produced by the identical evaluator call.
    // Severity legitimately differs — it is partly a function of confidence,
    // and confidence legitimately differs by source weight (user-authored
    // scores higher than readme, by design in confidence.ts) — but both are
    // real severities from the same scoring function, not a different one.
    expect(['high', 'medium', 'low']).toContain(a.severity);
    expect(['high', 'medium', 'low']).toContain(e.severity);
    expect(a.evidence).toEqual(e.evidence);
    expect(a.constraint.relation).toBe(e.constraint.relation);
    expect(a.constraint.source.type).toBe('user-authored');
    expect(e.constraint.source.type).toBe('readme');
  });

  it('runs both source types through one call when concatenated, matching a real merge', () => {
    const authored = compileBlueprint({ text: 'api must not import db', location: 'blueprint.txt', modules: MODULES });
    const documentText = 'The api layer must not import the db layer.';
    const extracted = compileCandidates({
      candidates: [
        { rawText: documentText, relation: 'must-not-import', subject: 'the api layer', object: 'the db layer' },
      ],
      source: { type: 'readme', location: 'README.md', line: 1, timestamp: null },
      documentText,
      modules: MODULES,
    });

    // The two "same rule" constraints are independent claims (see dsl.ts's
    // header comment) — concatenating them should report the violation once
    // per constraint, i.e. twice, not deduplicated and not dropped.
    const merged = [...authored.constraints, ...extracted.constraints];
    const result = detectViolations({ constraints: merged, clustering: CLUSTERING, fileEdges: FILE_EDGES });
    expect(result.violations).toHaveLength(2);
  });
});
