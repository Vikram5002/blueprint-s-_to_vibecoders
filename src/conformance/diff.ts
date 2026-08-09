/**
 * Semantic diff between two snapshots.
 *
 * Compares architecture, not text: modules, edges, constraints and violations.
 * A commit that reformats every file produces an empty diff here, and a commit
 * that moves one import produces exactly one entry — which is the whole point.
 *
 * Deterministic. Every list is sorted, every threshold is a constant, and
 * nothing depends on map iteration order.
 */
import { jaccardSets } from '../graph/partition.js';
import type {
  Snapshot,
  SnapshotConstraint,
  SnapshotEdge,
  SnapshotModule,
  SnapshotViolation,
} from '../types/snapshots.js';

/**
 * Above this, two modules with different ids are the *same module renamed*.
 *
 * ## Why this threshold exists at all
 *
 * Cluster ids are content-derived, so adding one file to a module changes its
 * id. Without an overlap test every commit that touches a module would read as
 * "module deleted, different module created", and a diff would be almost
 * entirely phantom churn.
 *
 * ## Why 0.6, and why the number matters less than it looks
 *
 * Same value as the correction-matching threshold in Week 6, and for the same
 * reason: a module can grow by two thirds or lose 40% of its files and still be
 * recognisably itself. Reusing one number across the project means a user
 * learns one rule, and the two are genuinely the same question — "is this still
 * the thing I was looking at?"
 *
 * The measured stability data is what makes the exact value uncritical here.
 * Adjacent commits on this repository produce **identical** clusterings — ARI
 * 1.000 across 25 consecutive steps — so in practice overlaps land at 1.0 or
 * near 0, and almost nothing sits near the boundary. The threshold is a
 * safeguard for the rare genuine reshuffle, not a dial that decides most
 * outcomes. See docs/CLUSTERING.md.
 *
 * Below it, the two modules are reported as a removal and an addition, which is
 * the honest description of a real restructure.
 */
export const RENAME_OVERLAP_THRESHOLD = 0.6;

/**
 * A rename with membership movement is still a rename, but it is reported with
 * the files that moved — the same "never reapply silently" rule Week 6 applies
 * to corrections.
 */
export const IDENTICAL_OVERLAP = 0.999;

export type DiffKind =
  | 'module-added'
  | 'module-removed'
  | 'module-renamed'
  | 'module-restructured'
  | 'edge-added'
  | 'edge-removed'
  | 'edge-weight-changed'
  | 'constraint-added'
  | 'constraint-removed'
  | 'violation-appeared'
  | 'violation-resolved';

/** How much a single entry moved the drift score. */
export interface DriftContribution {
  readonly weightBefore: number;
  readonly weightAfter: number;
}

export interface DiffEntry {
  readonly kind: DiffKind;
  /** Stable within a diff: sorted on this. */
  readonly key: string;
  /** Plain language, no ids, readable without knowing the schema. */
  readonly description: string;
  /**
   * What backs the claim. For edges, the import statement; for modules, the
   * files that moved; for constraints, the sentence and its location.
   */
  readonly evidence: readonly string[];
  /** Present only for entries that changed the drift score. */
  readonly drift?: DriftContribution;
}

export interface DiffSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<DiffKind, number>>;
  /** True when both snapshots ran under the same corrections. */
  readonly comparable: boolean;
  readonly comparabilityNote: string;
  readonly driftBefore: number;
  readonly driftAfter: number;
  readonly driftDelta: number;
}

export interface SnapshotDiff {
  readonly from: { readonly commit: string; readonly subject: string };
  readonly to: { readonly commit: string; readonly subject: string };
  readonly entries: readonly DiffEntry[];
  readonly summary: DiffSummary;
}

export function diffSnapshots(from: Snapshot, to: Snapshot): SnapshotDiff {
  const entries: DiffEntry[] = [
    ...diffModules(from.modules, to.modules),
    ...diffEdges(from.edges, to.edges),
    ...diffConstraints(from.constraints, to.constraints),
    ...diffViolations(from, to),
  ];

  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));

  return {
    from: { commit: from.commit, subject: from.subject },
    to: { commit: to.commit, subject: to.subject },
    entries,
    summary: summarise(from, to, entries),
  };
}

// ---------------------------------------------------------------- modules

interface Match {
  readonly before: SnapshotModule;
  readonly after: SnapshotModule;
  readonly overlap: number;
}

/**
 * Pairs modules across snapshots by file overlap.
 *
 * Greedy on the best available overlap rather than optimal assignment: with the
 * measured stability (adjacent clusterings identical), the two agree in every
 * real case, and greedy is inspectable where the Hungarian algorithm is not.
 * Ties break on module id so the pairing never depends on ordering.
 */
