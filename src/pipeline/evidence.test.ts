import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { analyseRepository, type Analysis } from './analyse.js';
import { buildClusterEvidence } from './evidence.js';
import { buildUserPrompt } from '../llm/prompt.js';

const FIXTURE = fileURLToPath(new URL('../graph/fixtures/ts-monorepo', import.meta.url));

let analysis: Analysis;

beforeAll(async () => {
  const result = await analyseRepository({ root: FIXTURE, cluster: { minClusterSize: 1 } });
  if (!result.ok) throw new Error(result.error.message);
  analysis = result.value;
}, 60_000);

describe('cluster evidence', () => {
  it('extracts exported symbols for a module', () => {
    const evidence = buildClusterEvidence(analysis.parse.files, analysis.clustering);
    const withSymbols = analysis.clustering.modules
      .map((module) => evidence.symbols(module.id))
      .filter((symbols) => symbols.length > 0);

    expect(withSymbols.length).toBeGreaterThan(0);
  });

  it('never sends file contents — snippets come from export statements', () => {
    const evidence = buildClusterEvidence(analysis.parse.files, analysis.clustering);

    for (const module of analysis.clustering.modules) {
      for (const snippet of evidence.snippets(module.id)) {
        expect(snippet.text).not.toContain('\n');
        expect(snippet.text.length).toBeLessThan(250);
        expect(module.files).toContain(snippet.file);
      }
    }
  });

  it('caps snippets at three per module', () => {
    const evidence = buildClusterEvidence(analysis.parse.files, analysis.clustering);
    for (const module of analysis.clustering.modules) {
      expect(evidence.snippets(module.id).length).toBeLessThanOrEqual(3);
    }
  });

  it('omits names that say nothing about the module', () => {
    const evidence = buildClusterEvidence(analysis.parse.files, analysis.clustering);
    for (const module of analysis.clustering.modules) {
      expect(evidence.symbols(module.id)).not.toContain('default');
      expect(evidence.symbols(module.id)).not.toContain('*');
    }
  });

  it('is deterministic, so the prompt hashes the same every run', () => {
    const first = buildClusterEvidence(analysis.parse.files, analysis.clustering);
    const second = buildClusterEvidence(analysis.parse.files, analysis.clustering);

    for (const module of analysis.clustering.modules) {
      expect(second.symbols(module.id)).toEqual(first.symbols(module.id));
      expect(second.snippets(module.id)).toEqual(first.snippets(module.id));
    }
  });

  it('produces a prompt within the documented budget for every module', () => {
    const evidence = buildClusterEvidence(analysis.parse.files, analysis.clustering);

    for (const module of analysis.clustering.modules) {
      const prompt = buildUserPrompt({
        request: {
          moduleId: module.id,
          mechanicalLabel: module.label,
          files: module.files,
          directories: module.directories,
        },
        symbols: evidence.symbols(module.id),
        snippets: evidence.snippets(module.id),
      });
      // ~1,050 tokens of budget; 4 chars/token is a conservative upper bound.
      expect(prompt.length).toBeLessThan(4200);
    }
  });

  it('returns nothing for a module it has never seen', () => {
    const evidence = buildClusterEvidence(analysis.parse.files, analysis.clustering);
    expect(evidence.symbols('module-999')).toEqual([]);
    expect(evidence.snippets('module-999')).toEqual([]);
  });
});
