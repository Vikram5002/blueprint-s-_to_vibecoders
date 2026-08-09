import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyseRepository, type Analysis } from './analyse.js';
import { labelRepository, MODEL_ENV } from './label-repository.js';

const FIXTURE = fileURLToPath(new URL('../graph/fixtures/ts-monorepo', import.meta.url));

let analysis: Analysis;

beforeAll(async () => {
  const result = await analyseRepository({ root: FIXTURE, cluster: { minClusterSize: 1 } });
  if (!result.ok) throw new Error(result.error.message);
  analysis = result.value;
}, 60_000);

describe('running without an API key', () => {
  it('labels everything mechanically and reports it as degraded', async () => {
    const labels = await labelRepository({
      root: FIXTURE,
      clustering: analysis.clustering,
      files: analysis.parse.files,
      env: {}, // no ANTHROPIC_API_KEY
    });

    expect(labels.summary.degraded).toBe(true);
    expect(labels.summary.provider).toBeNull();
    expect(labels.summary.usage.estimatedCostUsd).toBe(0);
    expect(labels.labels.size).toBe(analysis.clustering.modules.length);
    for (const module of analysis.clustering.modules) {
      expect(labels.labels.get(module.id)?.source).toBe('mechanical');
    }
  }, 30_000);

  it('treats an empty or whitespace key as no key', async () => {
    for (const value of ['', '   ']) {
      const labels = await labelRepository({
        root: FIXTURE,
        clustering: analysis.clustering,
        files: analysis.parse.files,
        env: { ANTHROPIC_API_KEY: value },
      });
      expect(labels.summary.degraded).toBe(true);
    }
  }, 30_000);

  it('can be forced off even when a key is present', async () => {
    const labels = await labelRepository({
      root: FIXTURE,
      clustering: analysis.clustering,
      files: analysis.parse.files,
      env: { ANTHROPIC_API_KEY: 'sk-ant-not-used' },
      useModel: false,
    });

    expect(labels.summary.degraded).toBe(true);
    expect(labels.summary.provider).toBeNull();
  }, 30_000);

  it('writes no cache file when there is no key', async () => {
    // Nothing was asked, so nothing should be stored.
    const root = await mkdtemp(join(tmpdir(), 'vibe-nokey-'));
    try {
      await labelRepository({
        root,
        clustering: analysis.clustering,
        files: analysis.parse.files,
        env: {},
      });
      const { access } = await import('node:fs/promises');
      await expect(access(join(root, '.vibe', 'label-cache.json'))).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('user corrections', () => {
  it('outrank mechanical names without a model', async () => {
    const target = analysis.clustering.modules[0]?.id ?? '';
    const labels = await labelRepository({
      root: FIXTURE,
      clustering: analysis.clustering,
      files: analysis.parse.files,
      env: {},
      corrections: new Map([[target, 'Named By Hand']]),
    });

    expect(labels.labels.get(target)?.label).toBe('Named By Hand');
    expect(labels.labels.get(target)?.source).toBe('user');
    expect(labels.summary.userCorrected).toBe(1);
  }, 30_000);
});

describe('model selection', () => {
  it('reads the model override from the environment', () => {
    // The default is the cheap model; the override exists so the comparison
    // harness and any upgrade need no code change.
    expect(MODEL_ENV).toBe('VIBE_LLM_MODEL');
  });
});
