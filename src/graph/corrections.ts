/**
 * Applying stored user corrections to a fresh clustering.
 *
 * ## The key problem
 *
 * A correction is made against a module that existed at some commit. On the
 * next run the repository has moved and the clustering is recomputed, so there
 * is no id to look the correction up by — ids are content-derived, and the
 * content changed.
 *
 * Hashing the full file set as the key is the obvious approach and is wrong:
 * adding one file changes the hash, the correction silently vanishes, and the
 * user has no idea why their rename disappeared. Instead a correction stores
 * its member set and is matched by **Jaccard overlap** against the modules of
 * the new clustering — the same statistic Week 5 uses to measure cluster
 * stability across commits, on the same 0-1 scale.
 *
 * Three outcomes, always reported:
 *
 *   applied            overlap >= threshold and membership is identical
 *   applied-with-drift overlap >= threshold but membership moved; the files
 *                      that joined and left are named
 *   orphaned           overlap < threshold; not applied, surfaced for review
 *
 * Drift is never applied quietly. That is what makes the threshold a
 * comfortable choice rather than a critical one: set it slightly low and the
 * user gets a loud drift report, not a wrong rename they never saw.
 *
 * ## Determinism
 *
 * Corrections are applied in id order, after the algorithm has finished and
 * before canonicalisation, so ids stay content-derived — of the corrected
 * content. Matching breaks ties on overlap then module id. Same repository plus
 * same corrections gives byte-identical output.
 */
import { createHash } from 'node:crypto';
import { jaccardSets } from './partition.js';
import type { Correction, CorrectionOutcome, SplitSide } from '../types/corrections.js';

/**
 * Minimum overlap for a correction to be considered the same module.
 *
 * 0.6: a module can grow by roughly two-thirds, or lose about 40% of its files,
 * and still be recognised. Beyond that it is a different unit and the user
 * should look again. Rationale and the sensitivity of small modules are in
 * docs/CORRECTIONS.md.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.6;

/** Members keyed by module id — the shape corrections are matched against. */
export type MembershipGroups = ReadonlyMap<string, readonly string[]>;

export interface ApplyCorrectionsResult {
  /** file -> synthetic cluster key, for the files corrections moved. */
  readonly overrides: ReadonlyMap<string, string>;
  /** Labels the corrections assign, keyed by the same synthetic keys. */
  readonly labels: ReadonlyMap<string, string>;
  readonly outcomes: readonly CorrectionOutcome[];
}

