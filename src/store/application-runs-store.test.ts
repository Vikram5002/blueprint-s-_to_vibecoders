import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePathFor, openDatabase, type BlueprintDatabase } from './database.js';
import { createApplicationRunsStore, type ApplicationRunRecord } from './application-runs-store.js';

interface FakeJob {
  readonly note: string;
}

function run(overrides: Partial<ApplicationRunRecord<FakeJob>> = {}): ApplicationRunRecord<FakeJob> {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    kind: 'generate',
    parentId: null,
    status: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    job: { note: 'first' },
    ...overrides,
  };
}

describe('createApplicationRunsStore', () => {
  let root: string;
  let db: BlueprintDatabase;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-runs-store-'));
    db = openDatabase(databasePathFor(root));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a run with its opaque job payload', () => {
    const store = createApplicationRunsStore<FakeJob>(db);
    store.save(run());
    expect(store.get('run-1')).toEqual(run());
    expect(store.get('missing')).toBeUndefined();
  });

  it('never overwrites a run - a record is what happened, not a live document', () => {
    const store = createApplicationRunsStore<FakeJob>(db);
    store.save(run());
    store.save(run({ job: { note: 'second' } }));
    expect(store.get('run-1')?.job.note).toBe('first');
  });

  it('lists a session\'s runs newest first, and finds the latest one with its payload', () => {
    const store = createApplicationRunsStore<FakeJob>(db);
    store.save(run({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }));
    store.save(run({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z', kind: 'repair', parentId: 'a', status: 'failed' }));
    store.save(run({ id: 'other', sessionId: 'session-2' }));

    expect(store.listForSession('session-1').map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(store.listForSession('session-1')[0]).toMatchObject({ kind: 'repair', parentId: 'a', status: 'failed' });
    expect(store.latestForSession('session-1')?.id).toBe('b');
    expect(store.latestForSession('nobody')).toBeUndefined();
    expect(store.latestRuns().map((entry) => entry.id)).toEqual(['b', 'other']);
  });

  describe('page layouts', () => {
    it('keeps the ORIGINAL source across repeated saves of the same page, so restore always has the model\'s file', () => {
      const store = createApplicationRunsStore<FakeJob, { readonly n: number }>(db);
      store.savePageLayout({ runId: 'run-1', path: 'frontend/src/pages/home.tsx', layout: { n: 1 }, originalSource: 'ORIGINAL' });
      store.savePageLayout({ runId: 'run-1', path: 'frontend/src/pages/home.tsx', layout: { n: 2 }, originalSource: 'NOT THIS' });

      const stored = store.getPageLayout('run-1', 'frontend/src/pages/home.tsx');
      expect(stored?.layout).toEqual({ n: 2 });
      expect(stored?.originalSource).toBe('ORIGINAL');
    });

    it('lists per run and deletes one page', () => {
      const store = createApplicationRunsStore<FakeJob, { readonly n: number }>(db);
      store.savePageLayout({ runId: 'run-1', path: 'frontend/src/pages/b.tsx', layout: { n: 1 }, originalSource: 'b' });
      store.savePageLayout({ runId: 'run-1', path: 'frontend/src/pages/a.tsx', layout: { n: 1 }, originalSource: 'a' });
      store.savePageLayout({ runId: 'run-2', path: 'frontend/src/pages/a.tsx', layout: { n: 1 }, originalSource: 'a' });

      expect(store.listPageLayouts('run-1').map((entry) => entry.path)).toEqual(['frontend/src/pages/a.tsx', 'frontend/src/pages/b.tsx']);
      store.deletePageLayout('run-1', 'frontend/src/pages/a.tsx');
      expect(store.listPageLayouts('run-1').map((entry) => entry.path)).toEqual(['frontend/src/pages/b.tsx']);
      expect(store.getPageLayout('run-1', 'frontend/src/pages/a.tsx')).toBeUndefined();
    });
  });
});
