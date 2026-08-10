import { describe, expect, it } from 'vitest';
import {
  backoffFor,
  createBluesmindsProvider,
  DEFAULT_BLUESMINDS_MODEL,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  readBluesmindsApiKey,
  redact,
} from './bluesminds.js';
import type { CompletionRequest } from './provider.js';

const KEY = 'sk-secret-token-value-0123456789';

const SCHEMA = {
  type: 'object',
  properties: { label: { type: 'string' } },
  required: ['label'],
  additionalProperties: false,
} as const;

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: 'You name modules.',
    user: 'src/parser/parse.ts',
    maxOutputTokens: 256,
    schema: SCHEMA,
    ...overrides,
  };
}

/** A chat-completions response, with only the parts under test varied. */
function completion(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'meta/llama-3.3-70b-instruct',
    choices: [{ message: { content: '{"label":"parser"}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 65, completion_tokens: 21 },
    ...overrides,
  });
}

function stub(
  responses: { status?: number; body: string; headers?: Record<string, string> }[],
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(next?.body ?? '', {
      status: next?.status ?? 200,
      headers: next?.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const noSleep = async (): Promise<void> => undefined;

// ---------------------------------------------------------------- the key

describe('the key never leaks', () => {
  it('goes in an Authorization header, never in the URL', async () => {
    const { fetchImpl, calls } = stub([{ body: completion() }]);
    await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());

    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.url).toBe('https://api.bluesminds.com/v1/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`);
  });

  it('is stripped from an error body that echoes it back', async () => {
    // Some gateways include the received request in their error payload.
    const { fetchImpl } = stub([{ status: 400, body: `bad request with Bearer ${KEY} attached` }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(KEY);
      expect(result.error.message).toContain('[REDACTED]');
    }
  });

  it('redacts by exact value, since this token has no matchable shape', () => {
    // Unlike Google's AIza… prefix, there is nothing to pattern-match here.
    expect(redact(`leak: ${KEY}`, KEY)).toBe('leak: [REDACTED]');
    expect(redact('Authorization: Bearer abcdef123456789', '')).toContain('[REDACTED]');
  });

  it('reads the key from the environment, treating blank as absent', () => {
    expect(readBluesmindsApiKey({ BLUESMINDS_API_KEY: ' k ' })).toBe('k');
    expect(readBluesmindsApiKey({ BLUESMINDS_API_KEY: '   ' })).toBeNull();
    expect(readBluesmindsApiKey({})).toBeNull();
  });
});

// ---------------------------------------------------------------- the schema

describe('the output schema actually reaches the provider', () => {
  /**
   * The Week 11 lesson, written as a test.
   *
   * The labeller once omitted its schema and the Anthropic adapter silently
   * substituted a default. When a second provider arrived it received no
   * schema at all, returned a differently-named field, and every module in the
   * run was rejected as `missing-label` — a total failure that looked like a
   * bad model rather than a missing parameter. A new provider gets this
   * checked on the wire, not assumed.
   */
  it('sends the caller’s schema verbatim in response_format', async () => {
    const { fetchImpl, calls } = stub([{ body: completion() }]);
    await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());

    const format = bodyOf(calls[0] as { init: RequestInit })['response_format'] as {
      type: string;
      json_schema: { strict: boolean; schema: unknown };
    };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema).toEqual(SCHEMA);
  });

  it('substitutes no schema of its own when the caller sends none', async () => {
    const { fetchImpl, calls } = stub([{ body: completion() }]);
    await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(
      request({ schema: undefined }),
    );
    expect(bodyOf(calls[0] as { init: RequestInit })['response_format']).toBeUndefined();
  });

  it('sends the model, messages and token budget as the API expects', async () => {
    const { fetchImpl, calls } = stub([{ body: completion() }]);
    await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(
      request({ temperature: 0 }),
    );

    const body = bodyOf(calls[0] as { init: RequestInit });
    expect(body['model']).toBe(DEFAULT_BLUESMINDS_MODEL);
    expect(body['max_tokens']).toBe(256);
    expect(body['temperature']).toBe(0);
    expect(body['messages']).toEqual([
      { role: 'system', content: 'You name modules.' },
      { role: 'user', content: 'src/parser/parse.ts' },
    ]);
  });

  it('falls back to plain JSON when the model rejects the schema, and says so', async () => {
    const { fetchImpl, calls } = stub([
      { status: 400, body: '{"error":{"message":"response_format is not supported"}}' },
      { body: completion() },
    ]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl, sleep: noSleep }).complete(
      request(),
    );

    expect(result.ok).toBe(true);
    // Second attempt asked for json_object rather than a schema.
    expect(bodyOf(calls[1] as { init: RequestInit })['response_format']).toEqual({ type: 'json_object' });
    // And the downgrade is reported, not swallowed — output quality now has a
    // different explanation than the model.
    if (result.ok) expect(result.value.schemaDowngraded).toBe(true);
  });
});

// ---------------------------------------------------------------- truncation

describe('truncation is never a silent success', () => {
  /**
   * The brief said to assume a new provider has the silent-truncation bug
   * until proven otherwise. This gateway surfaces it in the worst possible
   * form, observed live on `nemotron-super-49b`: HTTP 200, finish_reason
   * "length", and an entirely empty message, having spent the whole budget
   * reasoning. Without this check that is indistinguishable from "the model
   * had nothing to say".
   */
  it('reports finish_reason=length as incomplete, not as a result', async () => {
    const { fetchImpl } = stub([
      {
        body: completion({
          choices: [{ message: { content: '{"label":"par' }, finish_reason: 'length' }],
        }),
      },
    ]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('incomplete');
      expect(result.error.message).toContain('cut off');
    }
  });

  it('catches the 200-with-empty-content case seen in the wild', async () => {
    const { fetchImpl } = stub([
      { body: completion({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) },
    ]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('incomplete');
      expect(result.error.message).toContain('no content was returned at all');
    }
  });

  it('accepts the gateway spelling max_tokens as well as length', async () => {
    const { fetchImpl } = stub([
      { body: completion({ choices: [{ message: { content: 'x' }, finish_reason: 'max_tokens' }] }) },
    ]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());
    expect(result.ok === false && result.error.kind).toBe('incomplete');
  });

  it('does not call an ordinary stop truncated', async () => {
    // Otherwise every answer would read as a budget problem and the
    // distinction would be worthless.
    const { fetchImpl } = stub([{ body: completion() }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());
    expect(result.ok).toBe(true);
  });

  it('separates an empty answer from a truncated one', async () => {
    const { fetchImpl } = stub([
      { body: completion({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }) },
    ]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());
    expect(result.ok === false && result.error.kind).toBe('refused');
  });
});

// ---------------------------------------------------------------- failures

describe('failure handling', () => {
  it('names an end-of-life model precisely instead of looking like a typo', async () => {
    /**
     * Four of the eleven models probed for this adapter were listed by
     * GET /v1/models and answered 410. A bare "HTTP 410" would send someone
     * hunting for a misspelling that is not there.
     */
    const { fetchImpl, calls } = stub([
      {
        status: 410,
        body: '{"error":{"message":"The model has reached its end of life on 2026-08-07."}}',
      },
    ]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl, sleep: noSleep }).complete(
      request(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unavailable');
      expect(result.error.message).toContain('end-of-life');
      expect(result.error.message).toContain('still listed by GET /v1/models');
    }
    // Non-retryable: waiting cannot bring a retired model back.
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 and honours Retry-After', async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = stub([
      { status: 429, body: 'slow down', headers: { 'retry-after': '2' } },
      { body: completion() },
    ]);
    const result = await createBluesmindsProvider({
      apiKey: KEY,
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    }).complete(request());

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBe(2_000);
  });

  it('retries a 5xx and gives up after the attempt limit', async () => {
    const { fetchImpl, calls } = stub([{ status: 503, body: 'upstream down' }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl, sleep: noSleep }).complete(
      request(),
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  it('does not retry a 400, which will fail identically every time', async () => {
    const { fetchImpl, calls } = stub([{ status: 400, body: 'malformed' }]);
    await createBluesmindsProvider({ apiKey: KEY, fetchImpl, sleep: noSleep }).complete(
      request({ schema: undefined }),
    );
    expect(calls).toHaveLength(1);
  });

  it('treats a 200 carrying an error object as a refusal', async () => {
    // Observed shape on OpenAI-compatible gateways: HTTP 200, error in body.
    const { fetchImpl } = stub([{ body: '{"error":{"message":"No connected db."}}' }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('No connected db.');
  });

  it('survives a body that is not JSON at all', async () => {
    const { fetchImpl } = stub([{ body: '<html>504 Gateway Time-out</html>' }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());
    expect(result.ok === false && result.error.kind).toBe('refused');
  });

  it('reports a network error rather than throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl, sleep: noSleep }).complete(
      request(),
    );
    expect(result.ok === false && result.error.kind).toBe('unavailable');
  });
});

// ---------------------------------------------------------------- reporting

describe('what it reports back', () => {
  it('reports the model the gateway says served the request', async () => {
    /**
     * The whole provenance problem in one field: a gateway may route to
     * something other than the model asked for, and the only honest thing to
     * do is report what it says it used rather than what we requested.
     */
    const { fetchImpl } = stub([{ body: completion({ model: 'meta/llama-3.3-70b-instruct-turbo' }) }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());
    expect(result.ok && result.value.model).toBe('meta/llama-3.3-70b-instruct-turbo');
  });

  it('falls back to the requested model when the gateway names none', async () => {
    const { fetchImpl } = stub([{ body: completion({ model: undefined }) }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());
    expect(result.ok && result.value.model).toBe(DEFAULT_BLUESMINDS_MODEL);
  });

  it('reports token usage, defaulting to zero rather than guessing', async () => {
    const { fetchImpl } = stub([{ body: completion({ usage: undefined }) }]);
    const result = await createBluesmindsProvider({ apiKey: KEY, fetchImpl }).complete(request());
    expect(result.ok && result.value.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
    });
  });

  it('identifies itself by provider and pinned model', () => {
    const provider = createBluesmindsProvider({ apiKey: KEY });
    expect(provider.name).toBe(`bluesminds:${DEFAULT_BLUESMINDS_MODEL}`);
    expect(provider.model).toBe(DEFAULT_BLUESMINDS_MODEL);
  });

  it('pins an exact model string rather than a floating alias', () => {
    // A gateway alias that repoints would silently mix two models' answers in
    // one cache file, which is keyed on the model string.
    expect(DEFAULT_BLUESMINDS_MODEL).not.toMatch(/latest|newest|stable|\*/);
  });
});

describe('backoff', () => {
  it('spans the measured rate-limit window, not the Gemini default', () => {
    // The gateway sends no Retry-After and no x-ratelimit headers, so backoff
    // is the only lever. The window was measured at ~90s; 5 attempts over 15s
    // lost 9 of 24 calls on a real run.
    const total = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => backoffFor(i + 1, null)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(90_000);
  });

  it('doubles, caps, and defers to the server when told', () => {
    expect(backoffFor(1, null)).toBe(4_000);
    expect(backoffFor(3, null)).toBe(16_000);
    expect(backoffFor(50, null)).toBe(MAX_BACKOFF_MS);
    expect(backoffFor(1, 5_000)).toBe(5_000);
    expect(backoffFor(1, 999_999)).toBe(MAX_BACKOFF_MS);
  });
});
