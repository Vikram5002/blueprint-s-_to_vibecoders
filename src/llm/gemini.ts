/**
 * Google Gemini implementation of CompletionProvider.
 *
 * The second vendor in the project, and the second file allowed to know a
 * vendor exists. It satisfies exactly the same interface as `anthropic.ts`, so
 * everything above it — the cached labeller, the intent extractor, the whole
 * pipeline — is unchanged and unaware.
 *
 * ## No SDK
 *
 * Plain `fetch`. The REST surface needed here is one POST, and `@google/genai`
 * is a dependency, a version and a supply-chain edge for something a 40-line
 * mapper covers. CLAUDE.md is explicit about not adding heavy dependencies to a
 * CLI where startup time matters, and this keeps the no-key path at zero cost.
 *
 * ## The key never gets logged
 *
 * It is sent in the `x-goog-api-key` header, never as a `?key=` query
 * parameter, so it cannot appear in a URL that ends up in an error message, a
 * proxy log or a stack trace. Every error body this file surfaces is passed
 * through `redact()` first.
 */
import { estimateCostUsd } from './pricing.js';
import type { CompletionProvider, CompletionRequest, CompletionResult } from './provider.js';

export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

/**
 * Verified against the live ListModels endpoint on 2026-08-09, not assumed.
 *
 * The obvious choice, `gemini-2.0-flash`, does not work: it returns 429
 * RESOURCE_EXHAUSTED on a fresh free-tier key, because the 2.0 family no longer
 * carries free quota. `gemini-2.5-flash` returns 404 — "no longer available to
 * new users". Both would have shipped as a confident default that fails on
 * every run.
 *
 * `gemini-3.5-flash` is the newest flash model that is stable, pinned, free,
 * and honours `responseSchema` and `thinkingConfig`. Deliberately not
 * `gemini-flash-latest`: a floating alias changes model under a cache keyed on
 * the model string, which would silently mix answers from two different models
 * in one cache file and break the reproducibility guarantee the project rests
 * on. Pinning is the point.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Models that reject `thinkingConfig`. `gemini-3.6-flash` returns 400 for
 * `thinkingBudget: 0`, so it is sent only where it is known to work.
 */
const ACCEPTS_THINKING_BUDGET: ReadonlySet<string> = new Set([
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
]);

/** Attempts per request, including the first. */
export const MAX_ATTEMPTS = 5;
/** First backoff step; doubles each retry unless the server names a delay. */
export const BASE_BACKOFF_MS = 1_000;
/** Never wait longer than this for a single retry. */
export const MAX_BACKOFF_MS = 60_000;

export interface GeminiOptions {
  readonly apiKey: string;
  readonly model?: string;
  /**
   * Injected in tests so retry behaviour can be exercised without real
   * network calls or real waiting.
   */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function readGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env[GEMINI_API_KEY_ENV];
  return key === undefined || key.trim() === '' ? null : key.trim();
}

/**
 * Strips anything key-shaped from text before it is shown.
 *
 * Belt and braces: the key is never put anywhere Google echoes back, but error
 * bodies are attacker-adjacent text being funnelled into a user's terminal and
 * a `.vibe/` log, and a redaction pass costs nothing.
 */
export function redact(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]');
}

interface QuotaVerdict {
  /** False when retrying cannot possibly help. */
  readonly retryable: boolean;
  /** Server-supplied delay in ms, when it gave one. */
  readonly retryAfterMs: number | null;
  readonly detail: string;
}

/**
 * Reads a 429 body to decide whether waiting will help.
 *
 * This distinction is the whole reason the retry logic is not three lines. A
 * free-tier 429 is either a per-minute limit, which clears on its own in
 * seconds, or a per-day limit, which does not clear until midnight Pacific.
 * Backing off through five attempts against a daily cap burns roughly a minute
 * per module to arrive at the same failure — on a 46-module repository that is
 * three quarters of an hour of sleeping before the run gives up.
 *
 * So a daily exhaustion fails immediately and says so.
 */
