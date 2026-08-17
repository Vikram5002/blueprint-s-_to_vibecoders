import { describe, expect, it } from 'vitest';
import {
  buildBlueprintResponse,
  buildSeedsResponse,
  acceptSeeds,
  compileRequest,
  saveRequest,
} from './blueprint-api.js';
import { openDatabase } from '../store/database.js';
import { createBlueprintStore } from '../store/blueprint-store.js';
import type { AnalysisContext } from './context.js';
import type { ClusteringResult, ModuleEdge, ModuleNode } from '../types/modules.js';
import type { LabelSet } from '../types/labels.js';

function module(id: string, files: string[]): ModuleNode {
  return {
    id,
    kind: 'module',
    label: id,
    files,
    directories: [...new Set(files.map((f) => f.split('/').slice(0, -1).join('/')))],
    provenance: 'DERIVED',
    llmLabelled: false,
    userCorrected: false,
  } as unknown as ModuleNode;
}

function moduleEdge(from: string, to: string): ModuleEdge {
  return { id: `${from}=>${to}`, from, to, weight: 1, importCount: 1, fileEdges: [], provenance: 'DERIVED' };
}

const API = module('m-api', ['src/api/a.ts']);
const DB = module('m-db', ['src/db/b.ts']);

function emptyLabels(): LabelSet {
  return {
    labels: new Map(),
    summary: {
      candidates: 0,
      mechanical: 0,
      llmLabelled: 0,
      userCorrected: 0,
      cacheHits: 0,
      cacheMisses: 0,
      usage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
      provider: null,
      degraded: true,
      failures: [],
    },
  };
}

function context(modules: ModuleNode[], edges: ModuleEdge[] = []): AnalysisContext {
  const clustering = { modules, edges } as unknown as ClusteringResult;
  return {
    clustering,
    labels: emptyLabels(),
    blueprintStore: createBlueprintStore(openDatabase(':memory:')),
  } as unknown as AnalysisContext;
}

describe('buildBlueprintResponse', () => {
  it('is empty before anything is saved', () => {
    expect(buildBlueprintResponse(context([API, DB])).constraints).toEqual([]);
  });

  it('reflects what is in the store', () => {
    const ctx = context([API, DB]);
    saveRequest(ctx, { dsl: 'api must not import db' });
    expect(buildBlueprintResponse(ctx).constraints).toHaveLength(1);
  });
});

describe('buildSeedsResponse', () => {
  it('proposes candidates from one-directional module coupling', () => {
    const ctx = context([API, DB], [moduleEdge('m-api', 'm-db')]);
    const response = buildSeedsResponse(ctx);
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.source.type).toBe('seeded-from-derived');
  });

  it('never persists — the store stays empty after listing seeds', () => {
    const ctx = context([API, DB], [moduleEdge('m-api', 'm-db')]);
    buildSeedsResponse(ctx);
    expect(buildBlueprintResponse(ctx).constraints).toEqual([]);
  });
});

describe('acceptSeeds', () => {
  it('rejects a request with no ids', () => {
    const ctx = context([API, DB], [moduleEdge('m-api', 'm-db')]);
    const result = acceptSeeds(ctx, { ids: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed body', () => {
    const ctx = context([API, DB]);
    expect(acceptSeeds(ctx, { ids: 'not-an-array' }).ok).toBe(false);
    expect(acceptSeeds(ctx, null).ok).toBe(false);
  });

  it('an unaccepted seed never reaches the store', () => {
    const ctx = context([API, DB], [moduleEdge('m-api', 'm-db')]);
    // Listing seeds, and even attempting to accept an id that names nothing,
    // must never populate the store.
    buildSeedsResponse(ctx);
    acceptSeeds(ctx, { ids: ['not-a-real-id'] });
    expect(buildBlueprintResponse(ctx).constraints).toEqual([]);
  });

  it('accepting a named id persists exactly that constraint', () => {
    const ctx = context([API, DB], [moduleEdge('m-api', 'm-db')]);
    const seedId = buildSeedsResponse(ctx).candidates[0]?.id;
    if (seedId === undefined) throw new Error('no seed produced');

    const result = acceptSeeds(ctx, { ids: [seedId] });
    expect(result.ok).toBe(true);

    const stored = buildBlueprintResponse(ctx).constraints;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(seedId);
    expect(stored[0]?.source.type).toBe('seeded-from-derived');
  });

  it('accepted seeds are never mislabelled user-authored', () => {
    const ctx = context([API, DB], [moduleEdge('m-api', 'm-db')]);
    const seedId = buildSeedsResponse(ctx).candidates[0]?.id;
    if (seedId === undefined) throw new Error('no seed produced');
    acceptSeeds(ctx, { ids: [seedId] });
    expect(buildBlueprintResponse(ctx).constraints[0]?.source.type).not.toBe('user-authored');
  });
});

describe('compileRequest', () => {
  it('compiles typed dsl text', () => {
    const ctx = context([API, DB]);
    const result = compileRequest(ctx, { dsl: 'api must not import db' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.compiled.constraints).toHaveLength(1);
  });

  it('compiles a visual graph to the same result as the equivalent dsl text', () => {
    const ctx = context([API, DB]);
    const graphResult = compileRequest(ctx, {
      graph: {
        nodes: [
          { id: 'n1', phrase: 'api' },
          { id: 'n2', phrase: 'db' },
        ],
        edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'must-not-import' }],
      },
    });
    const dslResult = compileRequest(ctx, { dsl: 'api must not import db' });
    expect(JSON.stringify(graphResult)).toBe(JSON.stringify(dslResult));
  });

  it('never persists', () => {
    const ctx = context([API, DB]);
    compileRequest(ctx, { dsl: 'api must not import db' });
    expect(buildBlueprintResponse(ctx).constraints).toEqual([]);
  });

  it('rejects a malformed body', () => {
    const ctx = context([API, DB]);
    expect(compileRequest(ctx, {}).ok).toBe(false);
    expect(compileRequest(ctx, null).ok).toBe(false);
  });
});

describe('saveRequest', () => {
  it('compiles and persists, replacing whatever was stored before', () => {
    const ctx = context([API, DB]);
    saveRequest(ctx, { dsl: 'api must not import db' });
    saveRequest(ctx, { dsl: 'db must not import api' });

    const stored = buildBlueprintResponse(ctx).constraints;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.rawText).toBe('db must not import api');
  });

  it('accepts a graph payload identically to a dsl payload', () => {
    const ctx = context([API, DB]);
    const result = saveRequest(ctx, {
      graph: {
        nodes: [
          { id: 'n1', phrase: 'api' },
          { id: 'n2', phrase: 'db' },
        ],
        edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'must-not-import' }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.dsl).toBe('api must not import db');
    expect(buildBlueprintResponse(ctx).constraints).toHaveLength(1);
  });
});
