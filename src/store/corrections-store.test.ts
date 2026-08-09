import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { databasePathFor, openDatabase, SCHEMA_VERSION } from './database.js';
import { createCorrectionsStore } from './corrections-store.js';
import type { CorrectionOutcome } from '../types/corrections.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-store-'));
  roots.push(root);
  return root;
}

const outcome = (overrides: Partial<CorrectionOutcome> = {}): CorrectionOutcome => ({
  correctionId: 'abc123',
  kind: 'rename',
  status: 'applied',
  overlap: 1,
  moduleId: 'module-000',
  joined: [],
  left: [],
  unresolved: [],
  explanation: 'Membership is unchanged.',
  ...overrides,
});

describe('database', () => {
  it('creates the schema and stamps a version', () => {
    const db = openDatabase(':memory:');
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('creates .vibe on disk when given a real path', async () => {
    const root = await tempRoot();
    const db = openDatabase(databasePathFor(root));
    db.close();
    expect(existsSync(join(root, '.vibe', 'blueprint.db'))).toBe(true);
  });

  it('is safe to open twice', async () => {
    const root = await tempRoot();
    const path = databasePathFor(root);
    const first = openDatabase(path);
    first.close();
    const second = openDatabase(path);
    expect(Number(second.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    second.close();
  });
});

describe('saving corrections', () => {
  it('round-trips a rename', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    const saved = store.save({ kind: 'rename', members: ['b.ts', 'a.ts'], label: 'Auth' });
    const [loaded] = store.list();

    expect(loaded?.id).toBe(saved.id);
    expect(loaded?.label).toBe('Auth');
    // Sorted on the way in, so the id is reproducible.
    expect(loaded?.members).toEqual(['a.ts', 'b.ts']);
    db.close();
  });

  it('round-trips a split with explicit sides', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    store.save({
      kind: 'split',
      members: ['a.ts', 'b.ts', 'c.ts'],
      sides: [
        { label: 'Left', files: ['a.ts'] },
        { label: 'Right', files: ['c.ts', 'b.ts'] },
      ],
    });

    const [loaded] = store.list();
    expect(loaded?.kind).toBe('split');
    expect(loaded?.sides).toEqual([
      { label: 'Left', files: ['a.ts'] },
      { label: 'Right', files: ['b.ts', 'c.ts'] },
    ]);
    db.close();
  });

  it('replaces rather than duplicating the same correction', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    store.save({ kind: 'rename', members: ['a.ts'], label: 'First' });
    store.save({ kind: 'rename', members: ['a.ts'], label: 'Second' });

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.label).toBe('Second');
    db.close();
  });

  it('keeps corrections of different kinds over the same files apart', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    store.save({ kind: 'rename', members: ['a.ts'], label: 'R' });
    store.save({ kind: 'merge', members: ['a.ts'], label: 'M' });

    expect(store.list()).toHaveLength(2);
    db.close();
  });

  it('lists in a stable order', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    store.save({ kind: 'rename', members: ['z.ts'], label: 'Z' });
    store.save({ kind: 'rename', members: ['a.ts'], label: 'A' });

    const ids = store.list().map((correction) => correction.id);
    expect([...ids].sort()).toEqual(ids);
    db.close();
  });

  it('removes a correction', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    const saved = store.save({ kind: 'rename', members: ['a.ts'], label: 'X' });
    expect(store.remove(saved.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove('does-not-exist')).toBe(false);
    db.close();
  });

  it('survives a process restart', async () => {
    const root = await tempRoot();
    const path = databasePathFor(root);

    const first = openDatabase(path);
    createCorrectionsStore(first).save({ kind: 'rename', members: ['a.ts'], label: 'Persisted' });
    first.close();

    const second = openDatabase(path);
    expect(createCorrectionsStore(second).list()[0]?.label).toBe('Persisted');
    second.close();
  });
});

describe('run provenance', () => {
  it('records which corrections were active and what happened', () => {
    // Week 9 compares snapshots; two taken under different corrections are not
    // comparable, so the set in force is recorded per run.
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    const record = store.recordRun([
      outcome({ correctionId: 'aaa', status: 'applied' }),
      outcome({
        correctionId: 'bbb',
        status: 'applied-with-drift',
        overlap: 0.7,
        joined: ['new.ts'],
        left: ['old.ts'],
      }),
      outcome({ correctionId: 'ccc', status: 'orphaned', overlap: 0.1, moduleId: null }),
    ]);

    expect(record.outcomes).toHaveLength(3);

    const [run] = store.runs();
    expect(run?.runId).toBe(record.runId);
    expect(run?.outcomes.map((o) => o.status)).toEqual(['applied', 'applied-with-drift', 'orphaned']);

    const drift = run?.outcomes.find((o) => o.correctionId === 'bbb');
    expect(drift?.joined).toEqual(['new.ts']);
    expect(drift?.left).toEqual(['old.ts']);
    expect(drift?.overlap).toBeCloseTo(0.7, 5);
  });

  it('preserves unresolved split assignments across a reload', async () => {
    const root = await tempRoot();
    const path = databasePathFor(root);

    const first = openDatabase(path);
    createCorrectionsStore(first).recordRun([
      outcome({ correctionId: 'split1', kind: 'split', unresolved: ['mystery.ts'] }),
    ]);
    first.close();

    const second = openDatabase(path);
    const [run] = createCorrectionsStore(second).runs();
    expect(run?.outcomes[0]?.unresolved).toEqual(['mystery.ts']);
    expect(run?.outcomes[0]?.kind).toBe('split');
    second.close();
  });

  it('returns runs newest first', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    const first = store.recordRun([outcome({ correctionId: 'a' })]);
    const second = store.recordRun([outcome({ correctionId: 'b' })]);

    const runs = store.runs();
    expect(runs).toHaveLength(2);
    expect(new Set([first.runId, second.runId])).toEqual(new Set(runs.map((r) => r.runId)));
  });

  it('records a run with no corrections at all', () => {
    const db = openDatabase(':memory:');
    const store = createCorrectionsStore(db);

    const record = store.recordRun([]);
    expect(record.outcomes).toEqual([]);
    expect(store.runs()[0]?.outcomes).toEqual([]);
    db.close();
  });
});
