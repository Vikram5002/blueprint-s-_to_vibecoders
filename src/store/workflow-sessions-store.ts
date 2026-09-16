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
}

export function createWorkflowSessionsStore(db: BlueprintDatabase): WorkflowSessionsStore {
  return {
    save: (session) => {
      db.prepare(
        `INSERT INTO workflow_sessions (id, title, prompt, body, created_at)
         VALUES (@id, @title, @prompt, @body, @createdAt)
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
      });
    },

    list: () =>
      (
        db
          .prepare('SELECT id, title, prompt, created_at FROM workflow_sessions ORDER BY created_at DESC')
          .all() as readonly Pick<WorkflowSessionRow, 'id' | 'title' | 'prompt' | 'created_at'>[]
      ).map((row) => ({ id: row.id, title: row.title, prompt: row.prompt, createdAt: row.created_at })),

    get: (id) => {
      const row = db.prepare('SELECT * FROM workflow_sessions WHERE id = ?').get(id) as
        | WorkflowSessionRow
        | undefined;
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
