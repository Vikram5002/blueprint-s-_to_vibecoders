/**
 * Persisting Layer 2 generation runs (prompt -> ValidatedProjectSchema ->
 * compiled constraints, src/server/workflow-api.ts) so the workspace's
 * Sessions sidebar has something real to list — the job store those runs
 * come from is in-memory only (ADR-002's accepted gap), so without this a
 * finished run is gone the moment the tab closes or the server restarts.
 *
 * Append-only: a session is a record of what a past run produced, never
 * edited in place.
 */
import type { BlueprintDatabase } from './database.js';
import type { Constraint } from '../types/constraints.js';
import type { WorkflowPermission } from '../workflow/compile-constraints.js';
import type { ValidatedProjectSchema } from '../types/project-schema.js';

interface WorkflowSessionRow {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly body: string;
  readonly created_at: string;
  readonly owner: string | null;
}

export interface WorkflowSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly createdAt: string;
}

export interface WorkflowSessionDetail extends WorkflowSessionSummary {
  readonly schema: ValidatedProjectSchema;
  readonly prohibitions: readonly Constraint[];
  readonly permissions: readonly WorkflowPermission[];
}

interface StoredBody {
  readonly schema: ValidatedProjectSchema;
  readonly prohibitions: readonly Constraint[];
  readonly permissions: readonly WorkflowPermission[];
}

export interface WorkflowSessionsStore {
  save(session: WorkflowSessionDetail): void;
  /** Newest first — the order the sidebar renders them in. */
  list(): WorkflowSessionSummary[];
  get(id: string): WorkflowSessionDetail | undefined;
  /**
   * Replaces an existing session's plan - when a person adds or removes
   * components. `save` never overwrites (a session's first record is kept);
   * this is the one deliberate way its plan changes afterwards.
   */
  updatePlan(id: string, plan: { readonly schema: ValidatedProjectSchema; readonly prohibitions: readonly Constraint[]; readonly permissions: readonly WorkflowPermission[] }): void;
  /**
   * Replaces a session's prompt, title and plan together - when a person
   * revises the plan by prompt before generating. The session keeps its id
   * and creation time, so it stays one entry in the sidebar.
   */
  revise(id: string, revision: { readonly title: string; readonly prompt: string; readonly schema: ValidatedProjectSchema; readonly prohibitions: readonly Constraint[]; readonly permissions: readonly WorkflowPermission[] }): void;
  /** Deletes a session. True when one existed. Its runs are the runs store's to delete. */
  remove(id: string): boolean;
}

export interface WorkflowSessionsStoreOptions {
  /**
   * Who is asking, in hosted mode: the requesting browser's id, or null on a
   * local install (one person, every session theirs - the default). With an
   * owner, sessions are saved under it and every other owner's sessions are
   * invisible: not listed, not readable, not changeable, not deletable.
   */
  readonly owner?: () => string | null;
}

export function createWorkflowSessionsStore(db: BlueprintDatabase, options: WorkflowSessionsStoreOptions = {}): WorkflowSessionsStore {
  const owner = options.owner ?? ((): null => null);
  /** The row, if it exists and the current owner may see it. */
  const visible = (id: string): WorkflowSessionRow | undefined => {
    const row = db.prepare('SELECT * FROM workflow_sessions WHERE id = ?').get(id) as WorkflowSessionRow | undefined;
    const who = owner();
    return row === undefined || (who !== null && row.owner !== who) ? undefined : row;
  };

  return {
    save: (session) => {
      db.prepare(
        `INSERT INTO workflow_sessions (id, title, prompt, body, created_at, owner)
         VALUES (@id, @title, @prompt, @body, @createdAt, @owner)
         ON CONFLICT(id) DO NOTHING`,
      ).run({
        id: session.id,
        title: session.title,
        prompt: session.prompt,
        body: JSON.stringify({
          schema: session.schema,
          prohibitions: session.prohibitions,
          permissions: session.permissions,
        } satisfies StoredBody),
        createdAt: session.createdAt,
        owner: owner(),
      });
    },

    updatePlan: (id, plan) => {
      if (visible(id) === undefined) return;
      db.prepare('UPDATE workflow_sessions SET body = @body WHERE id = @id').run({ id, body: JSON.stringify(plan) });
    },

    revise: (id, { title, prompt, schema, prohibitions, permissions }) => {
      if (visible(id) === undefined) return;
      db.prepare('UPDATE workflow_sessions SET title = @title, prompt = @prompt, body = @body WHERE id = @id').run({
        id,
        title,
        prompt,
        body: JSON.stringify({ schema, prohibitions, permissions } satisfies StoredBody),
      });
    },

    remove: (id) => visible(id) !== undefined && db.prepare('DELETE FROM workflow_sessions WHERE id = ?').run(id).changes > 0,

    list: () => {
      const who = owner();
      const rows = (
        who === null
          ? db.prepare('SELECT id, title, prompt, created_at FROM workflow_sessions ORDER BY created_at DESC').all()
          : db.prepare('SELECT id, title, prompt, created_at FROM workflow_sessions WHERE owner = ? ORDER BY created_at DESC').all(who)
      ) as readonly Pick<WorkflowSessionRow, 'id' | 'title' | 'prompt' | 'created_at'>[];
      return rows.map((row) => ({ id: row.id, title: row.title, prompt: row.prompt, createdAt: row.created_at }));
    },

    get: (id) => {
      const row = visible(id);
      if (row === undefined) return undefined;
      const stored = safeParse(row.body);
      if (stored === null) return undefined;
      return {
        id: row.id,
        title: row.title,
        prompt: row.prompt,
        createdAt: row.created_at,
        schema: stored.schema,
        prohibitions: stored.prohibitions,
        permissions: stored.permissions,
      };
    },
  };
}

function safeParse(raw: string): StoredBody | null {
  try {
    return JSON.parse(raw) as StoredBody;
  } catch {
    return null;
  }
}