export function classifyQuotaFailure(body: string): QuotaVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { retryable: true, retryAfterMs: null, detail: 'rate limited' };
  }

  const error = (parsed as { error?: { message?: unknown; details?: unknown } }).error;
  const details = Array.isArray(error?.details) ? error.details : [];

  let retryAfterMs: number | null = null;
  let perDay = false;
  const quotaIds: string[] = [];

  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { '@type'?: unknown; retryDelay?: unknown; violations?: unknown };

    if (typeof record.retryDelay === 'string') {
      const seconds = Number.parseFloat(record.retryDelay.replace(/s$/, ''));
      if (Number.isFinite(seconds)) retryAfterMs = Math.round(seconds * 1000);
    }

    if (Array.isArray(record.violations)) {
      for (const violation of record.violations) {
        const id = (violation as { quotaId?: unknown }).quotaId;
        if (typeof id !== 'string') continue;
        quotaIds.push(id);
        if (/PerDay/i.test(id)) perDay = true;
      }
    }
  }

  if (perDay) {
    return {
      retryable: false,
      retryAfterMs: null,
      detail:
        'daily free-tier quota exhausted (' +
        (quotaIds.find((id) => /PerDay/i.test(id)) ?? 'PerDay') +
        '). This resets at midnight Pacific; retrying now cannot help.',
    };
  }

  return {
    retryable: true,
    retryAfterMs,
    detail: quotaIds.length > 0 ? `rate limited (${quotaIds[0] as string})` : 'rate limited',
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createGeminiProvider(options: GeminiOptions): CompletionProvider {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  return {
    name: `gemini:${model}`,
    model,

    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      const body = buildRequestBody(model, request);
      let lastFailure: CompletionResult | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await doFetch(`${ENDPOINT}/${model}:generateContent`, {
            method: 'POST',
            headers: {
              // Header, not a query parameter: a URL can end up in a log.
              'x-goog-api-key': options.apiKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          });
        } catch (cause) {
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: redact(`network error: ${String(cause)}`) },
          };
          if (attempt === MAX_ATTEMPTS) return lastFailure;
          await sleep(backoffFor(attempt, null));
          continue;
        }

        if (response.ok) {
          return readSuccess(await response.text(), model);
        }

        const text = redact(await response.text());

        // 429 and 5xx are worth another go; 400/401/403/404 are not — a bad key
        // or a wrong model name will fail identically five times.
        if (response.status === 429) {
          const verdict = classifyQuotaFailure(text);
          if (!verdict.retryable) {
            return { ok: false, error: { kind: 'unavailable', message: verdict.detail } };
          }
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: `${verdict.detail} after ${attempt} attempt(s)` },
          };
          if (attempt === MAX_ATTEMPTS) return lastFailure;
          await sleep(backoffFor(attempt, verdict.retryAfterMs));
          continue;
        }

        if (response.status >= 500) {
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: `HTTP ${response.status} after ${attempt} attempt(s)` },
          };
          if (attempt === MAX_ATTEMPTS) return lastFailure;
          await sleep(backoffFor(attempt, null));
          continue;
        }

        return {
          ok: false,
          error: {
            kind: response.status === 400 ? 'refused' : 'unavailable',
            message: `HTTP ${response.status}: ${summarise(text)}`,
          },
        };
      }

      return lastFailure ?? { ok: false, error: { kind: 'unavailable', message: 'exhausted retries' } };
    },
  };
}

/**
 * Exponential backoff, but the server's own `retryDelay` wins when it gives
 * one. Guessing longer than instructed wastes time; guessing shorter earns
 * another 429.
 */
