/**
 * Core graph data model. Mirrors docs/ARCHITECTURE.md.
 *
 * Architectural rule 2: every Node and Edge carries `provenance`.
 * Architectural rule 3: every Edge carries non-empty `evidence[]`.
 *
 * Only the Phase 1 subset of the model lives here. Constraints, violations and
 * snapshots arrive with Phase 3 and are deliberately absent.
 */

export type Provenance = 'DERIVED' | 'STATED';

export interface Evidence {
  /** Repo-relative path, forward slashes. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The actual import/call line that produced the edge. */
  readonly snippet: string;
}

export interface Node {
  /** Stable hash of path or module key. */
  readonly id: string;
  readonly kind: 'file' | 'module' | 'service' | 'layer';
  readonly label: string;
  /** Repo-relative paths, forward slashes. */
  readonly files: readonly string[];
  readonly provenance: Provenance;
  /** True if `label` came from a model. */
  readonly llmLabelled: boolean;
  /** True if the user edited this. */
  readonly userCorrected: boolean;
}

export interface Edge {
  readonly id: string;
  /** Node.id */
  readonly from: string;
  /** Node.id */
  readonly to: string;
  readonly kind: 'imports' | 'calls' | 'depends';
  /** REQUIRED — never create an edge without it. */
  readonly evidence: readonly Evidence[];
  /** Number of distinct references. */
  readonly count: number;
  readonly provenance: Provenance;
}
