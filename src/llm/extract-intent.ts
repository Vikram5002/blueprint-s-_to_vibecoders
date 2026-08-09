/**
 * The intent extractor: one document in, raw candidates out.
 *
 * This module is deliberately incurious about whether the candidates are any
 * good. It builds the prompt, calls the provider, parses the envelope, and hands
 * an array of untyped candidate objects to `conformance/compile.ts`, which is
 * where every decision that matters is made.
 *
 * The split is the point. Everything on this side of it has read attacker
 * prose and cannot be trusted; everything on the other side is deterministic
 * and has not. Keeping the boundary sharp is what lets the security claim in
 * docs/INTENT.md be specific rather than hopeful.
 */
import { buildExtractPrompt, EXTRACT_SYSTEM_PROMPT } from './extract-prompt.js';
import { cacheKey, type LabelCache } from './cache.js';
import { estimateCostUsd } from './pricing.js';
import type { CompletionProvider } from './provider.js';
import type { RawCandidate } from '../conformance/compile.js';

/**
 * Capped hard. A document stating fifty dependency rules is not a document, it
 * is a payload — and the cap bounds both the output tokens and the number of
 * constraints a single hostile file can introduce.
 */
export const MAX_STATEMENTS_PER_DOCUMENT = 25;

const MAX_OUTPUT_TOKENS = 2_048;

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      description: 'Architectural statements found in the document. Empty if there are none.',
      items: {
        type: 'object',
        properties: {
          rawText: {
            type: 'string',
            description: 'The sentence copied from the document, exactly as written.',
          },
          relation: {
            type: 'string',
            enum: ['must-not-import', 'may-only-import-via', 'must-not-cycle', 'must-be-layer-above'],
            description: 'Omit when the statement is not checkable against an import graph.',
          },
          subject: { type: 'string', description: 'The noun phrase the document uses for the constrained part.' },
          object: { type: 'string', description: 'The noun phrase for the other side of the relation.' },
          via: { type: 'string', description: 'Only for may-only-import-via.' },
          uncheckableReason: {
            type: 'string',
            enum: [
              'style-preference',
              'process-rule',
              'runtime-behaviour',
              'unsupported-relation',
              'descriptive-not-normative',
              'technology-choice',
            ],
            description: 'Give this instead of a relation when the statement cannot be checked.',
          },
        },
        required: ['rawText'],
        additionalProperties: false,
      },
    },
  },
  required: ['statements'],
  additionalProperties: false,
} as const;

const SCHEMA_FINGERPRINT = JSON.stringify(EXTRACT_SCHEMA);

export interface ExtractRequest {
  readonly location: string;
  readonly documentText: string;
  readonly moduleHints: readonly string[];
}

export interface ExtractOutcome {
  readonly location: string;
  readonly candidates: readonly RawCandidate[];
}

export interface ExtractUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedCostUsd: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

export interface ExtractResult {
  readonly outcomes: readonly ExtractOutcome[];
  readonly failures: readonly { readonly location: string; readonly reason: string }[];
  readonly usage: ExtractUsage;
}

export interface IntentExtractor {
  extract(requests: readonly ExtractRequest[]): Promise<ExtractResult>;
}

export interface CachedExtractorOptions {
  readonly provider: CompletionProvider;
  readonly cache: LabelCache;
  readonly onProgress?: (done: number, total: number, location: string) => void;
}

export function createCachedExtractor(options: CachedExtractorOptions): IntentExtractor {
  return {
    extract: async (requests: readonly ExtractRequest[]): Promise<ExtractResult> => {
      const outcomes: ExtractOutcome[] = [];
      const failures: { location: string; reason: string }[] = [];
      let promptTokens = 0;
      let completionTokens = 0;
      let estimatedCostUsd = 0;
      let cacheHits = 0;
      let cacheMisses = 0;

      for (const [index, request] of requests.entries()) {
        const user = buildExtractPrompt({
          documentText: request.documentText,
          location: request.location,
          moduleHints: request.moduleHints,
        });

        const key = cacheKey({
          model: options.provider.model,
          system: EXTRACT_SYSTEM_PROMPT,
          user,
          schema: SCHEMA_FINGERPRINT,
        });

        const cached = options.cache.get(key);
        if (cached !== undefined) {
          cacheHits += 1;
          // `description` is the cache's free-text slot, reused here to hold the
          // statement envelope. Null means an entry written by the labeller, not
          // by this extractor; parseCandidates turns that into no statements.
          outcomes.push({ location: request.location, candidates: parseCandidates(cached.description ?? '') });
          options.onProgress?.(index + 1, requests.length, request.location);
          continue;
        }

        cacheMisses += 1;
        const completion = await options.provider.complete({
          system: EXTRACT_SYSTEM_PROMPT,
          user,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          schema: EXTRACT_SCHEMA,
          // Deciding whether a sentence carries a checkable obligation is a
          // judgement, not a lookup. Week 6's 'low' is the wrong setting here.
          effort: 'medium',
        });

        if (!completion.ok) {
          failures.push({ location: request.location, reason: completion.error.message });
          options.onProgress?.(index + 1, requests.length, request.location);
          continue;
        }

        promptTokens += completion.value.usage.promptTokens;
        completionTokens += completion.value.usage.completionTokens;
        estimatedCostUsd += estimateCostUsd(
          completion.value.model,
          completion.value.usage.promptTokens,
          completion.value.usage.completionTokens,
        );

        const candidates = parseCandidates(completion.value.text);
        // Cached as the raw envelope. Compilation is deterministic and cheap, so
        // caching before it means a change to the rules — a new uncheckable
        // reason, a stricter quote check — takes effect on the next run without
        // paying to re-read every document.
        options.cache.set(key, {
          label: 'intent',
          description: JSON.stringify({ statements: candidates }),
          model: completion.value.model,
          promptTokens: completion.value.usage.promptTokens,
          completionTokens: completion.value.usage.completionTokens,
          createdAt: new Date().toISOString(),
        });

        outcomes.push({ location: request.location, candidates });
        options.onProgress?.(index + 1, requests.length, request.location);
      }

      return {
        outcomes,
        failures,
        usage: { promptTokens, completionTokens, estimatedCostUsd, cacheHits, cacheMisses },
      };
    },
  };
}

/**
 * Pulls the statement array out of whatever came back.
 *
 * Total by construction: anything unparseable yields an empty list, which
 * degrades to "this document stated nothing" rather than throwing. Structural
 * checks only — the fields stay `unknown` and are validated in compile.ts, so
 * there is exactly one place where a candidate is judged.
 */
export function parseCandidates(text: string): RawCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];
  const statements = (parsed as { statements?: unknown }).statements;
  if (!Array.isArray(statements)) return [];

  return statements
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .slice(0, MAX_STATEMENTS_PER_DOCUMENT);
}