function pairModules(before: readonly SnapshotModule[], after: readonly SnapshotModule[]): {
  matches: Match[];
  unmatchedBefore: SnapshotModule[];
  unmatchedAfter: SnapshotModule[];
} {
  const candidates: Match[] = [];
  for (const a of before) {
    for (const b of after) {
      const overlap = jaccardSets(a.files, b.files);
      if (overlap >= RENAME_OVERLAP_THRESHOLD) candidates.push({ before: a, after: b, overlap });
    }
  }

  candidates.sort(
    (x, y) =>
      y.overlap - x.overlap ||
      x.before.id.localeCompare(y.before.id) ||
      x.after.id.localeCompare(y.after.id),
  );

  const usedBefore = new Set<string>();
  const usedAfter = new Set<string>();
  const matches: Match[] = [];

  for (const candidate of candidates) {
    if (usedBefore.has(candidate.before.id) || usedAfter.has(candidate.after.id)) continue;
    usedBefore.add(candidate.before.id);
    usedAfter.add(candidate.after.id);
    matches.push(candidate);
  }

  return {
    matches,
    unmatchedBefore: before.filter((module) => !usedBefore.has(module.id)),
    unmatchedAfter: after.filter((module) => !usedAfter.has(module.id)),
  };
}

function diffModules(before: readonly SnapshotModule[], after: readonly SnapshotModule[]): DiffEntry[] {
  const { matches, unmatchedBefore, unmatchedAfter } = pairModules(before, after);
  const entries: DiffEntry[] = [];

  for (const match of matches) {
    if (match.overlap >= IDENTICAL_OVERLAP && match.before.label === match.after.label) continue;

    const gained = match.after.files.filter((file) => !match.before.files.includes(file));
    const lost = match.before.files.filter((file) => !match.after.files.includes(file));

    if (gained.length === 0 && lost.length === 0) {
      // Same files, different name. The only thing that changed is the label.
      entries.push({
        kind: 'module-renamed',
        key: match.after.id,
        description: `Module "${match.before.label}" is now called "${match.after.label}". Its files did not change.`,
        evidence: [`${match.before.files.length} file(s), identical membership`],
      });
      continue;
    }

    entries.push({
      kind: 'module-renamed',
      key: match.after.id,
      description:
        `Module "${match.after.label}" is the same module as "${match.before.label}" ` +
        `(${(match.overlap * 100).toFixed(0)}% of its files are shared), ` +
        `but ${gained.length} file(s) joined and ${lost.length} left.`,
      evidence: [
        ...gained.slice(0, 5).map((file) => `+ ${file}`),
        ...lost.slice(0, 5).map((file) => `- ${file}`),
      ],
    });
  }

  /**
   * An unmatched pair is a restructure, not a rename.
   *
   * Reported as its own kind rather than as an add plus a remove, because "this
   * module was broken up" is a different architectural event from "a new module
   * appeared", and a reader scanning a diff should not have to infer it by
   * noticing two entries next to each other.
   */
  for (const module of unmatchedBefore) {
    const bestAfter = after
      .map((candidate) => ({ candidate, overlap: jaccardSets(module.files, candidate.files) }))
      .sort((x, y) => y.overlap - x.overlap || x.candidate.id.localeCompare(y.candidate.id))[0];

    if (bestAfter !== undefined && bestAfter.overlap > 0) {
      entries.push({
        kind: 'module-restructured',
        key: module.id,
        description:
          `Module "${module.label}" no longer exists as a unit. Its closest survivor, ` +
          `"${bestAfter.candidate.label}", shares only ${(bestAfter.overlap * 100).toFixed(0)}% ` +
          `of its files — below the ${(RENAME_OVERLAP_THRESHOLD * 100).toFixed(0)}% needed to call it the same module.`,
        evidence: module.files.slice(0, 5).map((file) => `was: ${file}`),
      });
      continue;
    }

    entries.push({
      kind: 'module-removed',
      key: module.id,
      description: `Module "${module.label}" is gone, along with all ${module.files.length} of its files.`,
      evidence: module.files.slice(0, 5).map((file) => `was: ${file}`),
    });
  }

  for (const module of unmatchedAfter) {
    entries.push({
      kind: 'module-added',
      key: module.id,
      description: `New module "${module.label}", containing ${module.files.length} file(s).`,
      evidence: module.files.slice(0, 5).map((file) => `now: ${file}`),
    });
  }

  return entries;
}

// ---------------------------------------------------------------- edges

function diffEdges(before: readonly SnapshotEdge[], after: readonly SnapshotEdge[]): DiffEntry[] {
  const beforeById = new Map(before.map((edge) => [edge.id, edge]));
  const afterById = new Map(after.map((edge) => [edge.id, edge]));
  const entries: DiffEntry[] = [];

  for (const edge of after) {
    const previous = beforeById.get(edge.id);
    if (previous === undefined) {
      entries.push({
        kind: 'edge-added',
        key: edge.id,
        description: `${edge.from} now imports ${edge.to}.`,
        evidence: [`${edge.importCount} import statement(s)`],
      });
      continue;
    }
    if (previous.importCount !== edge.importCount) {
      const direction = edge.importCount > previous.importCount ? 'more' : 'fewer';
      entries.push({
        kind: 'edge-weight-changed',
        key: edge.id,
        description:
          `${edge.from} imports ${edge.to} through ${edge.importCount} statement(s), ` +
          `${direction} than the ${previous.importCount} before.`,
        evidence: [`${previous.importCount} -> ${edge.importCount}`],
      });
    }
  }

  for (const edge of before) {
    if (afterById.has(edge.id)) continue;
    entries.push({
      kind: 'edge-removed',
      key: edge.id,
      description: `${edge.from} no longer imports ${edge.to}.`,
      evidence: [`was ${edge.importCount} import statement(s)`],
    });
  }

  return entries;
}

