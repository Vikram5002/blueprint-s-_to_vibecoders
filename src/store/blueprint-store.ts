/**
 * Persisting the authored blueprint.
 *
 * A blueprint is authored as one file and replaced as a whole on each
 * `--blueprint` run — see database.ts's `blueprint_constraints` table comment
 * for why this replaces rather than accretes. Between runs (an MCP session,
 * a plain analysis) the last-saved set is read back unchanged, so an agent
 * asking `check_import` sees the same authored rules the CLI compiled.
 */
import type { BlueprintDatabase } from './database.js';
import type { Constraint } from '../types/constraints.js';

interface BlueprintRow {
  readonly id: string;
  readonly body: string;
  readonly created_at: string;
}

export interface BlueprintStore {
  list(): Constraint[];
  /** Replaces the entire stored blueprint with `constraints` in one transaction. */
  replace(constraints: readonly Constraint[]): void;
  /**
   * Adds `constraints` to whatever is already stored, keyed by id — a
   * constraint with an id already present is left untouched rather than
   * duplicated or overwritten. Used only by the seed-acceptance endpoint
   * (Part A.2): accepting a candidate augments the blueprint a user is
   * building, it does not restart it the way a `--blueprint` file re-author
   * does.
   */
  append(constraints: readonly Constraint[]): void;
  clear(): void;
}

export function createBlueprintStore(db: BlueprintDatabase): BlueprintStore {
  return {
    list: () =>
      (db.prepare('SELECT * FROM blueprint_constraints ORDER BY id').all() as BlueprintRow[])
        .map((row) => safeParse(row.body))
        .filter((constraint): constraint is Constraint => constraint !== null),

    replace: (constraints) => {
      const createdAt = new Date().toISOString();
      const deleteAll = db.prepare('DELETE FROM blueprint_constraints');
      const insert = db.prepare(
        'INSERT INTO blueprint_constraints (id, body, created_at) VALUES (@id, @body, @createdAt)',
      );

      db.transaction(() => {
        deleteAll.run();
        for (const constraint of constraints) {
          insert.run({ id: constraint.id, body: JSON.stringify(constraint), createdAt });
        }
      })();
    },

    append: (constraints) => {
      const createdAt = new Date().toISOString();
      const insert = db.prepare(
        `INSERT INTO blueprint_constraints (id, body, created_at) VALUES (@id, @body, @createdAt)
         ON CONFLICT(id) DO NOTHING`,
      );

      db.transaction(() => {
        for (const constraint of constraints) {
          insert.run({ id: constraint.id, body: JSON.stringify(constraint), createdAt });
        }
      })();
    },

    clear: () => {
      db.prepare('DELETE FROM blueprint_constraints').run();
    },
  };
}

function safeParse(raw: string): Constraint | null {
  try {
    return JSON.parse(raw) as Constraint;
  } catch {
    return null;
  }
}
