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
 * ## No SDK, again
 *
 * Plain `fetch`, for the same reason as `gemini.ts`: the surface needed is one
 * POST, and `openai` is a dependency and a supply-chain edge for a mapper this
 * size. The response shape is the widely-implemented chat-completions one.
 *
 * ## The key never gets logged
 *
 * Sent as a Bearer header, never in a URL. Every error body surfaced from here
 * goes through `redact()` first, which strips the key itself — the token is
 * opaque and has no recognisable prefix to pattern-match, so redaction is done
 * by exact substring against the configured key rather than by shape.
 */
import type { CompletionProvider, CompletionRequest, CompletionResult } from './provider.js';

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
 * Removes the key from text before it is shown.
 *
 * Unlike Google's `AIza…`, this token has no documented shape to match on, so
 * the only reliable redaction is an exact substring replacement against the
 * key we hold. Bearer-looking headers are scrubbed too, in case a gateway
 * echoes the request back in an error body — which some do.
 */
export function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('[REDACTED]');
  return withoutKey.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]');
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createBluesmindsProvider(options: BluesmindsOptions): CompletionProvider {
  const model = options.model ?? DEFAULT_BLUESMINDS_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const scrub = (text: string): string => redact(text, options.apiKey);

  /**
   * Whether this model accepts `response_format: json_schema`, learned rather
   * than declared — the same runtime-negotiation shape as Gemini's
   * `thinkingConfig`.
   *
   * A gateway fronting 137 models from a dozen families cannot possibly have
   * uniform structured-output support, and a hardcoded table would rot on
   * every catalogue change. On a 400 that names the parameter, this flips off
   * for the process and the call is retried asking for plain JSON instead.
   *
   * The downgrade is safe *because* validation happens again on the way back
   * (`validate.ts`): a provider-enforced schema was always a convenience, not
   * the guarantee. It is recorded on the provider so a run can report that it
   * happened rather than silently producing weaker output.
   */
  let schemaSupported = true;
  let schemaDowngraded = false;

  return {
    name: `bluesminds:${model}`,
    model,

    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      let lastFailure: CompletionResult | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await doFetch(ENDPOINT, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(buildRequestBody(request, model, schemaSupported)),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (cause) {
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: scrub(`network error: ${String(cause)}`) },
          };
          if (attempt === MAX_ATTEMPTS) return lastFailure;
          await sleep(backoffFor(attempt, null));
          continue;
        }

        if (response.ok) {
          return readSuccess(await response.text(), model, schemaDowngraded);
        }

        const text = scrub(await response.text());

        /**
         * 410 means the gateway still advertises a model it no longer serves.
         * Non-retryable and worth naming precisely, because the failure looks
         * like a typo in a model string and is not — four of the eleven models
         * probed for this adapter were in exactly this state.
         */
        if (response.status === 410) {
          return {
            ok: false,
            error: {
              kind: 'unavailable',
              message:
                `model "${model}" is end-of-life at this gateway and no longer served, ` +
                `though it is still listed by GET /v1/models. Pin a different model. ` +
                `Detail: ${summarise(text)}`,
            },
          };
        }

        if (response.status === 429) {
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: `rate limited after ${attempt} attempt(s)` },
          };
          if (attempt === MAX_ATTEMPTS) return lastFailure;
          await sleep(backoffFor(attempt, retryAfterMsFrom(response)));
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

        // A 400 naming the structured-output parameter is the model refusing
        // it. Drop to plain JSON and try once more before giving up.
        if (response.status === 400 && schemaSupported && looksLikeSchemaRejection(text)) {
          schemaSupported = false;
          schemaDowngraded = true;
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

export function backoffFor(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** `Retry-After` in seconds, when the gateway sends one. */
function retryAfterMsFrom(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number.parseFloat(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

function buildRequestBody(
  request: CompletionRequest,
  model: string,
  withSchema: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    max_tokens: request.maxOutputTokens,
  };

  if (request.temperature !== undefined) {
    body['temperature'] = request.temperature;
  }

  /**
   * The schema is sent, always, when the caller supplies one.
   *
   * This is the Week 11 lesson written into code. The labeller once omitted
   * its schema and the Anthropic adapter quietly substituted a default, so
   * when a second provider arrived it received no schema at all, returned a
   * differently-named field, and every module in the run was rejected as
   * `missing-label` — a total failure that looked like a bad model. There is
   * no fallback schema here and no default: what the caller passes is what
   * goes on the wire, and `bluesminds.test.ts` asserts it arrives.
   */
  if (withSchema && request.schema !== undefined) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: 'structured_output', strict: true, schema: request.schema },
    };
  } else if (request.schema !== undefined) {
    // Downgraded path: still demand JSON, just without the schema enforcing
    // its shape. validate.ts is what actually protects the pipeline.
    body['response_format'] = { type: 'json_object' };
  }

  return body;
}

