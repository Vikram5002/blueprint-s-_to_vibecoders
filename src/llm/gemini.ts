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
 *
 * ## Same-key rotation is not the rejected provider-fallback decision
 *
 * `select-provider.ts`'s own header documents a deliberate choice: this
 * project never silently falls back from one *vendor/model* to another
 * (Gemini -> local -> Anthropic) on failure, because that breaks
 * reproducibility and can route failure traffic into a weaker backend. That
 * decision is unchanged and untouched here.
 *
 * What this file does instead is narrower and does not implicate that
 * decision at all: when several `GEMINI_API_KEY`/`GEMINI_API_KEY_2`/...
 * credentials are configured, all for the SAME vendor and the SAME pinned
 * model, the provider advances to the next configured key whenever the
 * active one is exhausted on a failure that a *different* key or account
 * could plausibly answer differently — a confirmed daily quota exhaustion,
 * or `MAX_ATTEMPTS` worth of a transient 429/5xx/network failure that never
 * cleared. The model, the prompt, and every other behaviour are unchanged -
 * only which account's quota/capacity answers the call.
 *
 * Rotation still never fires on a *structural* failure - a bad key, a wrong
 * model name, or a malformed request (400/401/403/404, `retryable` absent
 * or `false`). Found live: a user with 7 configured keys, 3 already
 * rotated past on confirmed daily-quota exhaustion, hit a run of 503s on
 * the 4th and the whole generation failed immediately — 3 more untried,
 * unexhausted keys sat unused because the original policy rotated on
 * exactly one narrow outcome (`daily-quota-exhausted`) and treated every
 * other exhausted-after-5-attempts failure as final. Those structural
 * cases still fail loudly rather than silently rotating past what is
 * actually a configuration mistake (see `reasonToRotate` below for the
 * exact line the two are drawn on).
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
 * Headroom added to the caller's output budget when the model is thinking.
 *
 * `maxOutputTokens` in our interface means "how long may the *answer* be" — it
 * is sized for a label, and 256 is plenty. Gemini bills thinking against the
 * same budget, so passing the caller's number straight through means the model
 * spends the entire allowance reasoning and gets cut off mid-JSON. That is
 * exactly what happened: every label came back `MAX_TOKENS`, and the ones that
 * did not were rejected downstream as `missing-label`.
 *
 * So the adapter translates rather than forwards. The caller's number still
 * bounds the answer; this is the space the model is allowed to think in on top.
 *
 * Generous, because on models that reject `thinkingConfig` there is no way to
 * cap thinking at all — the only lever left is to leave enough room that it
 * cannot crowd out the answer. Unused headroom costs nothing: billing is on
 * tokens produced, not tokens permitted.
 */
const THINKING_HEADROOM_TOKENS = 8_192;

/**
 * Wall-clock ceiling on a single request.
 *
 * Node's `fetch` has **no default timeout**, so a connection that stalls
 * without closing blocks forever — and because the pipeline awaits each call
 * in turn, one stalled request wedges the entire run with no error, no log
 * line and no CPU use.
 *
 * That is not hypothetical: it hung the first corpus collection run on
 * prisma/prisma for over twenty minutes at 0.016s of CPU per minute, which is
 * what a process blocked on a socket looks like. The Bluesminds adapter was
 * given a timeout for exactly this reason when it was written; this adapter,
 * which is the default and the one collection actually uses, never had one.
 *
 * 120s is far above a normal flash response (1-3s) and above the slowest
 * observed (~16s), so it only fires on a genuinely dead connection. A timeout
 * surfaces as a network error, which the retry loop below already treats as
 * retryable — so a transient stall costs one backoff, not the run.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Attempts per request, including the first. */
export const MAX_ATTEMPTS = 5;
/** First backoff step; doubles each retry unless the server names a delay. */
export const BASE_BACKOFF_MS = 1_000;
/** Never wait longer than this for a single retry. */
export const MAX_BACKOFF_MS = 60_000;

