/**
 * Bluesminds implementation of CompletionProvider — an OpenAI-compatible gateway.
 *
 * The third vendor, and the first that is a *gateway* rather than a model
 * provider. It resells access to many upstream models behind one
 * OpenAI-shaped API, which changes what a result from it can be claimed to
 * mean. See `docs/PROVIDERS.md` for the provenance caveat; the short version
 * is that this adapter is for bulk work where throughput matters, and not for
 * any measurement that has to be attributed to a specific model version.
 *
 * The wire format itself - request body, structured-output negotiation,
 * truncation checks, retries, key redaction - lives in `chat-completions.ts`,
 * shared with every other OpenAI-compatible service. This file says where the
 * gateway is and how patient to be with it.
 */
import { backoffWith, createChatCompletionsProvider, redact as redactKey, type RetryPolicy } from './chat-completions.js';
import type { CompletionProvider } from './provider.js';

export const BLUESMINDS_API_KEY_ENV = 'BLUESMINDS_API_KEY';

const ENDPOINT = 'https://api.bluesminds.com/v1/chat/completions';

/**
 * Verified against the live catalogue and by actually calling it, on
 * 2026-08-10. Neither check alone was enough.
 *
 * `GET /v1/models` returns 137 entries, and **the list is not a list of working
 * models**. Of eleven probed:
 *
 * - four were listed but end-of-life and answer 410 (`mistral-medium-3.5`
 *   expired three days before this was written, `qwen3-next-80b` in July,
 *   `deepseek-v4-flash`, `glm4.7`);
 * - four were listed but broken — `gpt-4o-mini` returned 400 "No connected db."
 *   and later 429, `gpt-4o` a 500 upstream error, `gpt-oss-120b` a 504,
 *   `gemma-3-12b-it` a 404 naming an internal function id;
 * - one, `nemotron-super-49b`, returns HTTP 200 with `finish_reason: "length"`
 *   and an **empty** message, having spent the entire budget reasoning.
 *
 * Two worked properly. This one is the larger, and labelling and intent
 * extraction are judgement tasks where the smaller model's quality shows.
 * `meta/llama-3.1-8b-instruct` is the fast alternative — roughly 1.3s against
 * 15s — and is the right choice when throughput matters more than the name.
 *
 * Pinned to an exact string, never a floating alias, for the same reason as
 * `gemini-3.5-flash`: the response cache is keyed on the model string, so an
 * alias that silently repoints would mix answers from two different models in
 * one cache file and quietly break reproducibility.
 */
export const DEFAULT_BLUESMINDS_MODEL = 'meta/llama-3.3-70b-instruct';

/** The fast, lower-quality alternative. Documented so the choice is visible. */
export const FAST_BLUESMINDS_MODEL = 'meta/llama-3.1-8b-instruct';

/**
 * Retry policy, tuned to a measured rate limit rather than a guessed one.
 *
 * This gateway sends **no `Retry-After` and no `x-ratelimit-*` headers at
 * all**, so a client has nothing to pace against and backoff is the only
 * lever. Measured on 2026-08-10: a zod run (19 labels + 5 documents) exhausted
 * the limit, after which six sequential requests returned 429 immediately and
 * the window cleared roughly 90 seconds later.
 *
 * The first version used the Gemini settings — 5 attempts over about 15
 * seconds — and lost 9 of 24 calls on that run, because 15 seconds is far
 * inside a 90-second window. These values span roughly 120 seconds
 * (4+8+16+32+60), which covers it.
 *
 * The cost is that a genuinely dead endpoint now takes two minutes to give up
 * on instead of fifteen seconds. That is the right trade for corpus work,
 * where a lost label means re-running the repository.
 */
export const MAX_ATTEMPTS = 6;
export const BASE_BACKOFF_MS = 4_000;
export const MAX_BACKOFF_MS = 60_000;

const RETRY: RetryPolicy = { maxAttempts: MAX_ATTEMPTS, baseBackoffMs: BASE_BACKOFF_MS, maxBackoffMs: MAX_BACKOFF_MS };

/**
 * Generous, because a gateway hop plus a 70B model is slow: 15s for a
 * 21-token answer was typical in probing. Node's default has no timeout at
 * all, which would let one wedged request hang a corpus run indefinitely.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

export interface BluesmindsOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function readBluesmindsApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env[BLUESMINDS_API_KEY_ENV];
  return key === undefined || key.trim() === '' ? null : key.trim();
}

/**
 * Removes the key from text before it is shown. Unlike Google's `AIza…`,
 * this token has no documented shape to match on, so the only reliable
 * redaction is an exact substring replacement against the key we hold.
 */
export function redact(text: string, apiKey: string): string {
  return redactKey(text, apiKey);
}

export function createBluesmindsProvider(options: BluesmindsOptions): CompletionProvider {
  return createChatCompletionsProvider({
    name: 'bluesminds',
    endpoint: ENDPOINT,
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_BLUESMINDS_MODEL,
    retry: RETRY,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

export function backoffFor(attempt: number, retryAfterMs: number | null): number {
  return backoffWith(RETRY, attempt, retryAfterMs);
}
