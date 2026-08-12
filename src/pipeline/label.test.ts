import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { analyseRepository, type Analysis } from './analyse.js';
import { labelModules, type LabelRequest, type ModuleLabeller } from './label.js';

const FIXTURE = fileURLToPath(new URL('../graph/fixtures/ts-monorepo', import.meta.url));

/** Stands in for a model. Deliberately returns names nothing could derive. */
function fakeLabeller(overrides: Partial<Record<string, string>> = {}): ModuleLabeller {
  return {
    label: async (requests: readonly LabelRequest[]) => ({
      outcomes: requests.map((request) => ({
        moduleId: request.moduleId,
        label: overrides[request.moduleId] ?? `Semantic Name For ${request.moduleId}`,
        description: 'A one-line description from a model.',
      })),
      summary: {
        cacheHits: 0,
        cacheMisses: requests.length,
        usage: { promptTokens: 100 * requests.length, completionTokens: 20 * requests.length, estimatedCostUsd: 0.001 },
        provider: 'fake',
        failures: [],
      },
    }),
  };
}

let analysis: Analysis;

beforeAll(async () => {
  const result = await analyseRepository({ root: FIXTURE, cluster: { minClusterSize: 1 } });
  if (!result.ok) throw new Error(result.error.message);
  analysis = result.value;
}, 60_000);

describe('labels are cosmetic', () => {
  it('leaves the clustering byte-identical with labelling on and off', async () => {
    // The headline guarantee of the week. Week 5 made clustering deterministic;
    // model output is not, and must not leak backwards into structure.
    const before = JSON.stringify(analysis.clustering);

    await labelModules(analysis.clustering);
    expect(JSON.stringify(analysis.clustering)).toBe(before);

    await labelModules(analysis.clustering, { labeller: fakeLabeller() });
    expect(JSON.stringify(analysis.clustering)).toBe(before);
  });

  it('produces identical ids, membership and edges either way', async () => {
    const off = await labelModules(analysis.clustering);
    const on = await labelModules(analysis.clustering, { labeller: fakeLabeller() });

    // Same keys, in the same order.
    expect([...on.labels.keys()]).toEqual([...off.labels.keys()]);

    // Structure is addressed by id, and ids come from content, not from names.
    for (const module of analysis.clustering.modules) {
      expect(on.labels.has(module.id)).toBe(true);
      expect(off.labels.get(module.id)?.mechanicalLabel).toBe(
        on.labels.get(module.id)?.mechanicalLabel,
      );
    }

    const edgeKey = (): string =>
      analysis.clustering.edges.map((edge) => `${edge.from}->${edge.to}:${edge.weight}`).join('|');
    const edges = edgeKey();
    await labelModules(analysis.clustering, { labeller: fakeLabeller() });
    expect(edgeKey()).toBe(edges);
  });

  it('keeps cluster ids content-derived even when every label changes', async () => {
    const first = await labelModules(analysis.clustering, { labeller: fakeLabeller() });
    const second = await labelModules(analysis.clustering, {
      labeller: fakeLabeller(
        Object.fromEntries(analysis.clustering.modules.map((m) => [m.id, `Totally Different ${m.id}`])),
      ),
    });

    expect([...second.labels.keys()]).toEqual([...first.labels.keys()]);
    for (const [id, label] of second.labels) {
      expect(label.label).not.toBe(first.labels.get(id)?.label);
      // ...but the identity behind it did not move.
      expect(label.mechanicalLabel).toBe(first.labels.get(id)?.mechanicalLabel);
    }
  });

  it('always keeps the mechanical name alongside the model one', async () => {
    const set = await labelModules(analysis.clustering, { labeller: fakeLabeller() });

    for (const module of analysis.clustering.modules) {
      const label = set.labels.get(module.id);
      expect(label?.mechanicalLabel).toBe(module.label);
      expect(label?.label).not.toBe(module.label);
    }
  });
});

describe('running without an API key', () => {
  it('labels every module mechanically and reports it as degraded, not failed', async () => {
    const set = await labelModules(analysis.clustering);

    expect(set.labels.size).toBe(analysis.clustering.modules.length);
    for (const module of analysis.clustering.modules) {
      const label = set.labels.get(module.id);
      expect(label?.source).toBe('mechanical');
      expect(label?.label).toBe(module.label);
      expect(label?.description).toBeNull();
    }

    expect(set.summary.degraded).toBe(true);
    expect(set.summary.provider).toBeNull();
    expect(set.summary.llmLabelled).toBe(0);
    expect(set.summary.failures).toEqual([]);
    expect(set.summary.usage.estimatedCostUsd).toBe(0);
  });

  it('costs nothing and calls nothing', async () => {
    let called = false;
    const spy: ModuleLabeller = {
      label: async () => {
        called = true;
        return {
          outcomes: [],
          summary: { cacheHits: 0, cacheMisses: 0, usage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 }, provider: 'x', failures: [] },
        };
      },
    };

    await labelModules(analysis.clustering);
    expect(called).toBe(false);

    await labelModules(analysis.clustering, { labeller: spy });
    expect(called).toBe(true);
  });
});

