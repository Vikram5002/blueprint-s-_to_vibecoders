import { describe, expect, it } from 'vitest';
import {
  backoffFor,
  classifyQuotaFailure,
  createGeminiProvider,
  DEFAULT_GEMINI_MODEL,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  readGeminiApiKey,
  redact,
  thinkingBudgetFor,
} from './gemini.js';
import { chooseProvider, DEFAULT_PROVIDER } from './select-provider.js';
import { isFreeModel, isPricedModel } from './pricing.js';
import { loadEnvFile, describeKeySource } from './env-file.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'AIzaTESTKEYVALUE1234567890abcdefghij';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: '{"label":"Source Parsing","description":"Parses files."}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
};

const RATE_LIMIT_PER_MINUTE = {
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '10s' },
    ],
  },
};

const RATE_LIMIT_PER_DAY = {
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
      },
    ],
  },
};

const request = {
  system: 'You name modules.',
  user: 'Module at src/parser/.',
  maxOutputTokens: 256,
};

describe('the key never leaks', () => {
  it('sends the key in a header, never in the URL', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async (url, init) => {
        seenUrl = String(url);
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return jsonResponse(OK_BODY);
      }) as typeof fetch,
    });

    await provider.complete(request);
    expect(seenUrl).not.toContain(SECRET);
    expect(seenUrl).not.toContain('key=');
    expect(seenHeaders['x-goog-api-key']).toBe(SECRET);
  });

  it('redacts anything key-shaped out of an error body', () => {
    expect(redact(`bad key ${SECRET} here`)).toBe('bad key [REDACTED] here');
  });

  it('never returns the key in a failure message', async () => {
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: `API key ${SECRET} is invalid` } }), { status: 400 })) as typeof fetch,
    });

    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reads the key from the environment, treating blank as absent', () => {
    expect(readGeminiApiKey({ GEMINI_API_KEY: ' abc ' })).toBe('abc');
    expect(readGeminiApiKey({ GEMINI_API_KEY: '   ' })).toBeNull();
    expect(readGeminiApiKey({})).toBeNull();
  });
});

describe('request mapping', () => {
  it('maps system, user and temperature into the Gemini shape', async () => {
    let body: Record<string, never> = {} as never;
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(OK_BODY);
      }) as typeof fetch,
    });

    await provider.complete({ ...request, temperature: 0 });

    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: 'You name modules.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Module at src/parser/.' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
    });
  });

  it('omits temperature when the caller did not set one', async () => {
    let body: { generationConfig?: Record<string, unknown> } = {};
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(OK_BODY);
      }) as typeof fetch,
    });

    await provider.complete(request);
    expect(body.generationConfig).not.toHaveProperty('temperature');
  });

  it('strips schema keywords Gemini rejects, without touching the schema itself', async () => {
    let body: { generationConfig?: { responseSchema?: Record<string, unknown> } } = {};
    const schema = {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
      additionalProperties: false,
    } as const;

    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(OK_BODY);
      }) as typeof fetch,
    });

    await provider.complete({ ...request, schema });

    expect(body.generationConfig?.responseSchema).toEqual({
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    });
    // The caller's schema object is untouched, so Anthropic still gets it whole.
    expect(schema.additionalProperties).toBe(false);
  });

  it('spends no thinking budget on a lookup, and some on a judgement', () => {
    expect(thinkingBudgetFor(undefined)).toBe(0);
    expect(thinkingBudgetFor('low')).toBe(0);
    expect(thinkingBudgetFor('medium')).toBeGreaterThan(0);
    expect(thinkingBudgetFor('high')).toBeGreaterThan(thinkingBudgetFor('medium'));
  });

  it('does not send thinkingConfig to a model that rejects it', async () => {
    // gemini-3.6-flash returns 400 for thinkingBudget: 0.
    let body: { generationConfig?: Record<string, unknown> } = {};
    const provider = createGeminiProvider({
      apiKey: SECRET,
      model: 'gemini-3.6-flash',
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(OK_BODY);
      }) as typeof fetch,
    });

    await provider.complete(request);
    expect(body.generationConfig).not.toHaveProperty('thinkingConfig');
  });
});

describe('reading the response', () => {
  it('returns the text and counts thinking tokens as output', async () => {
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async () => jsonResponse(OK_BODY)) as typeof fetch,
    });

    const result = await provider.complete(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain('Source Parsing');
    expect(result.value.usage.promptTokens).toBe(100);
    // 20 visible + 5 thinking: reporting only the visible answer understates it.
    expect(result.value.usage.completionTokens).toBe(25);
  });

  it('reports a truncated response as such rather than as a bad label', async () => {
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async () =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: '{"label":"Sour' }] }, finishReason: 'MAX_TOKENS' }] })) as typeof fetch,
    });

    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('output token limit');
  });

  it('reports a safety block as a refusal', async () => {
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } })) as typeof fetch,
    });

    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('refused');
  });

  it('does not throw on a malformed body', async () => {
    const provider = createGeminiProvider({
      apiKey: SECRET,
      fetchImpl: (async () => new Response('not json', { status: 200 })) as typeof fetch,
    });
    await expect(provider.complete(request)).resolves.toMatchObject({ ok: false });
  });
});

