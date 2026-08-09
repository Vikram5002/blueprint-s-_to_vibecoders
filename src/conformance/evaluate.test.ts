import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalisePhrase, score, type ScorableConstraint } from './evaluate.js';
import { GOLD, GOLD_CONSTRAINTS } from './fixtures/intent/gold.js';
import { resolveSubject, summariseSubjects, type ResolutionCandidate } from './resolve-subject.js';

const here = dirname(fileURLToPath(import.meta.url));

const constraint = (
  relation: ScorableConstraint['relation'],
  subject: string,
  object: string,
  file = 'a.md',
): ScorableConstraint => ({ relation, subject, object, file });

describe('phrase normalisation', () => {
  it('treats a path, a bare name and a padded name as the same subject', () => {
    expect(normalisePhrase('parser/')).toBe(normalisePhrase('the parser'));
    expect(normalisePhrase('the parser layer')).toBe(normalisePhrase('parser'));
  });

  it('ignores markdown the document happened to use', () => {
    expect(normalisePhrase('`ui/`')).toBe(normalisePhrase('ui'));
  });

  it('does not collapse genuinely different subjects', () => {
    expect(normalisePhrase('the parser')).not.toBe(normalisePhrase('the graph'));
  });
});

describe('scoring', () => {
  const gold = [constraint('must-not-import', 'parser/', 'llm/'), constraint('must-not-import', 'ui/', 'src/')];

  it('scores a perfect prediction 100/100', () => {
    const result = score(gold, gold, 0);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it('matches across phrasing differences', () => {
    const predicted = [
      constraint('must-not-import', 'the parser layer', 'the llm module'),
      constraint('must-not-import', 'ui', 'src'),
    ];
    expect(score(predicted, gold, 0).truePositives).toBe(2);
  });

  it('counts a wrong relation as both a miss and a false positive', () => {
    const predicted = [constraint('must-be-layer-above', 'parser/', 'llm/')];
    const result = score(predicted, gold, 0);
    expect(result.falsePositives).toBe(1);
    expect(result.falseNegatives).toBe(2);
  });

  it('does not credit a constraint found in the wrong document', () => {
    const predicted = [constraint('must-not-import', 'parser/', 'llm/', 'elsewhere.md')];
    expect(score(predicted, gold, 0).truePositives).toBe(0);
  });

  it('reports clean documents but keeps them out of precision', () => {
    const result = score([], [], 30);
    expect(result.trueNegativeDocuments).toBe(30);
    // A do-nothing extractor must not be able to score well on positives.
    expect(result.truePositives).toBe(0);
  });

  it('does not count a document as clean when it produced a false positive', () => {
    const predicted = [constraint('must-not-import', 'a', 'b', 'noisy.md')];
    expect(score(predicted, [], 30).trueNegativeDocuments).toBe(29);
  });
});

describe('the evaluation set itself', () => {
  it('labels every document present in the fixtures directory', async () => {
    const files = (await readdir(join(here, 'fixtures', 'intent')))
      .filter((name) => /\.(md|rst)$/i.test(name))
      .sort();
    expect(GOLD.map((document) => document.file).sort()).toEqual(files);
  });

  it('is about the size the brief asked for', () => {
    expect(GOLD.length).toBeGreaterThanOrEqual(30);
  });

  it('records the finding that almost no real document states a checkable rule', () => {
    const withConstraints = GOLD.filter((document) => document.constraints.length > 0);
    // If this ever changes, the headline finding in docs/INTENT.md is stale.
    expect(withConstraints).toHaveLength(1);
    expect(withConstraints[0]?.file).toBe('blueprint-claude.md');
  });

  it('covers all four relations somewhere, or says why not', () => {
    const relations = new Set(GOLD_CONSTRAINTS.map((entry) => entry.relation));
    // Only two of the four appear in real documentation in this corpus. That is
    // itself the finding, so it is asserted rather than quietly tolerated.
    expect([...relations].sort()).toEqual(['may-only-import-via', 'must-not-import']);
  });
});

/**
 * The deterministic half, measured on its own.
 *
 * End-to-end precision and recall need a model. This does not: it feeds the
 * hand-labelled constraints in as though extraction had been perfect, and asks
 * what the resolver does with them. It sets a ceiling — no extraction quality
 * can rescue a pipeline whose resolver drops the subjects afterwards — and that
 * ceiling is measurable today.
 */
describe('oracle: resolution ceiling on gold constraints', () => {
  const modules: ResolutionCandidate[] = [
    { moduleId: 'm-parser', label: 'Source Parsing', directories: ['src/parser'], fileCount: 14 },
    { moduleId: 'm-graph', label: 'Dependency Graph', directories: ['src/graph'], fileCount: 12 },
    { moduleId: 'm-llm', label: 'Model Adapter', directories: ['src/llm'], fileCount: 9 },
    { moduleId: 'm-server', label: 'Local Server', directories: ['src/server'], fileCount: 6 },
    { moduleId: 'm-ui', label: 'Browser Interface', directories: ['ui/src'], fileCount: 18 },
    { moduleId: 'm-cli', label: 'Command Line', directories: ['src/cli'], fileCount: 5 },
  ];

  const directories = ['src/parser', 'src/graph', 'src/llm', 'src/server', 'src/cli', 'ui/src'];

  it('resolves every role in the gold set against this repository', () => {
    const roles = GOLD_CONSTRAINTS.flatMap((entry) => [
      entry.subject,
      entry.object,
      ...(entry.via === undefined ? [] : [entry.via]),
    ]);
    const resolved = roles.map((phrase) => resolveSubject(phrase, { candidates: modules, directories }));
    const summary = summariseSubjects(resolved);

    // Reported by the acceptance script; asserted here so a regression in the
    // resolver shows up as a failing test rather than a worse number nobody read.
    expect(summary.resolutionRate).toBe(100);
    expect(summary.unresolved).toBe(0);
  });

  it('sends "src/" to a path pattern rather than pretending it is one module', () => {
    // ui/ must not import src/ — src/ is the whole deterministic half, not a
    // module, and resolving it to whichever module scores highest would aim the
    // constraint at something far narrower than the sentence meant.
    const resolved = resolveSubject('src/', {
      candidates: modules,
      directories: ['src/parser', 'src/graph', 'src/llm'],
    });
    expect(resolved.status).toBe('PATH_PATTERN');
    expect(resolved.target).toBe('src/**');
  });
});
