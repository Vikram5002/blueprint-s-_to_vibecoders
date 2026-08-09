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

export const SCHEMA_VERSION = 1;

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
  `);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
