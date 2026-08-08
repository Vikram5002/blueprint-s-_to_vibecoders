/**
 * Module labels.
 *
 * ## Labels are cosmetic
 *
 * Week 5 made clustering byte-identical across runs. Model output is not
 * deterministic, and that must not leak backwards into the structure.
 *
 * The defence is structural rather than disciplinary: labels live in a side
 * table keyed by module id, and `ClusteringResult` is never touched. Cluster
 * identity stays content-derived — the lexicographically smallest member, as
 * built in Week 5 — so nothing downstream can key off a label even by accident.
 * Diffing, conformance, drift, cache keys and URLs all address modules by id.
 *
 * If a label changes, nothing else changes. `src/pipeline/label.test.ts`
 * asserts exactly that by running with labelling on and off and comparing the
 * clustering byte for byte.
 */

export type LabelSource =
  /** Derived from paths: a shared prefix, or the module index. */
  | 'mechanical'
  /** Named by a model. Must be visually distinct in the UI (rule 2). */
  | 'llm'
  /** Renamed by the user. Outranks both of the above. */
  | 'user';

export interface ModuleLabel {
  readonly moduleId: string;
  /** What to show. */
  readonly label: string;
  /** One line, when a model supplied one. */
  readonly description: string | null;
  readonly source: LabelSource;
  /**
   * The deterministic name, always kept. Lets the UI show what the mechanical
   * answer would have been, and gives every module a name if labelling is
   * removed or fails.
   */
  readonly mechanicalLabel: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedCostUsd: number;
}

export interface LabellingSummary {
  /** Modules that were candidates for a model-supplied name. */
  readonly candidates: number;
  readonly mechanical: number;
  readonly llmLabelled: number;
  readonly userCorrected: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly usage: TokenUsage;
  /** Provider actually used, or null when running without a key. */
  readonly provider: string | null;
  /**
   * True when no API key was configured. Not an error: the tool runs fully and
   * shows mechanical names, which CLAUDE.md requires the deterministic half to
   * be independently useful.
   */
  readonly degraded: boolean;
  /** Modules the model failed or refused to name, with the reason. */
  readonly failures: readonly { moduleId: string; reason: string }[];
}

export interface LabelSet {
  /** Keyed by module id. Every module in the clustering has an entry. */
  readonly labels: ReadonlyMap<string, ModuleLabel>;
  readonly summary: LabellingSummary;
}
