/**
 * Stage 3a: module clustering.
 *
 * Directory prior plus Louvain community detection over the weighted import
 * graph. Deterministic, and deliberately not tuned.
 *
 * Architectural rule 1: nothing here may reach into llm/. Clustering is
 * mechanical; naming the clusters is Week 6 and is a different module.
 *
 * ## Why the output is stable
 *
 * Louvain is non-deterministic as normally run: it consults a random source and
 * can visit nodes in random order, so the same repository yields different
 * communities each time. Three things pin it down here — a seeded PRNG,
 * `randomWalk: false`, and canonicalisation of the result so cluster identity
 * comes from content (the lexicographically smallest member) rather than from
 * whatever integer the algorithm happened to assign. The first two make the
 * membership stable; the third makes the *ids* stable, which is what any
 * comparison between two runs actually reads.
 *
 * ## How the directory prior and coupling are combined
 *
 * The rule is explicit, and the filesystem does not silently win:
 *
 *   1. Coupling decides. Louvain runs on the import graph and its answer
 *      stands wherever there is coupling to reason about.
 *   2. Where there is no coupling at all — a file with no imports either way —
 *      there is no signal to overrule, so the directory groups it. Left to
 *      itself Louvain makes each such file its own singleton module, which is
 *      noise, not architecture.
 *   3. Clusters below the size threshold merge into whichever neighbour they
 *      are most strongly coupled to.
 *
 * Every file records which of those three applied, so "why is this file here?"
 * always has an answer.
 */
import { posix } from 'node:path';
import { directoryOf, fileEdgeKey } from './aggregate.js';
import { applyCorrections, DEFAULT_MATCH_THRESHOLD } from './corrections.js';
import { detectCommunities } from './louvain.js';
import { createSeededRandom, DEFAULT_CLUSTER_SEED } from './rng.js';
import type { Correction, CorrectionOutcome } from '../types/corrections.js';
import type { DependencyGraph } from './build-graph.js';
import type { Provenance } from '../types/graph.js';
import type {
  ClusterReason,
  ClusteringResult,
  ClusteringSummary,
  Disagreement,
  FileAssignment,
  MergeRecord,
  ModuleEdge,
  ModuleNode,
} from '../types/modules.js';

const DERIVED: Provenance = 'DERIVED';

/**
 * Standard Newman modularity resolution. Higher values split into more, smaller
 * communities; lower values merge them.
 *
 * Kept at the textbook 1.0 on purpose. Modularity is reported as a diagnostic,
 * and tuning the default until that number looks good would be optimising the
 * measurement rather than the grouping — there is no ground truth here to say
 * whether a higher score meant better modules.
 */
export const DEFAULT_RESOLUTION = 1;

/** Clusters smaller than this are absorbed into their nearest neighbour. */
export const DEFAULT_MIN_CLUSTER_SIZE = 3;

export interface ClusterOptions {
  readonly resolution?: number;
  readonly minClusterSize?: number;
  readonly seed?: number;
  /**
   * Stored user corrections, applied after the algorithm finishes and before
   * ids are assigned — so ids stay content-derived, of the corrected content.
   */
  readonly corrections?: readonly Correction[];
  /** Overlap a correction needs to be considered the same module. */
  readonly matchThreshold?: number;
}

export function clusterRepository(
  graph: DependencyGraph,
  options: ClusterOptions = {},
): ClusteringResult {
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const seed = options.seed ?? DEFAULT_CLUSTER_SEED;

  const files = [...graph.graph.nodes()].sort();
  if (files.length === 0) {
    return emptyResult(resolution, seed, minClusterSize);
  }

  const detected = runLouvain(graph, resolution, seed);
  const reasons = new Map<string, ClusterReason>();
  const explanations = new Map<string, string>();

  let membership = applyDirectoryPrior(graph, files, detected.communities, reasons, explanations);
  const merges: MergeRecord[] = [];
  membership = mergeSmallClusters(graph, files, membership, minClusterSize, reasons, explanations, merges);

  // User corrections last, before ids are assigned: they outrank the algorithm,
  // and applying them here keeps ids content-derived of the corrected content.
  const corrected = applyStoredCorrections(
    membership,
    options.corrections ?? [],
    options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD,
    reasons,
    explanations,
  );

  const canonical = canonicalise(files, corrected.membership);
  const correctionLabels = remapCorrectionLabels(corrected.membership, canonical, corrected.labels);
  return assemble({
    graph,
    files,
    canonical,
    reasons,
    explanations,
    merges,
    modularity: detected.modularity,
    resolution,
    seed,
    minClusterSize,
    correctionOutcomes: corrected.outcomes,
    correctionLabels,
  });
}

