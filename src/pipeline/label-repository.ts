/**
 * Composition root for labelling.
 *
 * The one place that decides whether a model is consulted at all: it reads the
 * key, builds a provider if there is one, wires the cache and the evidence, and
 * hands `labelModules` a labeller — or nothing, in which case every module keeps
 * its mechanical name.
 *
 * Rule 1 holds because this file, not `graph/`, is what imports `llm/`. The
 * clustering is finished before anything here runs, and is passed through
 * untouched.
 */
import { labelModules } from './label.js';
import { buildClusterEvidence } from './evidence.js';
import { loadLabelCache } from '../llm/cache.js';
import { chooseProvider, createProvider } from '../llm/select-provider.js';
import { createCachedLabeller } from '../llm/label-modules.js';
import type { ClusteringResult } from '../types/modules.js';
import type { LabelSet } from '../types/labels.js';
import type { ParsedFile } from '../types/symbols.js';

/**
 * Re-exported so callers keep one import site. Provider and model are both
 * resolved in `llm/select-provider.ts`; see docs/PROVIDERS.md.
 */
export { MODEL_ENV, PROVIDER_ENV } from '../llm/select-provider.js';

export interface LabelRepositoryOptions {
  readonly root: string;
  readonly clustering: ClusteringResult;
  readonly files: readonly ParsedFile[];
  /** Names the user has already corrected. Never re-sent to a model. */
  readonly corrections?: ReadonlyMap<string, string>;
  /** Set false to force the mechanical path even when a key is present. */
  readonly useModel?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (done: number, total: number, moduleId: string) => void;
}

export async function labelRepository(options: LabelRepositoryOptions): Promise<LabelSet> {
  const env = options.env ?? process.env;
  const choice = chooseProvider(env);
  const provider = options.useModel === false ? null : await createProvider(choice);

  if (provider === null) {
    // No key, or explicitly disabled. Mechanical names, no warning, no cost.
    return labelModules(options.clustering, {
      ...(options.corrections === undefined ? {} : { corrections: options.corrections }),
    });
  }

  const cache = await loadLabelCache(options.root);

  const labeller = createCachedLabeller({
    provider,
    cache,
    evidence: buildClusterEvidence(options.files, options.clustering),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  const labels = await labelModules(options.clustering, {
    labeller,
    ...(options.corrections === undefined ? {} : { corrections: options.corrections }),
  });

  // Written even on a partial run, so work already paid for is not paid for twice.
  await cache.flush();
  return labels;
}