export interface GeminiOptions {
  readonly apiKey: string;
  /**
   * Same-vendor, same-model key rotation (see this file's own header for why
   * this is not the rejected provider-fallback decision): additional
   * `GEMINI_API_KEY_2`/`_3`/... credentials, tried in order whenever the
   * active key is exhausted on daily quota or on `MAX_ATTEMPTS` of a
   * transient failure (429/5xx/network) - never on a structural failure
   * (bad key, wrong model, malformed request). Empty or omitted means
   * exactly today's behaviour - one key, fail immediately on exhaustion.
   */
  readonly additionalApiKeys?: readonly string[];
  readonly model?: string;
  /**
   * Injected in tests so retry behaviour can be exercised without real
   * network calls or real waiting.
   */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function readGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return readGeminiApiKeys(env)[0] ?? null;
}

/**
 * `GEMINI_API_KEY`, then `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, ... -
 * numbered, not a fixed-size array, so any number of accounts' keys can be
 * configured. Probing stops at the first missing or blank-after-trim
 * numbered variable; a gap (key 1 and key 3 set, key 2 blank) is treated as
 * "stop here", not "skip and keep going" - a silently-skipped middle key
 * would be a confusing, undebuggable configuration to have working by
 * accident.
 */
export function readGeminiApiKeys(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const keys: string[] = [];

  const first = env[GEMINI_API_KEY_ENV];
  if (first === undefined || first.trim() === '') return keys;
  keys.push(first.trim());

  for (let index = 2; ; index += 1) {
    const value = env[`${GEMINI_API_KEY_ENV}_${index}`];
    if (value === undefined || value.trim() === '') break;
    keys.push(value.trim());
  }

  return keys;
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

/**
 * `'daily-quota-exhausted'` is a structural marker built at the exact call
 * site that already computes `classifyQuotaFailure`'s verdict, so rotation
 * never has to re-derive "was this specifically a daily quota exhaustion"
 * from a generic `CompletionFailure` later. Every other exhausted-key
 * outcome - success, a truncated/refused/blocked answer, or `MAX_ATTEMPTS`
 * of a transient or structural failure - is tagged `'other'`;
 * `reasonToRotate` below is what tells those apart by reading
 * `result.error.retryable` rather than needing a third tag.
 */
type AttemptOutcome =
  | { readonly tag: 'success'; readonly result: CompletionResult }
  | { readonly tag: 'daily-quota-exhausted'; readonly result: CompletionResult & { readonly ok: false } }
  | { readonly tag: 'other'; readonly result: CompletionResult };

/**
 * Null means "return this outcome as-is"; a non-null string is both the
 * signal to rotate and the reason logged when it happens.
 *
 * The line this draws: `retryable: true`/`'daily-quota-exhausted'` means a
 * different key or account could plausibly answer differently (a per-key
 * quota bucket, a per-project rate limit, a transient 5xx that clears
 * eventually) — worth spending a spare key on. Everything else
 * (`retryable: false` or absent: a bad key, a wrong model, a malformed
 * request) would fail identically on every configured key, so rotating
 * would only mask a real configuration mistake as if it were exhaustion,
 * burning through every spare key to confirm the same broken request five
 * more times each.
 */
function reasonToRotate(outcome: AttemptOutcome): string | null {
  if (outcome.tag === 'daily-quota-exhausted') return 'daily quota';
  if (
    outcome.tag === 'other' &&
    !outcome.result.ok &&
    outcome.result.error.kind === 'unavailable' &&
    outcome.result.error.retryable === true
  ) {
    return 'transient failure';
  }
  return null;
}

export function createGeminiProvider(options: GeminiOptions): CompletionProvider {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const keys: readonly string[] = [options.apiKey, ...(options.additionalApiKeys ?? [])];

  /**
   * Whether this model accepts `thinkingConfig`, learned rather than declared.
   *
   * An allowlist was the first attempt and it was wrong within minutes:
   * gemini-3.6-flash and gemini-3.5-flash-lite both reject `thinkingBudget`
   * with a bare 400, and I had guessed the lite model accepted it. A hardcoded
   * table of model capabilities rots every time Google ships a model, and it
   * fails closed in the worst way — a 400 on every single call.
   *
   * So the first rejection flips this off for the lifetime of the provider and
   * the request is retried without it. One wasted call per process, and it
   * stays correct for models that do not exist yet.
   */
  let thinkingConfigSupported = true;

  /**
   * Same-key rotation state, held for the life of this provider - see this
   * file's own header comment for why persisting "key N is exhausted for
   * today" across every call this provider ever serves, rather than
   * resetting per request, is correct: `createProvider` is called once per
   * process (`server.ts`'s `startServer`), so this closure already lives as
   * long as the daily quota window does in practice.
   */
  let activeKeyIndex = 0;

  /** One key's worth of the original attempt loop, unchanged in behaviour, now tagging its own outcome for the rotation loop below to act on. */
  async function attemptWithKey(apiKey: string, request: CompletionRequest): Promise<AttemptOutcome> {
    let lastFailure: CompletionResult | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(`${ENDPOINT}/${model}:generateContent`, {
          method: 'POST',
          headers: {
            // Header, not a query parameter: a URL can end up in a log.
            'x-goog-api-key': apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify(buildRequestBody(request, { withThinkingConfig: thinkingConfigSupported })),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        lastFailure = {
          ok: false,
          // A network-level failure (timeout, DNS, connection reset) is
          // exactly the kind of thing the retry loop already treats as
          // worth another attempt - retryable: true here just makes that
          // existing judgement visible to a caller, not a new one.
          error: { kind: 'unavailable', message: redact(`network error: ${String(cause)}`), retryable: true },
        };
        if (attempt === MAX_ATTEMPTS) return { tag: 'other', result: lastFailure };
        await sleep(backoffFor(attempt, null));
        continue;
      }

      if (response.ok) {
        return { tag: 'success', result: readSuccess(await response.text(), model) };
      }

      const text = redact(await response.text());

      // 429 and 5xx are worth another go; 400/401/403/404 are not — a bad key
      // or a wrong model name will fail identically five times.
      if (response.status === 429) {
        const verdict = classifyQuotaFailure(text);
        if (!verdict.retryable) {
          // The one case this whole field exists for: a daily quota
          // exhaustion, already known internally (it's why this returns
          // immediately instead of continuing the loop) but previously
          // discarded into verdict.detail's message text on the way out.
          // Tagged distinctly - this is the only place key rotation may act.
          return {
            tag: 'daily-quota-exhausted',
            result: { ok: false, error: { kind: 'unavailable', message: verdict.detail, retryable: false } },
          };
        }
        lastFailure = {
          ok: false,
          error: { kind: 'unavailable', message: `${verdict.detail} after ${attempt} attempt(s)`, retryable: true },
        };
        if (attempt === MAX_ATTEMPTS) return { tag: 'other', result: lastFailure };
        await sleep(backoffFor(attempt, verdict.retryAfterMs));
        continue;
      }

      if (response.status >= 500) {
        lastFailure = {
          ok: false,
          error: { kind: 'unavailable', message: `HTTP ${response.status} after ${attempt} attempt(s)`, retryable: true },
        };
        if (attempt === MAX_ATTEMPTS) return { tag: 'other', result: lastFailure };
        await sleep(backoffFor(attempt, null));
        continue;
      }

      // A 400 while sending thinkingConfig is probably the model refusing
      // that parameter. Drop it and try once more before giving up.
      if (response.status === 400 && thinkingConfigSupported && looksLikeThinkingRejection(text)) {
        thinkingConfigSupported = false;
        continue;
      }

      // 401/403/404 land here as 'unavailable' - a bad key or a wrong
      // model name fails identically every time, the same reasoning
      // that already keeps this codepath outside the retry loop above.
      // Tagged 'other', never 'daily-quota-exhausted' - rotating on a bad
      // key would silently mask a real configuration mistake as if it were
      // quota exhaustion, which is not what this feature is for.
      return {
        tag: 'other',
        result:
          response.status === 400
            ? { ok: false, error: { kind: 'refused', message: `HTTP ${response.status}: ${summarise(text)}` } }
            : {
                ok: false,
                error: { kind: 'unavailable', message: `HTTP ${response.status}: ${summarise(text)}`, retryable: false },
              },
      };
    }

    return { tag: 'other', result: lastFailure ?? { ok: false, error: { kind: 'unavailable', message: 'exhausted retries', retryable: true } } };
  }

  return {
    name: `gemini:${model}`,
    model,

    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      for (;;) {
        // Observability: which key answers this call, always logged (index
        // and count only - the key value itself is never logged, same
        // discipline `redact()` enforces on error bodies).
        console.error(`[gemini] using API key ${activeKeyIndex + 1}/${keys.length}`);

        const outcome = await attemptWithKey(keys[activeKeyIndex] as string, request);
        const rotationReason = reasonToRotate(outcome);
        // The `outcome.result.ok` half of this guard is redundant with what
        // `reasonToRotate` already checked internally, but repeated here so
        // TypeScript narrows `outcome.result` to its `{ ok: false }` member
        // below - a function call alone carries no such guarantee for it.
        if (rotationReason === null || outcome.result.ok) return outcome.result;

        if (activeKeyIndex + 1 >= keys.length) {
          const suffix = keys.length > 1 ? ` (all ${keys.length} configured key(s) exhausted)` : '';
          return {
            ok: false,
            error: { ...outcome.result.error, message: `${outcome.result.error.message}${suffix}` },
          };
        }

        console.error(
          `[gemini] key ${activeKeyIndex + 1}/${keys.length} exhausted (${rotationReason}) - rotating to key ${activeKeyIndex + 2}/${keys.length}`,
        );
        activeKeyIndex += 1;
      }
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

function buildRequestBody(
  request: CompletionRequest,
  options: { readonly withThinkingConfig: boolean },
): Record<string, unknown> {
  const budget = thinkingBudgetFor(request.effort);

  const generationConfig: Record<string, unknown> = {
    // The caller's budget bounds the answer; thinking gets its own room on top.
    // When thinkingConfig cannot be sent, assume the model may think anyway and
    // leave the full headroom, because a truncated answer is a wasted call.
    maxOutputTokens:
      request.maxOutputTokens + (options.withThinkingConfig ? budget : THINKING_HEADROOM_TOKENS),
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
   * 46-module repository that is more than a minute of latency for a task that
   * is a lookup.
   *
   * Raised for 'high' effort, which is what intent extraction asks for —
   * deciding whether a sentence carries a checkable obligation is a judgement,
   * and there the thinking earns its cost.
   */
  if (options.withThinkingConfig) {
    generationConfig['thinkingConfig'] = { thinkingBudget: budget };
  }

  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.user }] }],
    generationConfig,
  };
}

/**
 * Does this 400 mean "I do not accept thinkingConfig"?
 *
 * Gemini says only "Request contains an invalid argument", with no field path,
 * so this is necessarily a guess — but a safe one, because the fallback is to
 * retry once without the parameter and the worst case is one wasted call.
 */
function looksLikeThinkingRejection(body: string): boolean {
  return /invalid argument/i.test(body) || /thinking/i.test(body);
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

  /**
   * Truncation, reported as truncation.
   *
   * The JSON is cut off and would fail validation anyway, but "malformed
   * label" or "refused" would both be the wrong story: nothing was refused and
   * nothing was malformed, the answer was simply too long for the budget. A
   * caller counting results needs to know the difference between "the model
   * found nothing" and "we did not let the model finish".
   */
  if (candidate.finishReason === 'MAX_TOKENS') {
    return {
      ok: false,
      error: {
        kind: 'incomplete',
        message: 'the answer was cut off at the output token limit, so nothing from this document was read',
      },
    };
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
