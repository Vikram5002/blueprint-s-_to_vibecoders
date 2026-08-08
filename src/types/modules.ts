/**
 * Module clustering data model.
 *
 * Rule 2 still applies: module nodes and edges are DERIVED. Clustering is
 * computed from real import edges by a deterministic algorithm — nothing here
 * is claimed, inferred by a model, or supplied by a user.
 *
 * Labels are mechanical only this week: a shared path prefix or an index.
 * Semantic naming is Week 6 and needs an LLM, which graph/ may not touch.
 */
import type { Provenance } from './graph.js';

export type ClusterReason =
  /** Import coupling put it here — Louvain's own decision. */
  | 'import-coupling'
  /** No coupling to go on, so the filesystem decided. */
  | 'directory-prior'
  /** Its cluster was below the size threshold and was merged. */
  | 'small-cluster-merge';

export interface FileAssignment {
  readonly file: string;
  readonly moduleId: string;
  readonly reason: ClusterReason;
  /** Plain-language answer to "why is this file in this module?". */
  readonly explanation: string;
  /** Directory the file actually lives in, for comparison with the module. */
  readonly directory: string;
}

export interface ModuleNode {
  readonly id: string;
  readonly kind: 'module';
  /** Mechanical: the shared path prefix of its files, or the id. Never semantic. */
  readonly label: string;
  readonly files: readonly string[];
  /** Distinct directories the files come from, sorted. */
  readonly directories: readonly string[];
  readonly provenance: Provenance;
  readonly llmLabelled: false;
  readonly userCorrected: false;
}

export interface ModuleEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Distinct file-to-file edges collapsed into this one. */
  readonly weight: number;
  readonly importCount: number;
  /** Underlying file edges, so evidence stays reachable at module level (rule 3). */
  readonly fileEdges: readonly string[];
  readonly provenance: Provenance;
}

export interface MergeRecord {
  /** Canonical id the merged cluster ended up in. */
  readonly intoModuleId: string;
  readonly files: readonly string[];
  readonly reason: 'coupling-strength' | 'directory-fallback' | 'no-neighbour';
  readonly explanation: string;
}

/**
 * A file whose module disagrees with the filesystem.
 *
 * This is the interesting output, not an error. "These files live in three
 * folders but are one coupled unit" is precisely what a file tree cannot show.
 */
export interface Disagreement {
  readonly file: string;
  readonly directory: string;
  readonly moduleId: string;
  /** Directory most of the module's files come from. */
  readonly modulePluralityDirectory: string;
}

export interface ClusteringSummary {
  readonly moduleCount: number;
  /** Newman modularity of the final partition. Diagnostic only — see docs. */
  readonly modularity: number;
  readonly resolution: number;
  readonly seed: number;
  readonly minClusterSize: number;
  readonly mergedClusters: number;
  /** Percentage of files whose module differs from their directory grouping. */
  readonly disagreementRate: number;
  /** Modules whose files come from more than one directory. */
  readonly crossDirectoryModules: number;
  /** Directories whose files ended up in more than one module. */
  readonly splitDirectories: number;
  readonly byReason: Readonly<Record<ClusterReason, number>>;
}

export interface ClusteringResult {
  readonly modules: readonly ModuleNode[];
  readonly edges: readonly ModuleEdge[];
  readonly assignments: readonly FileAssignment[];
  readonly disagreements: readonly Disagreement[];
  readonly merges: readonly MergeRecord[];
  readonly summary: ClusteringSummary;
}
