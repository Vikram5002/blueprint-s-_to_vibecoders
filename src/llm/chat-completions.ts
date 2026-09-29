/**
 * The OpenAI chat-completions wire format, as a CompletionProvider.
 *
 * Most model services speak this one shape: a gateway like Bluesminds, and
 * equally the free tiers and local runtimes (Groq, OpenRouter, GitHub
 * Models, Ollama, LM Studio). This file holds everything that is true of the
 * format itself - the request body, structured-output negotiation, the
 * response and truncation checks, retry with backoff, key redaction - so an
 * adapter for a particular service only says where it is and how patient to be.
 *
 * ## No SDK
 *
 * Plain `fetch`: the surface needed is one POST, and `openai` is a dependency
 * and a supply-chain edge for a mapper this size.
 *
 * ## The key never gets logged
 *
 * Sent as a Bearer header, never in a URL. Every error body surfaced from here
 * goes through `redact()` first, which strips the key itself - many of these
 * tokens are opaque with no recognisable prefix, so redaction is done by exact
 * substring against the configured key rather than by shape.
 */
import type { CompletionProvider, CompletionRequest, CompletionResult } from './provider.js';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface ChatCompletionsOptions {
  /** Prefix for the provider's reported name, e.g. `bluesminds` -> `bluesminds:<model>`. */
  readonly name: string;
  /** Full URL of the chat-completions endpoint. */
  readonly endpoint: string;
  /** Null for a service with no authentication (a local runtime). */
  readonly apiKey: string | null;
  readonly model: string;
  readonly retry: RetryPolicy;
  readonly requestTimeoutMs: number;
  /** Added to a 404's message: what to do when the model is not on the server (Ollama: the pull command). */
  readonly notFoundHint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Removes the key from text before it is shown. Bearer-looking headers are
 * scrubbed too, in case a service echoes the request back in an error body -
 * which some gateways do.
 */
export function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('[REDACTED]');
  return withoutKey.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]');
}

export function backoffWith(policy: RetryPolicy, attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, policy.maxBackoffMs);
  return Math.min(policy.baseBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createChatCompletionsProvider(options: ChatCompletionsOptions): CompletionProvider {
  const { model, retry } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const scrub = (text: string): string => redact(text, options.apiKey ?? '');

  /**
   * Whether this model accepts `response_format: json_schema`, learned rather
   * than declared - the same runtime-negotiation shape as Gemini's
   * `thinkingConfig`. A service fronting many model families cannot have
   * uniform structured-output support, and a hardcoded table would rot on
   * every catalogue change. On a 400 that names the parameter, this flips off
   * for the process and the call is retried asking for plain JSON instead.
   *
   * The downgrade is safe *because* validation happens again on the way back
   * (`validate.ts`): a provider-enforced schema was always a convenience, not
   * the guarantee. It is recorded so a run can report that it happened rather
   * than silently producing weaker output.
   */
  let schemaSupported = true;
  let schemaDowngraded = false;

  return {
    name: `${options.name}:${model}`,
    model,

    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      let lastFailure: CompletionResult | null = null;

      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await doFetch(options.endpoint, {
            method: 'POST',
            headers: {
              ...(options.apiKey === null ? {} : { authorization: `Bearer ${options.apiKey}` }),
              'content-type': 'application/json',
            },
            body: JSON.stringify(buildRequestBody(request, model, schemaSupported)),
            signal: AbortSignal.timeout(options.requestTimeoutMs),
          });
        } catch (cause) {
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: scrub(`network error: ${String(cause)}`) },
          };
          if (attempt === retry.maxAttempts) return lastFailure;
          await sleep(backoffWith(retry, attempt, null));
          continue;
        }

        if (response.ok) {
          return readSuccess(await response.text(), model, schemaDowngraded);
        }

        const text = scrub(await response.text());

        /**
         * 410 means the service still advertises a model it no longer serves.
         * Non-retryable and worth naming precisely, because the failure looks
         * like a typo in a model string and is not.
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
          // A free tier's daily cap does not clear by waiting; say so at once
          // (retryable: false) instead of backing off into the same answer.
          if (isDailyLimit(text)) {
            return {
              ok: false,
              error: {
                kind: 'unavailable',
                message: `daily free limit reached for ${model}; it resets tomorrow. Detail: ${summarise(text)}`,
                retryable: false,
              },
            };
          }
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: `rate limited after ${attempt} attempt(s)` },
          };
          if (attempt === retry.maxAttempts) return lastFailure;
          await sleep(backoffWith(retry, attempt, retryAfterMsFrom(response)));
          continue;
        }

        if (response.status >= 500) {
          lastFailure = {
            ok: false,
            error: { kind: 'unavailable', message: `HTTP ${response.status} after ${attempt} attempt(s)` },
          };
          if (attempt === retry.maxAttempts) return lastFailure;
          await sleep(backoffWith(retry, attempt, null));
          continue;
        }

        // A 400 naming the structured-output parameter is the model refusing
        // it. Drop to plain JSON and try once more before giving up.
        if (response.status === 400 && schemaSupported && looksLikeSchemaRejection(text)) {
          schemaSupported = false;
          schemaDowngraded = true;
          continue;
        }

        const hint = response.status === 404 && options.notFoundHint !== undefined ? ` - ${options.notFoundHint}` : '';
        return {
          ok: false,
          error: {
            kind: response.status === 400 ? 'refused' : 'unavailable',
            message: `HTTP ${response.status}: ${summarise(text)}${hint}`,
          },
        };
      }

      return lastFailure ?? { ok: false, error: { kind: 'unavailable', message: 'exhausted retries' } };
    },
  };
}

/**
 * Does this 429 name a per-day window? Groq says "requests per day (RPD)",
 * OpenRouter "free-models-per-day", GitHub Models "UserByModelByDay". A
 * per-minute cap names its minute and is retried as before.
 */
export function isDailyLimit(body: string): boolean {
  return /per[-_ ]?day|daily|\bRPD\b|\bTPD\b|ByDay/i.test(body);
}

/** `Retry-After` in seconds, when the service sends one. */
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
  // When the schema cannot be enforced it is at least stated: a model asked
  // only for "some JSON" guesses its own field names, and validation then
  // rejects every answer. The same contract the local server applies
  // (pdsf/local_inference_server.py, system_with_schema).
  const system =
    !withSchema && request.schema !== undefined
      ? `${request.system}\n\nRespond with JSON only, matching this JSON schema exactly:\n${JSON.stringify(request.schema)}`
      : request.system;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
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
   * `missing-label` - a total failure that looked like a bad model. There is
   * no fallback schema here and no default: what the caller passes is what
   * goes on the wire, and the adapter tests assert it arrives.
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
 * Does this 400 mean "I do not accept response_format"? A guess, like
 * Gemini's equivalent, and safe for the same reason: the fallback is one
 * retry without the parameter.
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
   * A reasoning model can return HTTP 200, finish_reason "length" and an
   * **empty** message, having spent the whole budget on reasoning (found on
   * `nemotron-super-49b` behind Bluesminds). Without this check that is
   * indistinguishable from "the model had nothing to say" - a zero that looks
   * measured. `length` is the OpenAI spelling; `max_tokens` is accepted too
   * because services are inconsistent about it.
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
       * The model the service says served the request, not the one asked for.
       * They can differ, and when they do the difference is the whole
       * provenance problem - so it is reported rather than assumed.
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
