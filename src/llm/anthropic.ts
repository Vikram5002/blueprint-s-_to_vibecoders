/**
 * Anthropic implementation of CompletionProvider.
 *
 * The only file in the project that knows a vendor exists. It is reachable from
 * the composition root alone — `graph/` and `parser/` may not import `llm/` at
 * all (rule 1), and `pipeline/label.ts` takes an injected labeller rather than
 * importing this.
 *
 * The SDK is loaded with a dynamic import so that a run with no API key never
 * pays to load 6.5 MB of client library. Startup time matters for a CLI, and
 * the no-key path is the common one.
 *
 * ## On temperature
 *
 * The brief asks for temperature 0. Current Anthropic models — Opus 5, Opus
 * 4.8/4.7, Sonnet 5 — reject `temperature` outright with a 400; it was removed,
 * not deprecated. So it is sent only to models that still accept it, and
 * omitted otherwise.
 *
 * Nothing is lost. Temperature 0 was only ever a proxy for reproducibility, and
 * it never actually guaranteed identical output. Reproducibility here comes
 * from the response cache: an unchanged repository produces byte-identical
 * prompts, so the model is asked once per distinct cluster and every later run
 * replays the stored answer. That is a real guarantee where temperature 0 was
 * an approximation of one.
 */
import { estimateCostUsd } from './pricing.js';
import type {
  CompletionProvider,
  CompletionRequest,
  CompletionResult,
} from './provider.js';

/**
 * Naming a cluster from paths and symbols is a short, shallow task, and Week 14
 * runs it across 50-100 repositories — so the default is the cheapest capable
 * model rather than the most capable one. $1/$5 per MTok against Opus 5's
 * $5/$25.
 *
 * Override with VIBE_LLM_MODEL to compare or to upgrade. Haiku also still
 * accepts `temperature`, which the Opus and Sonnet 5 tiers do not.
 */
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export const API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Models that still accept `temperature`. Newer models removed the parameter
 * and return 400 if it is present, so the request omits it for anything absent
 * from this list.
 */
const ACCEPTS_TEMPERATURE: ReadonlySet<string> = new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]);

// Defined in schemas.ts: it describes the request, not this vendor.
export { LABEL_SCHEMA } from './schemas.js';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model?: string;
}

/**
 * Reads the key from the environment. Returns null when unset, which is the
 * signal to run mechanically — not an error, and not something to warn about.
 */
export function readApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env[API_KEY_ENV];
  return key === undefined || key.trim() === '' ? null : key.trim();
}

export async function createAnthropicProvider(options: AnthropicOptions): Promise<CompletionProvider> {
  const model = options.model ?? DEFAULT_MODEL;

  // Dynamic so the no-key path never loads the SDK.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: options.apiKey });

  return {
    name: `anthropic:${model}`,
    model,
    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: request.maxOutputTokens,
          system: [
            {
              type: 'text',
              text: request.system,
              // The system prompt is identical for every cluster in a run, so
              // caching it turns N calls into one full-price prefix plus N cheap
              // reads.
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: request.user }],
          output_config: {
            // Naming a cluster from paths and symbols is not a reasoning task.
            // Reading obligations out of prose is, so the caller can raise it.
            effort: request.effort ?? 'low',
            // Structured output only when the caller asked for a shape. This
            // adapter used to substitute the label schema whenever `schema` was
            // unset, which made a caller that forgot to send one work here and
            // fail against every other provider.
            ...(request.schema === undefined
              ? {}
              : { format: { type: 'json_schema' as const, schema: request.schema } }),
          },
          ...(request.temperature !== undefined && ACCEPTS_TEMPERATURE.has(model)
            ? { temperature: request.temperature }
            : {}),
        });

        if (response.stop_reason === 'refusal') {
          return { ok: false, error: { kind: 'refused', message: 'the model declined to answer' } };
        }

        /**
         * Truncation was previously unhandled here, and that was a real bug.
         *
         * A response stopped at `max_tokens` came back as a success carrying
         * partial JSON, which then failed to parse and became an empty result
         * — a silent zero, indistinguishable from a document that stated
         * nothing. The Gemini adapter caught this from the start; this one did
         * not, so the failure mode was live on the Anthropic path the whole
         * time and would never have shown up in a count.
         */
        if (response.stop_reason === 'max_tokens') {
          return {
            ok: false,
            error: {
              kind: 'incomplete',
              message: 'the answer was cut off at the output token limit, so nothing from this document was read',
            },
          };
        }

        // content is a discriminated union; narrow inside the callback so the
        // SDK's own TextBlock type is what gets read.
        const text = response.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('');

        if (text.trim() === '') {
          return { ok: false, error: { kind: 'refused', message: 'empty response' } };
        }

        return {
          ok: true,
          value: {
            text,
            model: response.model,
            usage: {
              promptTokens: response.usage.input_tokens,
              completionTokens: response.usage.output_tokens,
              cachedPromptTokens: response.usage.cache_read_input_tokens ?? 0,
            },
          },
        };
      } catch (cause: unknown) {
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        };
      }
    },
  };
}

export { estimateCostUsd };
