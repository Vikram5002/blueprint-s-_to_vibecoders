/**
 * Attaches labels to an already-final clustering.
 *
 * This is the only place in the codebase where deterministic output and model
 * output meet, and the meeting is one-way: the clustering goes in and comes out
 * untouched, and a separate table of labels comes back alongside it.
 *
 * The no-key path is the primary path, not a fallback. With nothing configured,
 * every module gets its mechanical name and the run is complete — quietly. A
 * user who never sets an API key should not be nagged about it on every run.
 */
import type { ClusteringResult } from '../types/modules.js';
import type { LabelSet, LabellingSummary, ModuleLabel } from '../types/labels.js';

export interface LabelOptions {
  /**
   * Supplies model-derived names. Omit to run mechanically.
   * Injected rather than imported so this module stays testable without a
   * network, and so `llm/` is only reachable from the composition root.
   */
  readonly labeller?: ModuleLabeller;
  /** Names the user has already corrected, keyed by module id. */
  readonly corrections?: ReadonlyMap<string, string>;
}

export interface LabelRequest {
  readonly moduleId: string;
  readonly mechanicalLabel: string;
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

export interface LabelOutcome {
  readonly moduleId: string;
  readonly label: string;
  readonly description: string | null;
}

export interface LabellerResult {
  readonly outcomes: readonly LabelOutcome[];
  readonly summary: Pick<
    LabellingSummary,
    'cacheHits' | 'cacheMisses' | 'usage' | 'provider' | 'failures'
  >;
}

export interface ModuleLabeller {
  label(requests: readonly LabelRequest[]): Promise<LabellerResult>;
}

const NO_USAGE = { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 } as const;

export async function labelModules(
  clustering: ClusteringResult,
  options: LabelOptions = {},
): Promise<LabelSet> {
  const corrections = options.corrections ?? new Map<string, string>();

  // Mechanical first, always. Every module has a name before a model is asked
  // anything, so a failure part-way through degrades to a complete result.
  const labels = new Map<string, ModuleLabel>(
    clustering.modules.map((module) => [
      module.id,
      {
        moduleId: module.id,
        label: module.label,
        description: null,
        source: 'mechanical' as const,
        mechanicalLabel: module.label,
      },
    ]),
  );

  if (options.labeller === undefined) {
    return { labels, summary: applyCorrections(labels, corrections, degradedSummary(labels.size)) };
  }

  // A module the user has already named is not worth paying to name again.
  const requests: LabelRequest[] = clustering.modules
    .filter((module) => !corrections.has(module.id))
    .map((module) => ({
      moduleId: module.id,
      mechanicalLabel: module.label,
      files: module.files,
      directories: module.directories,
    }));

  const result = await options.labeller.label(requests);

  for (const outcome of result.outcomes) {
    const existing = labels.get(outcome.moduleId);
    if (existing === undefined) {
      continue; // a module id we did not ask about; ignore rather than trust it
    }
    labels.set(outcome.moduleId, {
      ...existing,
      label: outcome.label,
      description: outcome.description,
      source: 'llm',
    });
  }

  const summary: LabellingSummary = {
    candidates: requests.length,
    mechanical: 0,
    llmLabelled: 0,
    userCorrected: 0,
    cacheHits: result.summary.cacheHits,
    cacheMisses: result.summary.cacheMisses,
    usage: result.summary.usage,
    provider: result.summary.provider,
    degraded: false,
    failures: result.summary.failures,
  };

  return { labels, summary: applyCorrections(labels, corrections, summary) };
}

/**
 * User corrections outrank everything. Applied last so a rename survives both
 * the mechanical name and whatever the model said.
 */
function applyCorrections(
  labels: Map<string, ModuleLabel>,
  corrections: ReadonlyMap<string, string>,
  summary: LabellingSummary,
): LabellingSummary {
  for (const [moduleId, corrected] of corrections) {
    const existing = labels.get(moduleId);
    if (existing === undefined) {
      continue;
    }
    labels.set(moduleId, { ...existing, label: corrected, source: 'user' });
  }

  return { ...summary, ...countSources(labels) };
}

function countSources(labels: ReadonlyMap<string, ModuleLabel>): Pick<
  LabellingSummary,
  'mechanical' | 'llmLabelled' | 'userCorrected'
> {
  let mechanical = 0;
  let llmLabelled = 0;
  let userCorrected = 0;

  for (const label of labels.values()) {
    if (label.source === 'user') userCorrected += 1;
    else if (label.source === 'llm') llmLabelled += 1;
    else mechanical += 1;
  }

  return { mechanical, llmLabelled, userCorrected };
}

function degradedSummary(candidates: number): LabellingSummary {
  return {
    candidates,
    mechanical: candidates,
    llmLabelled: 0,
    userCorrected: 0,
    cacheHits: 0,
    cacheMisses: 0,
    usage: NO_USAGE,
    provider: null,
    degraded: true,
    failures: [],
  };
}
