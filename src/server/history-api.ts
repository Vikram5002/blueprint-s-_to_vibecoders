/**
 * Time-travel routes: what changed between two commits, and drift over history.
 *
 * Reads snapshots the CLI already stored. Deliberately does **not** compute
 * them on demand — a snapshot costs a git worktree and a full re-analysis, and
 * an HTTP handler that takes ninety seconds and spawns worktrees is a handler
 * that will be called twice concurrently by a page refresh. The server serves
 * what `--history=N` recorded, and says so when there is nothing recorded.
 */
import { diffSnapshots } from '../conformance/diff.js';
import { buildDriftHistory } from '../pipeline/drift-history.js';
import { createSnapshotStore } from '../store/snapshots.js';
import type { AnalysisContext } from './context.js';
import type { SnapshotDiff } from '../conformance/diff.js';
import type { DriftHistory } from '../pipeline/drift-history.js';

export type DiffResponse =
  | { readonly ok: true; readonly diff: SnapshotDiff }
  | { readonly ok: false; readonly reason: string; readonly available: readonly string[] };

export type DriftHistoryResponse =
  | { readonly ok: true; readonly history: DriftHistory }
  | { readonly ok: false; readonly reason: string };

/**
 * Accepts a full sha or any unambiguous prefix.
 *
 * Users copy short shas out of `git log`; requiring 40 characters would make
 * the route unusable by hand. An ambiguous prefix is rejected rather than
 * resolved to the first match — silently picking one of two commits is the kind
 * of helpfulness that produces a diff of the wrong thing.
 */
export function resolveCommit(
  requested: string,
  available: readonly string[],
): { readonly sha: string } | { readonly error: string } {
  const trimmed = requested.trim().toLowerCase();
  if (trimmed === '') return { error: 'no commit given' };

  const exact = available.find((sha) => sha.toLowerCase() === trimmed);
  if (exact !== undefined) return { sha: exact };

  const matches = available.filter((sha) => sha.toLowerCase().startsWith(trimmed));
  if (matches.length === 1) return { sha: matches[0] as string };
  if (matches.length > 1) {
    return { error: `"${requested}" matches ${matches.length} snapshots; use more characters` };
  }
  return { error: `no snapshot for "${requested}"` };
}

export function buildDiffResponse(context: AnalysisContext, from: string, to: string): DiffResponse {
  const store = createSnapshotStore(context.db);
  const available = store.commits();

  if (available.length === 0) {
    return {
      ok: false,
      reason: 'No snapshots have been recorded. Run with --history=N to build them.',
      available,
    };
  }

  const fromRef = resolveCommit(from, available);
  if ('error' in fromRef) return { ok: false, reason: `from: ${fromRef.error}`, available };
  const toRef = resolveCommit(to, available);
  if ('error' in toRef) return { ok: false, reason: `to: ${toRef.error}`, available };

  const fromSnapshot = store.get(fromRef.sha);
  const toSnapshot = store.get(toRef.sha);
  if (fromSnapshot === null || toSnapshot === null) {
    return { ok: false, reason: 'snapshot missing from the store', available };
  }

  return { ok: true, diff: diffSnapshots(fromSnapshot, toSnapshot) };
}

export function buildDriftHistoryResponse(context: AnalysisContext): DriftHistoryResponse {
  const snapshots = createSnapshotStore(context.db).history();
  if (snapshots.length === 0) {
    return {
      ok: false,
      reason: 'No snapshots have been recorded. Run with --history=N to build them.',
    };
  }
  return { ok: true, history: buildDriftHistory(snapshots) };
}