export function backoffFor(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

function buildRequestBody(model: string, request: CompletionRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxOutputTokens,
    // The same structured-output guarantee the Anthropic adapter asks for.
    // Re-validated on the way back regardless; see validate.ts.
    responseMimeType: 'application/json',
    ...(request.schema === undefined ? {} : { responseSchema: toGeminiSchema(request.schema) }),
  };

  // Gemini still accepts temperature, where the current Anthropic models
  // reject it outright. Passed straight through when the caller sets it.
  if (request.temperature !== undefined) {
    generationConfig['temperature'] = request.temperature;
  }

  /**
   * Thinking is billed and slow, and naming a cluster does not need it.
   * Measured on gemini-3.5-flash: 332 thinking tokens and 2,299 ms with the
   * default budget, against 0 tokens and 1,026 ms with it disabled. Over a
   * 46-module repository that is more than a minute of latency for a task
   * that is a lookup.
   *
   * Raised for 'high' effort, which is what intent extraction asks for —
   * deciding whether a sentence carries a checkable obligation is a judgement,
   * and there the thinking is worth paying for.
   */
  if (ACCEPTS_THINKING_BUDGET.has(model)) {
    generationConfig['thinkingConfig'] = { thinkingBudget: thinkingBudgetFor(request.effort) };
  }

  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.user }] }],
    generationConfig,
  };
}

export function thinkingBudgetFor(effort: CompletionRequest['effort']): number {
  switch (effort) {
    case 'high':
      return 4_096;
    case 'medium':
      return 1_024;
    default:
      return 0;
  }
}

/**
 * Gemini's schema dialect is OpenAPI-flavoured and rejects some JSON Schema
 * keywords outright — `additionalProperties` is the one our schemas carry.
 * Stripped here rather than removed from the schema, because the Anthropic
 * adapter wants it: it is what stops that provider inventing extra fields.
 * Dropping it for Gemini is not a weakening, because the structural check that
 * matters happens in validate.ts for both providers.
 */
function toGeminiSchema(schema: Readonly<Record<string, unknown>>): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value !== 'object' || value === null) return value;

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'additionalProperties' || key === '$schema') continue;
      output[key] = strip(nested);
    }
    return output;
  };
  return strip(schema);
}

function readSuccess(raw: string, model: string): CompletionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { kind: 'refused', message: 'response was not JSON' } };
  }

  const data = parsed as {
    candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown; cachedContentTokenCount?: unknown };
    promptFeedback?: { blockReason?: unknown };
  };

  if (typeof data.promptFeedback?.blockReason === 'string') {
    return {
      ok: false,
      error: { kind: 'refused', message: `blocked: ${data.promptFeedback.blockReason}` },
    };
  }

  const candidate = data.candidates?.[0];
  if (candidate === undefined) {
    return { ok: false, error: { kind: 'refused', message: 'no candidates returned' } };
  }

  // MAX_TOKENS means the JSON is truncated and will fail validation anyway.
  // Saying so here produces a better message than "malformed label".
  if (candidate.finishReason === 'MAX_TOKENS') {
    return { ok: false, error: { kind: 'refused', message: 'response hit the output token limit' } };
  }
  if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
    return { ok: false, error: { kind: 'refused', message: `stopped: ${String(candidate.finishReason)}` } };
  }

  const text = (candidate.content?.parts ?? [])
    .flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
    .join('');

  const promptTokens = asCount(data.usageMetadata?.promptTokenCount);
  // Thinking tokens are billed as output where they are billed at all, so they
  // are counted here. Reporting only the visible answer would understate usage.
  const completionTokens = asCount(data.usageMetadata?.candidatesTokenCount) + asCount(data.usageMetadata?.thoughtsTokenCount);

  return {
    ok: true,
    value: {
      text,
      model,
      usage: {
        promptTokens,
        completionTokens,
        cachedPromptTokens: asCount(data.usageMetadata?.cachedContentTokenCount),
      },
    },
  };
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summarise(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string') return message.slice(0, 200).replace(/\s+/g, ' ');
  } catch {
    /* fall through to the raw slice */
  }
  return body.slice(0, 200).replace(/\s+/g, ' ');
}

/** Estimated cost. Free tier is $0, but tokens are still reported. */
export function estimateGeminiCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  return estimateCostUsd(model, promptTokens, completionTokens);
}
