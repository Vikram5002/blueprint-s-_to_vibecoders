import { describe, expect, it } from 'vitest';
import { seedConstraintsFromDerived } from './seed.js';
import type { ClusteringResult, ModuleEdge, ModuleNode } from '../types/modules.js';

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

function clustering(modules: ModuleNode[], edges: ModuleEdge[] = []): ClusteringResult {
  return { modules, edges } as unknown as ClusteringResult;
}

const API = module('m-api', ['src/api/a.ts']);
const DB = module('m-db', ['src/db/b.ts']);
const UI = module('m-ui', ['src/ui/c.ts']);

describe('seedConstraintsFromDerived', () => {
  it('proposes must-be-layer-above for a one-directional module pair', () => {
    const seeds = seedConstraintsFromDerived(clustering([API, DB], [moduleEdge('m-api', 'm-db')]));

    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.relation).toBe('must-be-layer-above');
    expect(seeds[0]?.subject.target).toBe('m-api');
    expect(seeds[0]?.object.target).toBe('m-db');
  });

  it('skips a module pair coupled in both directions', () => {
    const seeds = seedConstraintsFromDerived(
      clustering([API, DB], [moduleEdge('m-api', 'm-db'), moduleEdge('m-db', 'm-api')]),
    );
    expect(seeds).toHaveLength(0);
  });

  it('skips a self-edge', () => {
    const seeds = seedConstraintsFromDerived(clustering([API], [moduleEdge('m-api', 'm-api')]));
    expect(seeds).toHaveLength(0);
  });

  it('produces one seed per unordered pair, not per directed edge duplicate', () => {
    const seeds = seedConstraintsFromDerived(clustering([API, DB, UI], [moduleEdge('m-api', 'm-db')]));
    expect(seeds).toHaveLength(1);
  });

  it('handles a repository with no edges', () => {
    expect(seedConstraintsFromDerived(clustering([API, DB], []))).toEqual([]);
  });

  it('marks every seed as STATED, sourced seeded-from-derived, never user-authored', () => {
    const seeds = seedConstraintsFromDerived(clustering([API, DB], [moduleEdge('m-api', 'm-db')]));
    const seed = seeds[0];
    if (seed === undefined) throw new Error('no seed');
    expect(seed.provenance).toBe('STATED');
    expect(seed.source.type).toBe('seeded-from-derived');
    expect(seed.source.type).not.toBe('user-authored');
  });

  it('resolves both roles at full confidence — a seed already knows its module', () => {
    const seeds = seedConstraintsFromDerived(clustering([API, DB], [moduleEdge('m-api', 'm-db')]));
    const seed = seeds[0];
    if (seed === undefined) throw new Error('no seed');
    expect(seed.subject.status).toBe('MODULE');
    expect(seed.subject.similarity).toBe(1);
    expect(seed.object.status).toBe('MODULE');
    expect(seed.object.similarity).toBe(1);
  });

  it('is deterministic: same clustering in, byte-identical seeds out', () => {
    const input = clustering([API, DB, UI], [moduleEdge('m-api', 'm-db'), moduleEdge('m-ui', 'm-api')]);
    expect(JSON.stringify(seedConstraintsFromDerived(input))).toBe(
      JSON.stringify(seedConstraintsFromDerived(input)),
    );
  });

  it('is ordered by id, not by edge insertion order', () => {
    const seeds = seedConstraintsFromDerived(
      clustering([API, DB, UI], [moduleEdge('m-ui', 'm-api'), moduleEdge('m-api', 'm-db')]),
    );
    const ids = seeds.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('produces rawText that is itself valid blueprint DSL', () => {
    const seeds = seedConstraintsFromDerived(clustering([API, DB], [moduleEdge('m-api', 'm-db')]));
    expect(seeds[0]?.rawText).toBe('m-api must be layer above m-db');
  });
});