describe('rate limits are retried, never swallowed', () => {
  it('classifies a per-minute limit as retryable and honours the server delay', () => {
    const verdict = classifyQuotaFailure(JSON.stringify(RATE_LIMIT_PER_MINUTE));
    expect(verdict.retryable).toBe(true);
    expect(verdict.retryAfterMs).toBe(10_000);
  });

  it('refuses to retry a daily exhaustion, which cannot clear', () => {
    const verdict = classifyQuotaFailure(JSON.stringify(RATE_LIMIT_PER_DAY));
    expect(verdict.retryable).toBe(false);
    expect(verdict.detail).toContain('daily');
  });

  it('retries a per-minute limit and succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const provider = createGeminiProvider({
      apiKey: SECRET,
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: (async () => {
        calls += 1;
        return calls < 3 ? jsonResponse(RATE_LIMIT_PER_MINUTE, 429) : jsonResponse(OK_BODY);
      }) as typeof fetch,
    });

    const result = await provider.complete(request);
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    // Server said 10s, so that is what was waited — not our guess.
    expect(waits).toEqual([10_000, 10_000]);
  });

  it('gives up on a daily limit immediately instead of sleeping through it', async () => {
    const waits: number[] = [];
    let calls = 0;
    const provider = createGeminiProvider({
      apiKey: SECRET,
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(RATE_LIMIT_PER_DAY, 429);
      }) as typeof fetch,
    });

    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('fails loudly after exhausting attempts, never silently', async () => {
    let calls = 0;
    const provider = createGeminiProvider({
      apiKey: SECRET,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(RATE_LIMIT_PER_MINUTE, 429);
      }) as typeof fetch,
    });

    const result = await provider.complete(request);
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/rate limited/);
  });

  it('retries a 5xx but not a 400', async () => {
    let serverErrorCalls = 0;
    const flaky = createGeminiProvider({
      apiKey: SECRET,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        serverErrorCalls += 1;
        return serverErrorCalls < 2 ? new Response('boom', { status: 503 }) : jsonResponse(OK_BODY);
      }) as typeof fetch,
    });
    await expect(flaky.complete(request)).resolves.toMatchObject({ ok: true });
    expect(serverErrorCalls).toBe(2);

    let badRequestCalls = 0;
    const broken = createGeminiProvider({
      apiKey: SECRET,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        badRequestCalls += 1;
        return jsonResponse({ error: { message: 'invalid argument' } }, 400);
      }) as typeof fetch,
    });
    await expect(broken.complete(request)).resolves.toMatchObject({ ok: false });
    // A bad request fails identically five times; retrying only wastes time.
    expect(badRequestCalls).toBe(1);
  });

  it('retries a network error', async () => {
    let calls = 0;
    const provider = createGeminiProvider({
      apiKey: SECRET,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 2) throw new Error('ECONNRESET');
        return jsonResponse(OK_BODY);
      }) as typeof fetch,
    });
    await expect(provider.complete(request)).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(2);
  });

  it('backs off exponentially, capped', () => {
    expect(backoffFor(1, null)).toBe(1_000);
    expect(backoffFor(2, null)).toBe(2_000);
    expect(backoffFor(3, null)).toBe(4_000);
    expect(backoffFor(50, null)).toBe(MAX_BACKOFF_MS);
    expect(backoffFor(1, 10_000)).toBe(10_000);
    expect(backoffFor(1, 999_999)).toBe(MAX_BACKOFF_MS);
  });
});

describe('provider selection', () => {
  it('defaults to Gemini, because it is free', () => {
    expect(DEFAULT_PROVIDER).toBe('gemini');
    const choice = chooseProvider({ GEMINI_API_KEY: 'k' });
    expect(choice.provider).toBe('gemini');
    expect(choice.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('switches to Anthropic on request, keeping it wired', () => {
    const choice = chooseProvider({ VIBE_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' });
    expect(choice.provider).toBe('anthropic');
    expect(choice.model).toBe('claude-haiku-4-5');
  });

  it('does not pick a provider by which key happens to be set', () => {
    // Both keys present: the choice must still be the declared default, not an
    // accident of the machine's environment.
    const choice = chooseProvider({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' });
    expect(choice.provider).toBe('gemini');
  });

  it('reports no key rather than failing', () => {
    expect(chooseProvider({}).apiKey).toBeNull();
    expect(chooseProvider({}).keyEnv).toBe('GEMINI_API_KEY');
  });

  it('honours a model override per provider', () => {
    expect(chooseProvider({ VIBE_LLM_MODEL: 'gemini-3.6-flash' }).model).toBe('gemini-3.6-flash');
    expect(chooseProvider({ VIBE_LLM_PROVIDER: 'anthropic', VIBE_LLM_MODEL: 'claude-opus-5' }).model).toBe(
      'claude-opus-5',
    );
  });
});

describe('pricing', () => {
  it('treats Gemini as free rather than as unknown', () => {
    expect(isPricedModel(DEFAULT_GEMINI_MODEL)).toBe(true);
    expect(isFreeModel(DEFAULT_GEMINI_MODEL)).toBe(true);
    expect(isFreeModel('claude-haiku-4-5')).toBe(false);
    expect(isFreeModel('some-model-nobody-priced')).toBe(false);
  });
});

describe('.env loading', () => {
  it('loads names without clobbering a real environment variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-env-'));
    writeFileSync(join(dir, '.env'), '# comment\nGEMINI_API_KEY="fromfile"\nOTHER=plain\n', 'utf8');

    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'preset' };
    const loaded = loadEnvFile(dir, env);

    expect(env['GEMINI_API_KEY']).toBe('preset');
    expect(env['OTHER']).toBe('plain');
    expect(loaded).toEqual(['OTHER']);
  });

  it('returns nothing when there is no .env', () => {
    expect(loadEnvFile(mkdtempSync(join(tmpdir(), 'vibe-env-')), {})).toEqual([]);
  });

  it('describes where a key came from without revealing it', () => {
    const env = { GEMINI_API_KEY: SECRET };
    const described = describeKeySource('GEMINI_API_KEY', ['GEMINI_API_KEY'], env);
    expect(described).toBe('from .env');
    expect(described).not.toContain(SECRET);
    expect(describeKeySource('GEMINI_API_KEY', [], {})).toBe('not set');
  });
});
