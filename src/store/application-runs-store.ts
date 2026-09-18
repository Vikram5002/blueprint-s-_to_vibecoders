/**
 * Persisting Layer 3 "Generate Application" runs (src/server/generation-api.ts)
 * against the workflow session they were generated from, plus any Page
 * Builder edits made to one of a run's generated pages.
 *
 * The application job store is in-memory, like the workflow job store
 * (ADR-002's accepted gap), so before this a finished run's badges, audit
 * log and download link vanished on the next tab switch and its files on
 * disk (`<root>/generated/<jobId>/`) were orphaned by the next restart. A
 * run is written once, when its job reaches a terminal state, and never
 * mutated - a repair of a run is a NEW run whose `parentId` names the old
 * one, so the history of what was tried stays honest.
 *
 * The job payload is stored opaquely (`job: TJob`): this module must not
 * depend on `server/`, and the shape is the server's to define.
 */
import type { BlueprintDatabase } from './database.js';

export type ApplicationRunKind = 'generate' | 'repair';

export interface ApplicationRunRecord<TJob = unknown> {
  /** The application job id - also the name of the run's directory on disk. */
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ApplicationRunKind;
  /** For a repair: the run whose files it started from. */
  readonly parentId: string | null;
  readonly status: 'succeeded' | 'failed';
  readonly createdAt: string;
  readonly job: TJob;
}

export interface ApplicationRunSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ApplicationRunKind;
  readonly parentId: string | null;
  readonly status: 'succeeded' | 'failed';
  readonly createdAt: string;
}

export interface StoredPageLayout<TLayout = unknown> {
  readonly runId: string;
  /** Repo-relative path of the generated page this layout replaces, e.g. frontend/src/pages/home.tsx. */
  readonly path: string;
  readonly layout: TLayout;
  /** The model-written file as it was before the first Page Builder save - what "restore" puts back. */
  readonly originalSource: string;
  readonly updatedAt: string;
}

export interface ApplicationRunsStore<TJob = unknown, TLayout = unknown> {
  save(record: ApplicationRunRecord<TJob>): void;
  get(id: string): ApplicationRunRecord<TJob> | undefined;
  /** Newest first. */
  listForSession(sessionId: string): ApplicationRunSummary[];
  latestForSession(sessionId: string): ApplicationRunRecord<TJob> | undefined;
  /** The newest run of every session that has one - what the sidebar's per-session status dot reads. */
  latestRuns(): ApplicationRunRecord<TJob>[];

  /** Insert or overwrite the layout; `originalSource` is kept from the FIRST save so repeated saves cannot lose the model's file. */
  savePageLayout(entry: Omit<StoredPageLayout<TLayout>, 'updatedAt'>): void;
  getPageLayout(runId: string, path: string): StoredPageLayout<TLayout> | undefined;
  listPageLayouts(runId: string): StoredPageLayout<TLayout>[];
  deletePageLayout(runId: string, path: string): void;
}

interface RunRow {
  readonly id: string;
  readonly session_id: string;
  readonly kind: string;
  readonly parent_id: string | null;
  readonly status: string;
  readonly body: string;
  readonly created_at: string;
}

interface LayoutRow {
  readonly run_id: string;
  readonly path: string;
  readonly layout: string;
  readonly original_source: string;
  readonly updated_at: string;
}

export function createApplicationRunsStore<TJob = unknown, TLayout = unknown>(
  db: BlueprintDatabase,
): ApplicationRunsStore<TJob, TLayout> {
  const toRecord = (row: RunRow): ApplicationRunRecord<TJob> | undefined => {
    const job = safeParse<TJob>(row.body);
    if (job === null) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind as ApplicationRunKind,
      parentId: row.parent_id,
      status: row.status as 'succeeded' | 'failed',
      createdAt: row.created_at,
      job,
    };
  };

  const toLayout = (row: LayoutRow): StoredPageLayout<TLayout> | undefined => {
    const layout = safeParse<TLayout>(row.layout);
    if (layout === null) return undefined;
    return { runId: row.run_id, path: row.path, layout, originalSource: row.original_source, updatedAt: row.updated_at };
  };

  return {
    save: (record) => {
      db.prepare(
        `INSERT INTO application_runs (id, session_id, kind, parent_id, status, body, created_at)
         VALUES (@id, @sessionId, @kind, @parentId, @status, @body, @createdAt)
         ON CONFLICT(id) DO NOTHING`,
      ).run({
        id: record.id,
        sessionId: record.sessionId,
        kind: record.kind,
        parentId: record.parentId,
        status: record.status,
        body: JSON.stringify(record.job),
        createdAt: record.createdAt,
      });
    },

    get: (id) => {
      const row = db.prepare('SELECT * FROM application_runs WHERE id = ?').get(id) as RunRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },

    listForSession: (sessionId) =>
      (
        db
          .prepare(
            'SELECT id, session_id, kind, parent_id, status, created_at FROM application_runs WHERE session_id = ? ORDER BY created_at DESC',
          )
          .all(sessionId) as readonly Omit<RunRow, 'body'>[]
      ).map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind as ApplicationRunKind,
        parentId: row.parent_id,
        status: row.status as 'succeeded' | 'failed',
        createdAt: row.created_at,
      })),

    latestForSession: (sessionId) => {
      const row = db
        .prepare('SELECT * FROM application_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(sessionId) as RunRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },

    latestRuns: () =>
      (
        db
          .prepare(
            `SELECT r.* FROM application_runs r
             WHERE r.created_at = (SELECT MAX(created_at) FROM application_runs WHERE session_id = r.session_id)
             ORDER BY r.created_at DESC`,
          )
          .all() as readonly RunRow[]
      )
        .map(toRecord)
        .filter((record): record is ApplicationRunRecord<TJob> => record !== undefined),

    savePageLayout: (entry) => {
      db.prepare(
        `INSERT INTO page_layouts (run_id, path, layout, original_source, updated_at)
         VALUES (@runId, @path, @layout, @originalSource, @updatedAt)
         ON CONFLICT(run_id, path) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
      ).run({
        runId: entry.runId,
        path: entry.path,
        layout: JSON.stringify(entry.layout),
        originalSource: entry.originalSource,
        updatedAt: new Date().toISOString(),
      });
    },

    getPageLayout: (runId, path) => {
      const row = db.prepare('SELECT * FROM page_layouts WHERE run_id = ? AND path = ?').get(runId, path) as
        | LayoutRow
        | undefined;
      return row === undefined ? undefined : toLayout(row);
    },

    listPageLayouts: (runId) =>
      (db.prepare('SELECT * FROM page_layouts WHERE run_id = ? ORDER BY path').all(runId) as readonly LayoutRow[])
        .map(toLayout)
        .filter((entry): entry is StoredPageLayout<TLayout> => entry !== undefined),

    deletePageLayout: (runId, path) => {
      db.prepare('DELETE FROM page_layouts WHERE run_id = ? AND path = ?').run(runId, path);
    },
  };
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
