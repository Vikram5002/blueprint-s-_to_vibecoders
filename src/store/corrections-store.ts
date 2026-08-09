/**
 * Reading and writing user corrections.
 *
 * Member lists are stored sorted so the row is stable and the correction id —
 * a hash of kind plus members — is reproducible.
 */
import { randomUUID } from 'node:crypto';
import { correctionId } from '../graph/corrections.js';
import type { BlueprintDatabase } from './database.js';
import type {
  Correction,
  CorrectionKind,
  CorrectionOutcome,
  CorrectionRunRecord,
  SplitSide,
} from '../types/corrections.js';

interface CorrectionRow {
  readonly id: string;
  readonly kind: CorrectionKind;
  readonly label: string | null;
  readonly members: string;
  readonly sides: string;
  readonly created_at: string;
}

export interface NewCorrection {
  readonly kind: CorrectionKind;
  /** The module's members at the moment the user acted. */
  readonly members: readonly string[];
  readonly label?: string;
  readonly sides?: readonly SplitSide[];
}

export interface CorrectionsStore {
  list(): Correction[];
  save(correction: NewCorrection): Correction;
  remove(id: string): boolean;
  /** Records the outcomes of a run, so Week 9 can compare like with like. */
  recordRun(outcomes: readonly CorrectionOutcome[]): CorrectionRunRecord;
  runs(limit?: number): CorrectionRunRecord[];
}

export function createCorrectionsStore(db: BlueprintDatabase): CorrectionsStore {
  return {
    list: () =>
      (db.prepare('SELECT * FROM corrections ORDER BY id').all() as CorrectionRow[]).map(toCorrection),

    save: (input) => {
      const members = [...new Set(input.members)].sort();
      const sides = (input.sides ?? []).map((side) => ({
        label: side.label,
        files: [...new Set(side.files)].sort(),
      }));

      const correction: Correction = {
        id: correctionId(input.kind, members),
        kind: input.kind,
        members,
        label: input.label ?? null,
        sides,
        createdAt: new Date().toISOString(),
      };

      // Same kind over the same members replaces the earlier correction rather
      // than accumulating a second one that contradicts it.
      db.prepare(
        `INSERT INTO corrections (id, kind, label, members, sides, created_at)
         VALUES (@id, @kind, @label, @members, @sides, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           sides = excluded.sides,
           created_at = excluded.created_at`,
      ).run({
        id: correction.id,
        kind: correction.kind,
        label: correction.label,
        members: JSON.stringify(correction.members),
        sides: JSON.stringify(correction.sides),
        createdAt: correction.createdAt,
      });

      return correction;
    },

    remove: (id) => db.prepare('DELETE FROM corrections WHERE id = ?').run(id).changes > 0,

    recordRun: (outcomes) => {
      const runId = randomUUID();
      const createdAt = new Date().toISOString();

      const insertRun = db.prepare('INSERT INTO runs (id, created_at) VALUES (?, ?)');
      const insertOutcome = db.prepare(
        `INSERT INTO run_outcomes (run_id, correction_id, status, overlap, module_id, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      db.transaction(() => {
        insertRun.run(runId, createdAt);
        for (const outcome of outcomes) {
          insertOutcome.run(
            runId,
            outcome.correctionId,
            outcome.status,
            outcome.overlap,
            outcome.moduleId,
            JSON.stringify({
              joined: outcome.joined,
              left: outcome.left,
              unresolved: outcome.unresolved,
              explanation: outcome.explanation,
              kind: outcome.kind,
            }),
          );
        }
      })();

      return { runId, createdAt, outcomes };
    },

    runs: (limit = 20) => {
      const rows = db
        .prepare('SELECT id, created_at FROM runs ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit) as { id: string; created_at: string }[];

      return rows.map((row) => ({
        runId: row.id,
        createdAt: row.created_at,
        outcomes: (
          db
            .prepare('SELECT * FROM run_outcomes WHERE run_id = ? ORDER BY correction_id')
            .all(row.id) as {
            correction_id: string;
            status: string;
            overlap: number;
            module_id: string | null;
            detail: string;
          }[]
        ).map((outcome) => {
          const detail = safeDetail(outcome.detail);
          return {
            correctionId: outcome.correction_id,
            kind: detail.kind,
            status: outcome.status,
            overlap: outcome.overlap,
            moduleId: outcome.module_id,
            joined: detail.joined,
            left: detail.left,
            unresolved: detail.unresolved,
            explanation: detail.explanation,
          } as CorrectionOutcome;
        }),
      }));
    },
  };
}

function toCorrection(row: CorrectionRow): Correction {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    members: parseArray(row.members),
    sides: parseSides(row.sides),
    createdAt: row.created_at,
  };
}

interface OutcomeDetail {
  kind: CorrectionKind;
  joined: string[];
  left: string[];
  unresolved: string[];
  explanation: string;
}

function safeDetail(raw: string): OutcomeDetail {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Partial<OutcomeDetail>;
      return {
        kind: record.kind ?? 'rename',
        joined: record.joined ?? [],
        left: record.left ?? [],
        unresolved: record.unresolved ?? [],
        explanation: record.explanation ?? '',
      };
    }
  } catch {
    /* fall through */
  }
  return { kind: 'rename', joined: [], left: [], unresolved: [], explanation: '' };
}

function parseArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseSides(raw: string): SplitSide[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((side): SplitSide[] => {
      if (typeof side !== 'object' || side === null) return [];
      const record = side as { label?: unknown; files?: unknown };
      if (typeof record.label !== 'string' || !Array.isArray(record.files)) return [];
      return [{ label: record.label, files: record.files.filter((f): f is string => typeof f === 'string') }];
    });
  } catch {
    return [];
  }
}
