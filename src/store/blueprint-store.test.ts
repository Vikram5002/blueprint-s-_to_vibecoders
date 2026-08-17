import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createBlueprintStore } from './blueprint-store.js';
import type { Constraint, ResolvedSubject } from '../types/constraints.js';

function subject(target: string): ResolvedSubject {
  return { phrase: target, status: 'MODULE', target, reason: null, similarity: 1, alternatives: [] };
}

function constraint(id: string): Constraint {
  return {
    id,
    relation: 'must-not-import',
    subject: subject('m-domain'),
    object: subject('m-infra'),
    via: null,
    source: { type: 'user-authored', location: 'blueprint.txt', line: 1, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText: 'domain must not import infra',
    provenance: 'STATED',
  };
}

describe('createBlueprintStore', () => {
  it('starts empty', () => {
    const store = createBlueprintStore(openDatabase(':memory:'));
    expect(store.list()).toEqual([]);
  });

  it('round-trips a constraint through replace/list', () => {
    const store = createBlueprintStore(openDatabase(':memory:'));
    store.replace([constraint('c1')]);
    expect(store.list()).toEqual([constraint('c1')]);
  });

  it('replace discards whatever was there before', () => {
    const store = createBlueprintStore(openDatabase(':memory:'));
    store.replace([constraint('c1'), constraint('c2')]);
    store.replace([constraint('c3')]);
    expect(store.list().map((c) => c.id)).toEqual(['c3']);
  });

  it('replace with an empty array clears the store', () => {
    const store = createBlueprintStore(openDatabase(':memory:'));
    store.replace([constraint('c1')]);
    store.replace([]);
    expect(store.list()).toEqual([]);
  });

  it('clear empties the store directly', () => {
    const store = createBlueprintStore(openDatabase(':memory:'));
    store.replace([constraint('c1')]);
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it('lists in id order', () => {
    const store = createBlueprintStore(openDatabase(':memory:'));
    store.replace([constraint('c9'), constraint('c1'), constraint('c5')]);
    expect(store.list().map((c) => c.id)).toEqual(['c1', 'c5', 'c9']);
  });

  describe('append', () => {
    it('adds to an empty store', () => {
      const store = createBlueprintStore(openDatabase(':memory:'));
      store.append([constraint('c1')]);
      expect(store.list().map((c) => c.id)).toEqual(['c1']);
    });

    it('adds alongside what is already there, unlike replace', () => {
      const store = createBlueprintStore(openDatabase(':memory:'));
      store.replace([constraint('c1')]);
      store.append([constraint('c2')]);
      expect(store.list().map((c) => c.id)).toEqual(['c1', 'c2']);
    });

    it('leaves an existing id untouched rather than duplicating or overwriting', () => {
      const store = createBlueprintStore(openDatabase(':memory:'));
      store.replace([constraint('c1')]);
      store.append([constraint('c1')]);
      expect(store.list()).toHaveLength(1);
    });
  });
});