/**
 * Turns synthetic correction keys into the canonical module ids they became.
 *
 * A correction's label is attached to a key like `correction:ab12`; once
 * canonicalisation has run, that group is `module-004`. The label has to follow.
 */
function remapCorrectionLabels(
  membership: ReadonlyMap<string, string>,
  canonical: ReadonlyMap<string, string>,
  labels: ReadonlyMap<string, string>,
): Record<string, string> {
  const remapped: Record<string, string> = {};

  for (const [syntheticKey, label] of labels) {
    for (const [file, key] of membership) {
      if (key === syntheticKey) {
        const moduleId = canonical.get(file);
        if (moduleId !== undefined) {
          remapped[moduleId] = label;
        }
        break;
      }
    }
  }

  return remapped;
}

/**
 * Rewrites membership according to stored corrections.
 *
 * Every correction reports an outcome whether or not it applied, and drift is
 * flagged rather than swallowed — see graph/corrections.ts.
 */
function applyStoredCorrections(
  membership: Map<string, string>,
  corrections: readonly Correction[],
  threshold: number,
  reasons: Map<string, ClusterReason>,
  explanations: Map<string, string>,
): {
  membership: Map<string, string>;
  outcomes: readonly CorrectionOutcome[];
  labels: ReadonlyMap<string, string>;
} {
  if (corrections.length === 0) {
    return { membership, outcomes: [], labels: new Map() };
  }

  const applied = applyCorrections(groupMembers(membership), corrections, threshold);

  for (const [file, cluster] of applied.overrides) {
    if (!membership.has(file)) {
      continue; // named a file that no longer exists
    }
    membership.set(file, cluster);
    reasons.set(file, 'user-correction');
    explanations.set(file, 'You placed this file in this module by hand.');
  }

  return { membership, outcomes: applied.outcomes, labels: applied.labels };
}

interface Detected {
  readonly communities: Record<string, number>;
  readonly modularity: number;
}

function runLouvain(graph: DependencyGraph, resolution: number, seed: number): Detected {
  const result = detectCommunities(graph.graph, {
    // Import statement counts are the coupling weight: two files that import
    // each other ten times are more coupled than two that do it once.
    getEdgeWeight: 'count',
    resolution,
    // Both of these are what make repeated runs agree.
    rng: createSeededRandom(seed),
    randomWalk: false,
  });

  return { communities: result.communities, modularity: result.modularity };
}

/**
 * Step 2 of the rule. A file with no edges carries no coupling information, so
 * Louvain has nothing to place it by and leaves it alone in its own community.
 * Those files are grouped by directory instead — the only signal available.
 */
function applyDirectoryPrior(
  graph: DependencyGraph,
  files: readonly string[],
  communities: Record<string, number>,
  reasons: Map<string, ClusterReason>,
  explanations: Map<string, string>,
): Map<string, string> {
  const membership = new Map<string, string>();

  for (const file of files) {
    const isolated = graph.graph.degree(file) === 0;

    if (isolated) {
      const directory = directoryOf(file);
      membership.set(file, `dir:${directory}`);
      reasons.set(file, 'directory-prior');
      explanations.set(
        file,
        `No imports in or out, so there is no coupling to group by; placed with the other unconnected files in ${directory}.`,
      );
      continue;
    }

    membership.set(file, `louvain:${communities[file] ?? 0}`);
    reasons.set(file, 'import-coupling');
    explanations.set(file, 'Grouped by import coupling with the other files in this module.');
  }

  return membership;
}

/** Step 3: absorb clusters below the threshold into their strongest neighbour. */
function mergeSmallClusters(
  graph: DependencyGraph,
  files: readonly string[],
  membership: Map<string, string>,
  minClusterSize: number,
  reasons: Map<string, ClusterReason>,
  explanations: Map<string, string>,
  merges: MergeRecord[],
): Map<string, string> {
  const members = groupMembers(membership);
  const small = [...members.entries()]
    .filter(([, group]) => group.length < minClusterSize)
    .sort((a, b) => a[0].localeCompare(b[0]));

  for (const [clusterId, group] of small) {
    // Re-read: an earlier merge in this pass may already have moved it.
    const current = membership.get(group[0] ?? '') ?? clusterId;
    if ((groupMembers(membership).get(current) ?? []).length >= minClusterSize) {
      continue;
    }

    const target = strongestNeighbour(graph, group, membership, current);
    if (target === null) {
      continue;
    }

    for (const file of group) {
      membership.set(file, target.cluster);
      reasons.set(file, 'small-cluster-merge');
      // Compose rather than overwrite: a file that had no coupling and was then
      // merged has two reasons, and "why is this file here?" wants both.
      const prior = explanations.get(file);
      explanations.set(file, prior === undefined ? target.explanation : `${prior} ${target.explanation}`);
    }

    merges.push({
      intoModuleId: target.cluster,
      files: [...group].sort(),
      reason: target.reason,
      explanation: target.explanation,
    });
  }

  void files;
  return membership;
}

