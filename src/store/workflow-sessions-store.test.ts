import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createWorkflowSessionsStore } from './workflow-sessions-store.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { ProjectSchema, ValidatedProjectSchema } from '../types/project-schema.js';
import type { WorkflowSessionDetail } from './workflow-sessions-store.js';

function asValidated(candidate: ProjectSchema): ValidatedProjectSchema {
  const result = validateProjectSchema(candidate);
  if (!result.ok) {
    throw new Error(`test fixture failed real validateProjectSchema: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function session(overrides: Partial<WorkflowSessionDetail> = {}): WorkflowSessionDetail {
  const schema = asValidated({
    sessionId: overrides.id ?? 'session-1',
    title: overrides.title ?? 'A test app',
    originalPrompt: overrides.prompt ?? 'build a test app',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: { components: [], dependsOn: [] },
      database: { components: [], dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED',
  });
  return {
    id: overrides.id ?? 'session-1',
    title: overrides.title ?? 'A test app',
    prompt: overrides.prompt ?? 'build a test app',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    schema,
    prohibitions: [],
    permissions: [],
  };
}

describe('createWorkflowSessionsStore', () => {
  it('starts empty', () => {
    const store = createWorkflowSessionsStore(openDatabase(':memory:'));
    expect(store.list()).toEqual([]);
  });

  it('round-trips a session through save/get, including the full schema', () => {
    const store = createWorkflowSessionsStore(openDatabase(':memory:'));
    const saved = session();
    store.save(saved);

    const fetched = store.get('session-1');
    expect(fetched).toEqual(saved);
  });

  it('revise replaces title, prompt and plan but keeps the id and creation time', () => {
    const store = createWorkflowSessionsStore(openDatabase(':memory:'));
    store.save(session());
    const next = session({ title: 'Revised app', prompt: 'build a test app\n\nChanges to the plan:\n- add login' });
    store.revise('session-1', { title: next.title, prompt: next.prompt, schema: next.schema, prohibitions: [], permissions: [] });

    expect(store.get('session-1')).toEqual({ ...next, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(store.list()).toHaveLength(1);
  });

  it('get returns undefined for an unknown id', () => {
    const store = createWorkflowSessionsStore(openDatabase(':memory:'));
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('list returns summaries only, newest first', () => {
    const store = createWorkflowSessionsStore(openDatabase(':memory:'));
    store.save(session({ id: 'a', title: 'First', createdAt: '2026-01-01T00:00:00.000Z' }));
    store.save(session({ id: 'b', title: 'Second', createdAt: '2026-01-02T00:00:00.000Z' }));

    expect(store.list()).toEqual([
      { id: 'b', title: 'Second', prompt: 'build a test app', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'a', title: 'First', prompt: 'build a test app', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('saving the same id twice keeps the first write - sessions are append-only, never overwritten', () => {
    const store = createWorkflowSessionsStore(openDatabase(':memory:'));
    store.save(session({ id: 'a', title: 'Original' }));
    store.save(session({ id: 'a', title: 'Replacement' }));

    expect(store.list()).toHaveLength(1);
    expect(store.get('a')?.title).toBe('Original');
  });
});

describe('owners (hosted mode)', () => {
  function storeFor(db: ReturnType<typeof openDatabase>, who: { current: string | null }) {
    return createWorkflowSessionsStore(db, { owner: () => who.current });
  }

  it('lists, reads, changes and deletes only the asking owner\'s sessions', () => {
    const db = openDatabase(':memory:');
    const who = { current: 'alice' as string | null };
    const store = storeFor(db, who);
    store.save(session({ id: 's-alice', title: 'Alice app' }));
    who.current = 'bob';
    store.save(session({ id: 's-bob', title: 'Bob app' }));

    expect(store.list().map((s) => s.id)).toEqual(['s-bob']);
    expect(store.get('s-alice')).toBeUndefined();
    expect(store.remove('s-alice')).toBe(false);
    store.revise('s-alice', { title: 'hijacked', prompt: 'x', schema: session().schema, prohibitions: [], permissions: [] });

    who.current = 'alice';
    expect(store.list().map((s) => s.id)).toEqual(['s-alice']);
    expect(store.get('s-alice')?.title).toBe('Alice app');
    expect(store.remove('s-alice')).toBe(true);
    db.close();
  });

  it('a local install (no owner) sees every session, including ones saved before owners existed', () => {
    const db = openDatabase(':memory:');
    const who = { current: null as string | null };
    const store = storeFor(db, who);
    store.save(session({ id: 's-old' }));
    who.current = 'carol';
    store.save(session({ id: 's-carol' }));
    who.current = null;
    expect(store.list().map((s) => s.id).sort()).toEqual(['s-carol', 's-old']);
    // An ownerless (local) session is not visible to a hosted owner.
    who.current = 'carol';
    expect(store.get('s-old')).toBeUndefined();
    db.close();
  });
});