export function correctionId(kind: string, members: readonly string[]): string {
  return createHash('sha256')
    .update(`${kind} ${[...members].sort().join(' ')}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Matches every correction against the current grouping and returns the file
 * moves to apply, plus an outcome for each correction.
 */
export function applyCorrections(
  groups: MembershipGroups,
  corrections: readonly Correction[],
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): ApplyCorrectionsResult {
  const overrides = new Map<string, string>();
  const labels = new Map<string, string>();
  const outcomes: CorrectionOutcome[] = [];

  // Fixed order, so two runs apply the same corrections the same way.
  const ordered = [...corrections].sort((a, b) => a.id.localeCompare(b.id));

  for (const correction of ordered) {
    const match = matchModules(groups, correction.members);

    if (match.overlap < threshold) {
      outcomes.push(orphan(correction, match.overlap, threshold));
      continue;
    }

    const current = match.union;
    const stored = new Set(correction.members);
    const currentSet = new Set(current);
    const joined = current.filter((file) => !stored.has(file)).sort();
    const left = [...stored].filter((file) => !currentSet.has(file)).sort();
    const drifted = joined.length > 0 || left.length > 0;

    const unresolved =
      correction.kind === 'split' ? unassignedFiles(current, correction.sides) : [];

    applyMoves(correction, current, overrides, labels);

    outcomes.push({
      correctionId: correction.id,
      kind: correction.kind,
      status: drifted ? 'applied-with-drift' : 'applied',
      overlap: match.overlap,
      // Lowest id of the modules covered, for reporting. Stable by construction.
      moduleId: match.moduleIds[0] ?? null,
      joined,
      left,
      unresolved,
      explanation: explain(correction, match.overlap, joined, left, unresolved, drifted),
    });
  }

  return { overrides, labels, outcomes };
}

interface Match {
  /** Modules holding at least one stored member, lowest id first. */
  readonly moduleIds: readonly string[];
  /** Their combined membership — what the stored set is compared against. */
  readonly union: readonly string[];
  readonly overlap: number;
}

/**
 * Matches against the union of every module that still holds one of the stored
 * members, rather than against a single best module.
 *
 * A merge exists precisely to span several modules, so comparing its stored set
 * to whichever one module matched best would report the other members as having
 * "left" — drift on a correction that is working exactly as intended. The union
 * gives the right answer for all three kinds: for a rename it is normally one
 * module, and for merge and split it is the several the correction covers.
 */
function matchModules(groups: MembershipGroups, members: readonly string[]): Match {
  const stored = new Set(members);
  const moduleIds: string[] = [];
  const union = new Set<string>();

  for (const [moduleId, files] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!files.some((file) => stored.has(file))) {
      continue;
    }
    moduleIds.push(moduleId);
    for (const file of files) {
      union.add(file);
    }
  }

  return {
    moduleIds,
    union: [...union].sort(),
    overlap: jaccardSets(members, union),
  };
}

/**
 * Files in the module that no side claims.
 *
 * These have no correct answer — the user split the module before these files
 * existed, or before they moved here. Guessing a side would be inventing a
 * decision the user never made, so they go to neither and are reported.
 */
function unassignedFiles(current: readonly string[], sides: readonly SplitSide[]): string[] {
  const claimed = new Set(sides.flatMap((side) => side.files));
  return current.filter((file) => !claimed.has(file)).sort();
}

function applyMoves(
  correction: Correction,
  current: readonly string[],
  overrides: Map<string, string>,
  labels: Map<string, string>,
): void {
  if (correction.kind === 'split') {
    correction.sides.forEach((side, index) => {
      const key = `correction:${correction.id}:${index}`;
      labels.set(key, side.label);
      for (const file of side.files) {
        // Only files actually present now — a side may name files since deleted.
        if (current.includes(file)) {
          overrides.set(file, key);
        }
      }
    });

    // Unassigned files are deliberately left where the algorithm put them.
    return;
  }

  // rename and merge both collapse the matched membership into one unit; a
  // rename happens to match exactly one module, a merge spans several.
  const key = `correction:${correction.id}`;
  if (correction.label !== null) {
    labels.set(key, correction.label);
  }
  for (const file of new Set([...current, ...correction.members])) {
    overrides.set(file, key);
  }
}

function orphan(correction: Correction, overlap: number, threshold: number): CorrectionOutcome {
  return {
    correctionId: correction.id,
    kind: correction.kind,
    status: 'orphaned',
    overlap,
    moduleId: null,
    joined: [],
    left: [],
    unresolved: [],
    explanation:
      `No module resembles the ${correction.members.length} files this ${correction.kind} was made against ` +
      `(best overlap ${(overlap * 100).toFixed(0)}%, needs ${(threshold * 100).toFixed(0)}%). ` +
      'Not reapplied — review it and make the correction again if it still makes sense.',
  };
}

function explain(
  correction: Correction,
  overlap: number,
  joined: readonly string[],
  left: readonly string[],
  unresolved: readonly string[],
  drifted: boolean,
): string {
  if (!drifted && unresolved.length === 0) {
    return `Membership is unchanged since this ${correction.kind} was made.`;
  }

  const parts: string[] = [];
  if (drifted) {
    parts.push(
      `Membership changed since this ${correction.kind} was made ` +
        `(${(overlap * 100).toFixed(0)}% overlap): ` +
        `${joined.length} file${joined.length === 1 ? '' : 's'} joined, ` +
        `${left.length} left.`,
    );
  }
  if (unresolved.length > 0) {
    parts.push(
      `${unresolved.length} file${unresolved.length === 1 ? ' is' : 's are'} in neither side of the split ` +
        'and were left unassigned rather than guessed at.',
    );
  }
  return parts.join(' ');
}