interface MergeTarget {
  readonly cluster: string;
  readonly reason: MergeRecord['reason'];
  readonly explanation: string;
}

/**
 * The neighbour cluster this group imports from or is imported by most heavily.
 * Falls back to the directory's dominant cluster when there is no coupling at
 * all, and gives up rather than inventing a home when there is neither.
 */
function strongestNeighbour(
  graph: DependencyGraph,
  group: readonly string[],
  membership: ReadonlyMap<string, string>,
  ownCluster: string,
): MergeTarget | null {
  const weights = new Map<string, number>();
  const owned = new Set(group);

  for (const file of group) {
    graph.graph.forEachEdge(file, (_edge, attributes, source, target) => {
      const other = source === file ? target : source;
      if (owned.has(other)) return;
      const cluster = membership.get(other);
      if (cluster === undefined || cluster === ownCluster) return;
      weights.set(cluster, (weights.get(cluster) ?? 0) + attributes.count);
    });
  }

  const best = [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best !== undefined) {
    return {
      cluster: best[0],
      reason: 'coupling-strength',
      explanation: `Its cluster held fewer than the minimum number of files, so it was merged into the module it is most strongly coupled to (${best[1]} imports).`,
    };
  }

  const directory = directoryOf(group[0] ?? '');
  const sibling = [...membership.entries()]
    .filter(([file, cluster]) => !owned.has(file) && cluster !== ownCluster && directoryOf(file) === directory)
    .map(([, cluster]) => cluster)
    .sort()[0];

  if (sibling !== undefined) {
    return {
      cluster: sibling,
      reason: 'directory-fallback',
      explanation: `Its cluster was below the minimum size and has no imports to any other module, so it was merged with the rest of ${directory}.`,
    };
  }

  return null;
}

function groupMembers(membership: ReadonlyMap<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [file, cluster] of membership) {
    groups.set(cluster, [...(groups.get(cluster) ?? []), file]);
  }
  for (const group of groups.values()) {
    group.sort();
  }
  return groups;
}

/**
 * Replaces algorithm-assigned cluster keys with ids derived from content.
 *
 * Louvain's integer labels depend on internal iteration; two runs with the same
 * membership can still number the communities differently. Ordering clusters by
 * their lexicographically smallest file makes the ids a function of the grouping
 * alone, which is what makes two runs byte-comparable.
 */
function canonicalise(
  files: readonly string[],
  membership: ReadonlyMap<string, string>,
): Map<string, string> {
  const groups = groupMembers(membership);
  const ordered = [...groups.entries()].sort((a, b) => (a[1][0] ?? '').localeCompare(b[1][0] ?? ''));

  const canonical = new Map<string, string>();
  ordered.forEach(([, group], index) => {
    const id = `module-${String(index).padStart(3, '0')}`;
    for (const file of group) {
      canonical.set(file, id);
    }
  });

  for (const file of files) {
    if (!canonical.has(file)) {
      canonical.set(file, 'module-000');
    }
  }
  return canonical;
}

interface AssembleInput {
  readonly graph: DependencyGraph;
  readonly files: readonly string[];
  readonly canonical: ReadonlyMap<string, string>;
  readonly reasons: ReadonlyMap<string, ClusterReason>;
  readonly explanations: ReadonlyMap<string, string>;
  readonly merges: readonly MergeRecord[];
  readonly modularity: number;
  readonly resolution: number;
  readonly seed: number;
  readonly minClusterSize: number;
  readonly correctionOutcomes: readonly CorrectionOutcome[];
  /** Already remapped from synthetic correction keys onto canonical module ids. */
  readonly correctionLabels: Readonly<Record<string, string>>;
}

function assemble(input: AssembleInput): ClusteringResult {
  const groups = groupMembers(input.canonical);

  const modules: ModuleNode[] = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, memberFiles]) => {
      const directories = [...new Set(memberFiles.map(directoryOf))].sort();
      return {
        id,
        kind: 'module' as const,
        label: mechanicalLabel(id, memberFiles),
        files: memberFiles,
        directories,
        provenance: DERIVED,
        llmLabelled: false as const,
        userCorrected: false as const,
      };
    });

  const assignments: FileAssignment[] = input.files.map((file) => ({
    file,
    moduleId: input.canonical.get(file) ?? 'module-000',
    reason: input.reasons.get(file) ?? 'import-coupling',
    explanation: input.explanations.get(file) ?? '',
    directory: directoryOf(file),
  }));

  const edges = buildModuleEdges(input.graph, input.canonical);
  const disagreements = findDisagreements(modules, assignments);

  return {
    modules,
    edges,
    assignments,
    disagreements,
    merges: input.merges,
    summary: summarise(input, modules, assignments, disagreements),
    correctionOutcomes: input.correctionOutcomes,
    correctionLabels: input.correctionLabels,
  };
}