/**
 * Does this 400 mean "I do not accept response_format"?
 *
 * A guess, like Gemini's equivalent, and safe for the same reason: the
 * fallback is one retry without the parameter.
 */
function looksLikeSchemaRejection(body: string): boolean {
  return /response_format|json_schema|structured|schema/i.test(body);
}

function readSuccess(raw: string, model: string, schemaDowngraded: boolean): CompletionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { kind: 'refused', message: 'response was not JSON' } };
  }

  const data = parsed as {
    choices?: {
      message?: { content?: unknown; refusal?: unknown };
      finish_reason?: unknown;
    }[];
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      prompt_tokens_details?: { cached_tokens?: unknown } | null;
    };
    model?: unknown;
    error?: { message?: unknown };
  };

  /**
   * Some OpenAI-compatible gateways answer 200 with an error object in the
   * body. Checked before anything else, because the fields below would all be
   * absent and the failure would surface as a confusing "no content".
   */
  if (data.error !== undefined && data.choices === undefined) {
    return {
      ok: false,
      error: { kind: 'refused', message: `gateway error: ${summarise(String(data.error.message ?? ''))}` },
    };
  }

  const choice = data.choices?.[0];
  if (choice === undefined) {
    return { ok: false, error: { kind: 'refused', message: 'response contained no choices' } };
  }

  if (typeof choice.message?.refusal === 'string' && choice.message.refusal !== '') {
    return { ok: false, error: { kind: 'refused', message: summarise(choice.message.refusal) } };
  }

  const text = typeof choice.message?.content === 'string' ? choice.message.content : '';

  /**
   * Truncation is its own failure, checked before the content is looked at.
   *
   * The brief said to assume a new provider has the silent-truncation bug
   * until proven otherwise, and this gateway does surface it in the worst
   * possible way: `nemotron-super-49b` returns **HTTP 200, finish_reason
   * "length", and an empty message**, having spent the whole budget on
   * reasoning. Without this check that is indistinguishable from "the model
   * had nothing to say" — which is precisely the bug that sat in the Anthropic
   * adapter for weeks and produced a zero that looked measured.
   *
   * `length` is the OpenAI spelling; `max_tokens` is accepted too because
   * gateways are inconsistent about it.
   */
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
  if (finish === 'length' || finish === 'max_tokens') {
    return {
      ok: false,
      error: {
        kind: 'incomplete',
        message:
          `the answer was cut off at the output token limit (finish_reason=${finish}` +
          `${text === '' ? ', and no content was returned at all' : ''})`,
      },
    };
  }

  if (text.trim() === '') {
    return { ok: false, error: { kind: 'refused', message: 'response contained no text' } };
  }

  const promptTokens = numberOr(data.usage?.prompt_tokens, 0);
  const completionTokens = numberOr(data.usage?.completion_tokens, 0);

  return {
    ok: true,
    value: {
      text,
      /**
       * The model the gateway says served the request, not the one asked for.
       * They can differ, and when they do the difference is the whole
       * provenance problem — so it is reported rather than assumed.
       */
      model: typeof data.model === 'string' && data.model !== '' ? data.model : model,
      usage: {
        promptTokens,
        completionTokens,
        cachedPromptTokens: numberOr(data.usage?.prompt_tokens_details?.cached_tokens, 0),
      },
      ...(schemaDowngraded ? { schemaDowngraded: true } : {}),
    },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function summarise(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}