describe('provenance', () => {
  it('marks model-supplied names as llm', async () => {
    const set = await labelModules(analysis.clustering, { labeller: fakeLabeller() });
    for (const label of set.labels.values()) {
      expect(label.source).toBe('llm');
      expect(label.description).not.toBeNull();
    }
    expect(set.summary.llmLabelled).toBe(analysis.clustering.modules.length);
    expect(set.summary.degraded).toBe(false);
  });

  it('lets a user correction outrank both the mechanical and the model name', async () => {
    const target = analysis.clustering.modules[0]?.id ?? '';
    const set = await labelModules(analysis.clustering, {
      labeller: fakeLabeller(),
      corrections: new Map([[target, 'What The User Called It']]),
    });

    const label = set.labels.get(target);
    expect(label?.label).toBe('What The User Called It');
    expect(label?.source).toBe('user');
    expect(set.summary.userCorrected).toBe(1);
  });

  it('does not pay to name a module the user has already named', async () => {
    const target = analysis.clustering.modules[0]?.id ?? '';
    const asked: string[] = [];

    const spy: ModuleLabeller = {
      label: async (requests) => {
        asked.push(...requests.map((request) => request.moduleId));
        return {
          outcomes: [],
          summary: { cacheHits: 0, cacheMisses: 0, usage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 }, provider: 'fake', failures: [] },
        };
      },
    };

    await labelModules(analysis.clustering, {
      labeller: spy,
      corrections: new Map([[target, 'Already Named']]),
    });

    expect(asked).not.toContain(target);
    expect(asked.length).toBe(analysis.clustering.modules.length - 1);
  });

  it('counts the three sources so the UI can distinguish them', async () => {
    const target = analysis.clustering.modules[0]?.id ?? '';
    const set = await labelModules(analysis.clustering, {
      labeller: fakeLabeller(),
      corrections: new Map([[target, 'Mine']]),
    });

    const total = set.summary.mechanical + set.summary.llmLabelled + set.summary.userCorrected;
    expect(total).toBe(analysis.clustering.modules.length);
    expect(set.summary.userCorrected).toBe(1);
  });
});

describe('untrusted model output', () => {
  it('ignores an outcome for a module that was never requested', async () => {
    const rogue: ModuleLabeller = {
      label: async (requests) => ({
        outcomes: [
          ...requests.map((request) => ({ moduleId: request.moduleId, label: 'Fine', description: null })),
          { moduleId: 'module-does-not-exist', label: 'Injected', description: null },
        ],
        summary: { cacheHits: 0, cacheMisses: 0, usage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 }, provider: 'fake', failures: [] },
      }),
    };

    const set = await labelModules(analysis.clustering, { labeller: rogue });

    expect(set.labels.has('module-does-not-exist')).toBe(false);
    expect(set.labels.size).toBe(analysis.clustering.modules.length);
  });
});

describe('mechanical labels for corpus runs', () => {
  /**
   * Corpus collection runs with `mechanicalLabels: true`. Across the first ten
   * corpus repositories, labelling was 4,896 of 4,925 model calls (99.4%)
   * against 29 for documents, and the study measures constraints, not names.
   *
   * The property under test is narrow and important: the option must suppress
   * *labelling* only. Intent extraction is a separate model user, and a change
   * that quietly disabled both would produce a corpus of zero constraints that
   * looked like a finding about repositories.
   */
  it('produces mechanical labels for every module', async () => {
    // Omitting the labeller is the mechanical path — the same one the no-key
    // case has always used, reused rather than reinvented for the corpus.
    const labels = await labelModules(analysis.clustering);

    expect(labels.summary.llmLabelled).toBe(0);
    expect(labels.summary.degraded).toBe(true);
    for (const label of labels.labels.values()) {
      expect(label.source).toBe('mechanical');
      // The mechanical name is always kept, so nothing is nameless.
      expect(label.label).toBe(label.mechanicalLabel);
    }
  });

  it('never calls the labeller when the model is off', async () => {
    let called = 0;
    const counting: ModuleLabeller = {
      label: async (requests) => {
        called += 1;
        return fakeLabeller().label(requests);
      },
    };

    await labelModules(analysis.clustering);
    expect(called).toBe(0);
    // Sanity: the counting labeller does count when it is actually supplied.
    await labelModules(analysis.clustering, { labeller: counting });
    expect(called).toBe(1);
  });

  it('still yields usable subject-resolution candidates', async () => {
    /**
     * The reason this is safe to do, stated as a test.
     *
     * `resolve-subject.ts` matches a prose phrase against a module's label
     * *and* its directories. With mechanical labels the label is the shared
     * path prefix, so directory-shaped phrases — which is how every constraint
     * observed so far resolves — still match. What is lost is matching a
     * phrase against a semantic name a model invented.
     */
    const labels = await labelModules(analysis.clustering);

    for (const module of analysis.clustering.modules) {
      const label = labels.labels.get(module.id);
      expect(label).toBeDefined();
      expect(label?.label.length ?? 0).toBeGreaterThan(0);
    }
  });
});
