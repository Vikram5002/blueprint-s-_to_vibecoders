/**
 * SQLite storage at `.vibe/blueprint.db`.
 *
 * Schema is created on open and versioned with `user_version`, so a future
 * migration has somewhere to stand. `.vibe/` is git-ignored by default; the
 * `--commit-db` case in docs/ARCHITECTURE.md is a Week 9 concern.
 *
 * The database holds user data — corrections a person made by hand — so it is
 * the one thing in this tool that cannot be regenerated. Everything else is
 * derived from the repository and can be thrown away.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { posix } from 'node:path';

export type BlueprintDatabase = Database.Database;

export const SCHEMA_VERSION = 3;

export function databasePathFor(root: string): string {
  return posix.join(root.replace(/\\/g, '/'), '.vibe', 'blueprint.db');
}

/**
 * Opens (creating if needed) the database and brings the schema up to date.
 * `:memory:` is accepted for tests.
 */
export function openDatabase(path: string): BlueprintDatabase {
  if (path !== ':memory:') {
    mkdirSync(posix.dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: BlueprintDatabase): void {
  const current = Number((db.pragma('user_version', { simple: true }) as number | bigint) ?? 0);
  if (current >= SCHEMA_VERSION) {
    return;
  }

  // v1 -> v2 adds snapshots. Written as CREATE TABLE IF NOT EXISTS throughout,
  // so an existing v1 database gains the new table and keeps its corrections —
  // the one thing here that cannot be regenerated.
  db.exec(`
    CREATE TABLE IF NOT EXISTS corrections (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('rename', 'merge', 'split')),
      label       TEXT,
      members     TEXT NOT NULL,
      sides       TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL
    );

    -- Which corrections were in force for a run, and what happened to each.
    -- Week 9 compares snapshots; two snapshots taken under different
    -- corrections are not comparable, so the set is recorded per run.
    CREATE TABLE IF NOT EXISTS run_outcomes (
      run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      correction_id TEXT NOT NULL,
      status        TEXT NOT NULL,
      overlap       REAL NOT NULL,
      module_id     TEXT,
      detail        TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (run_id, correction_id)
    );

    CREATE INDEX IF NOT EXISTS run_outcomes_by_correction
      ON run_outcomes (correction_id);

    -- One row per commit. Keyed on the sha rather than the snapshot id: one
    -- snapshot per commit is the invariant the diff relies on, and keying on
    -- content would let a single commit accumulate rows as the analyser
    -- changed, charting the same point in history more than once.
    --
    -- The scalar columns are duplicated out of the body column so a history
    -- query can read a chart without parsing 200 JSON blobs.
    CREATE TABLE IF NOT EXISTS snapshots (
      commit_sha      TEXT PRIMARY KEY,
      snapshot_id     TEXT NOT NULL,
      committed_at    TEXT NOT NULL,
      subject         TEXT NOT NULL,
      file_count      INTEGER NOT NULL,
      edge_count      INTEGER NOT NULL,
      module_count    INTEGER NOT NULL,
      violation_count INTEGER NOT NULL,
      drift_score     REAL NOT NULL,
      body            TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    -- History is always read in commit-date order.
    CREATE INDEX IF NOT EXISTS snapshots_by_date
      ON snapshots (committed_at, commit_sha);

    -- v2 -> v3 adds the authored blueprint. One row per compiled Constraint,
    -- content-derived id (same hash as dsl.ts's constraintId), so re-authoring
    -- the same rule text is a no-op rather than an accumulating duplicate. The
    -- whole set is replaced together on each --blueprint run (see
    -- blueprint-store.ts's replace()) because a blueprint is authored as one
    -- file, not accreted line by line across sessions -- a line deleted from
    -- the file must disappear from the store, not linger as a stale rule.
    CREATE TABLE IF NOT EXISTS blueprint_constraints (
      id          TEXT PRIMARY KEY,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