// ---------------------------------------------------------------- constraints

function diffConstraints(
  before: readonly SnapshotConstraint[],
  after: readonly SnapshotConstraint[],
): DiffEntry[] {
  const beforeIds = new Set(before.map((constraint) => constraint.id));
  const afterIds = new Set(after.map((constraint) => constraint.id));
  const entries: DiffEntry[] = [];

  for (const constraint of after) {
    if (beforeIds.has(constraint.id)) continue;
    entries.push({
      kind: 'constraint-added',
      key: constraint.id,
      description: `The documentation now states a rule: ${constraint.subject} ${spellOut(constraint.relation)} ${constraint.object}.`,
      evidence: [`"${constraint.rawText}"`, constraint.source],
    });
  }

  for (const constraint of before) {
    if (afterIds.has(constraint.id)) continue;
    entries.push({
      kind: 'constraint-removed',
      key: constraint.id,
      description:
        `The documentation no longer states: ${constraint.subject} ${spellOut(constraint.relation)} ${constraint.object}. ` +
        `The rule was dropped, reworded, or its source file changed.`,
      evidence: [`was: "${constraint.rawText}"`, `was in ${constraint.source}`],
    });
  }

  return entries;
}

function spellOut(relation: string): string {
  switch (relation) {
    case 'must-not-import':
      return 'must not import';
    case 'may-only-import-via':
      return 'may only import';
    case 'must-not-cycle':
      return 'must not cycle within';
    case 'must-be-layer-above':
      return 'must sit above';
    default:
      return relation;
  }
}

// ---------------------------------------------------------------- violations

function diffViolations(from: Snapshot, to: Snapshot): DiffEntry[] {
  const beforeById = new Map(from.violations.map((violation) => [violation.id, violation]));
  const afterById = new Map(to.violations.map((violation) => [violation.id, violation]));
  const entries: DiffEntry[] = [];

  const weightOf = (violation: SnapshotViolation): number =>
    violation.severity === 'high' ? 3 : violation.severity === 'medium' ? 2 : 1;

  for (const violation of to.violations) {
    if (beforeById.has(violation.id)) continue;
    entries.push({
      kind: 'violation-appeared',
      key: violation.id,
      description: `A stated rule is now broken: ${violation.explanation}`,
      evidence: violation.edgeIds.slice(0, 5),
      drift: { weightBefore: 0, weightAfter: weightOf(violation) },
    });
  }

  for (const violation of from.violations) {
    if (afterById.has(violation.id)) continue;
    entries.push({
      kind: 'violation-resolved',
      key: violation.id,
      description: `A rule that was broken now holds: ${violation.explanation}`,
      evidence: violation.edgeIds.slice(0, 5),
      drift: { weightBefore: weightOf(violation), weightAfter: 0 },
    });
  }

  return entries;
}

// ---------------------------------------------------------------- summary

function summarise(from: Snapshot, to: Snapshot, entries: readonly DiffEntry[]): DiffSummary {
  const byKind = {
    'module-added': 0,
    'module-removed': 0,
    'module-renamed': 0,
    'module-restructured': 0,
    'edge-added': 0,
    'edge-removed': 0,
    'edge-weight-changed': 0,
    'constraint-added': 0,
    'constraint-removed': 0,
    'violation-appeared': 0,
    'violation-resolved': 0,
  } satisfies Record<DiffKind, number>;

  for (const entry of entries) byKind[entry.kind] += 1;

  /**
   * Two snapshots taken under different corrections are not comparable.
   *
   * A user renaming a module by hand between the two commits produces a
   * `module-renamed` entry that describes an edit to the documentation of the
   * architecture, not a change to the architecture. Rather than filter those
   * out — which would hide a real difference — the diff is flagged, and the
   * reader is told which way to read it.
   */
  const sameCorrections =
    from.activeCorrections.length === to.activeCorrections.length &&
    from.activeCorrections.every((id, index) => id === to.activeCorrections[index]);

  return {
    total: entries.length,
    byKind,
    comparable: sameCorrections,
    comparabilityNote: sameCorrections
      ? 'Both snapshots ran under the same user corrections.'
      : `Corrections differ between these snapshots (${from.activeCorrections.length} then, ` +
        `${to.activeCorrections.length} now). Some module changes below may be edits a person made, ` +
        'not changes the code underwent.',
    driftBefore: from.drift.score,
    driftAfter: to.drift.score,
    driftDelta: Number((to.drift.score - from.drift.score).toFixed(4)),
  };
}