/**
 * Mechanical label: the deepest path prefix shared by every file in the module,
 * or the id when they share nothing. Derived from paths, never from meaning.
 */
function mechanicalLabel(id: string, files: readonly string[]): string {
  const first = files[0];
  if (first === undefined) {
    return id;
  }

  let prefix = posix.dirname(first).split('/');
  for (const file of files.slice(1)) {
    const parts = posix.dirname(file).split('/');
    let shared = 0;
    while (shared < prefix.length && shared < parts.length && prefix[shared] === parts[shared]) {
      shared += 1;
    }
    prefix = prefix.slice(0, shared);
    if (prefix.length === 0) break;
  }

  const joined = prefix.join('/');
  return joined === '' || joined === '.' ? id : `${joined}/`;
}

function buildModuleEdges(graph: DependencyGraph, canonical: ReadonlyMap<string, string>): ModuleEdge[] {
  const accumulators = new Map<string, { weight: number; importCount: number; fileEdges: string[] }>();

  graph.graph.forEachEdge((_edge, attributes, source, target) => {
    const from = canonical.get(source);
    const to = canonical.get(target);
    if (from === undefined || to === undefined || from === to) {
      return;
    }
    const key = `${from} ${to}`;
    const entry = accumulators.get(key) ?? { weight: 0, importCount: 0, fileEdges: [] };
    entry.weight += 1;
    entry.importCount += attributes.count;
    entry.fileEdges.push(fileEdgeKey(source, target));
    accumulators.set(key, entry);
  });

  return [...accumulators.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, entry]) => {
      const [from = '', to = ''] = key.split(' ');
      return {
        id: `${from}->${to}`,
        from,
        to,
        weight: entry.weight,
        importCount: entry.importCount,
        fileEdges: entry.fileEdges.sort(),
        provenance: DERIVED,
      };
    });
}

/** A file disagrees when its module is mostly made of some other directory. */
function findDisagreements(
  modules: readonly ModuleNode[],
  assignments: readonly FileAssignment[],
): Disagreement[] {
  const plurality = new Map<string, string>();
  for (const module of modules) {
    plurality.set(module.id, pluralityDirectory(module.files));
  }

  return assignments
    .filter((assignment) => (plurality.get(assignment.moduleId) ?? '') !== assignment.directory)
    .map((assignment) => ({
      file: assignment.file,
      directory: assignment.directory,
      moduleId: assignment.moduleId,
      modulePluralityDirectory: plurality.get(assignment.moduleId) ?? '',
    }));
}

function pluralityDirectory(files: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const directory = directoryOf(file);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

function summarise(
  input: AssembleInput,
  modules: readonly ModuleNode[],
  assignments: readonly FileAssignment[],
  disagreements: readonly Disagreement[],
): ClusteringSummary {
  const byReason: Record<ClusterReason, number> = {
    'import-coupling': 0,
    'directory-prior': 0,
    'small-cluster-merge': 0,
    'user-correction': 0,
  };
  for (const assignment of assignments) {
    byReason[assignment.reason] += 1;
  }

  const directoryModules = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    const set = directoryModules.get(assignment.directory) ?? new Set<string>();
    set.add(assignment.moduleId);
    directoryModules.set(assignment.directory, set);
  }

  return {
    moduleCount: modules.length,
    modularity: input.modularity,
    resolution: input.resolution,
    seed: input.seed,
    minClusterSize: input.minClusterSize,
    mergedClusters: input.merges.length,
    disagreementRate: assignments.length === 0 ? 0 : (disagreements.length / assignments.length) * 100,
    crossDirectoryModules: modules.filter((module) => module.directories.length > 1).length,
    splitDirectories: [...directoryModules.values()].filter((set) => set.size > 1).length,
    byReason,
  };
}

function emptyResult(resolution: number, seed: number, minClusterSize: number): ClusteringResult {
  return {
    modules: [],
    edges: [],
    assignments: [],
    disagreements: [],
    merges: [],
    summary: {
      moduleCount: 0,
      modularity: 0,
      resolution,
      seed,
      minClusterSize,
      mergedClusters: 0,
      disagreementRate: 0,
      crossDirectoryModules: 0,
      splitDirectories: 0,
      byReason: {
        'import-coupling': 0,
        'directory-prior': 0,
        'small-cluster-merge': 0,
        'user-correction': 0,
      },
    },
    correctionOutcomes: [],
    correctionLabels: {},
  };
}
