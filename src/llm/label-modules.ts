/**
 * The ModuleLabeller the pipeline consumes, assembled from provider, cache,
 * prompt and validation.
 *
 * Order of operations per cluster: build the prompt, hash it, answer from cache
 * if possible, otherwise ask the provider and validate what comes back. A
 * cluster that fails at any step keeps its mechanical name and is recorded as a
 * failure — labelling never breaks a run.
 */
import { buildUserPrompt, SYSTEM_PROMPT, type ClusterSnippet } from './prompt.js';
import { cacheKey, type LabelCache } from './cache.js';
import { parseLabelResponse } from './validate.js';
import { estimateCostUsd } from './pricing.js';
import { LABEL_SCHEMA } from './anthropic.js';
import type { CompletionProvider } from './provider.js';
import type { LabellerResult, LabelOutcome, LabelRequest, ModuleLabeller } from '../pipeline/label.js';

const MAX_OUTPUT_TOKENS = 256;
const SCHEMA_FINGERPRINT = JSON.stringify(LABEL_SCHEMA);

export interface ClusterEvidence {
  /** Most-used exported symbols for a module, longest-first. */
  readonly symbols: (moduleId: string) => readonly string[];
  /** Two or three short representative snippets. Never whole files. */
  readonly snippets: (moduleId: string) => readonly ClusterSnippet[];
}

export interface CachedLabellerOptions {
  readonly provider: CompletionProvider;
  readonly cache: LabelCache;
  readonly evidence: ClusterEvidence;
  /** Sent only to providers that accept it; see anthropic.ts. */
  readonly temperature?: number;
  readonly onProgress?: (done: number, total: number, moduleId: string) => void;
}

export function createCachedLabeller(options: CachedLabellerOptions): ModuleLabeller {
  return {
    label: async (requests: readonly LabelRequest[]): Promise<LabellerResult> => {
      const outcomes: LabelOutcome[] = [];
      const failures: { moduleId: string; reason: string }[] = [];
      let cacheHits = 0;
      let cacheMisses = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let estimatedCostUsd = 0;

      for (const [index, request] of requests.entries()) {
        const user = buildUserPrompt({
          request,
          symbols: options.evidence.symbols(request.moduleId),
          snippets: options.evidence.snippets(request.moduleId),
        });

        const key = cacheKey({
          model: options.provider.model,
          system: SYSTEM_PROMPT,
          user,
          schema: SCHEMA_FINGERPRINT,
        });

        const cached = options.cache.get(key);
        if (cached !== undefined) {
          cacheHits += 1;
          outcomes.push({
            moduleId: request.moduleId,
            label: cached.label,
            description: cached.description,
          });
          options.onProgress?.(index + 1, requests.length, request.moduleId);
          continue;
        }

        cacheMisses += 1;
        const completion = await options.provider.complete({
          system: SYSTEM_PROMPT,
          user,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        });

        if (!completion.ok) {
          failures.push({ moduleId: request.moduleId, reason: completion.error.message });
          options.onProgress?.(index + 1, requests.length, request.moduleId);
          continue;
        }

        // Billed whether or not the answer survives validation.
        promptTokens += completion.value.usage.promptTokens;
        completionTokens += completion.value.usage.completionTokens;
        estimatedCostUsd += estimateCostUsd(
          completion.value.model,
          completion.value.usage.promptTokens,
          completion.value.usage.completionTokens,
        );

        const validated = parseLabelResponse(completion.value.text);
        if (!validated.ok) {
          failures.push({ moduleId: request.moduleId, reason: `rejected label: ${validated.reason}` });
          options.onProgress?.(index + 1, requests.length, request.moduleId);
          continue;
        }

        // Only validated answers are cached — never store something we refused.
        options.cache.set(key, {
          label: validated.value.label,
          description: validated.value.description,
          model: completion.value.model,
          promptTokens: completion.value.usage.promptTokens,
          completionTokens: completion.value.usage.completionTokens,
          createdAt: new Date().toISOString(),
        });

        outcomes.push({
          moduleId: request.moduleId,
          label: validated.value.label,
          description: validated.value.description,
        });
        options.onProgress?.(index + 1, requests.length, request.moduleId);
      }

      return {
        outcomes,
        summary: {
          cacheHits,
          cacheMisses,
          usage: { promptTokens, completionTokens, estimatedCostUsd },
          provider: options.provider.name,
          failures,
        },
      };
    },
  };
}
