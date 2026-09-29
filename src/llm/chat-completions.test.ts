import { describe, expect, it } from 'vitest';
import { createChatCompletionsProvider, isDailyLimit, type ChatCompletionsOptions } from './chat-completions.js';
import type { CompletionRequest } from './provider.js';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function recordingFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error('no scripted response left');
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: '{"label":"A","description":"b"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  model: 'm',
});

const REQUEST: CompletionRequest = {
  system: 'Name this module.',
  user: 'files...',
  maxOutputTokens: 64,
  schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
};

function options(overrides: Partial<ChatCompletionsOptions>): ChatCompletionsOptions {
  return {
    name: 'svc',
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'secret-key-123456',
    model: 'm',
    retry: { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 1 },
    requestTimeoutMs: 1_000,
    sleep: async () => {},
    ...overrides,
  };
}

describe('createChatCompletionsProvider', () => {
  it('sends no authorization header at all for a keyless local runtime', async () => {
    const { fetchImpl, calls } = recordingFetch([new Response(OK_BODY)]);
    const provider = createChatCompletionsProvider(options({ apiKey: null, fetchImpl }));

    const result = await provider.complete(REQUEST);

    expect(result.ok).toBe(true);
    expect(Object.keys(calls[0]?.init.headers as Record<string, string>)).not.toContain('authorization');
  });

  it('gives up at once on a daily free-tier cap, saying it cannot clear by waiting', async () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached for model on requests per day (RPD): Limit 1000' } });
    const { fetchImpl, calls } = recordingFetch([new Response(body, { status: 429 })]);
    const provider = createChatCompletionsProvider(options({ fetchImpl }));

    const result = await provider.complete(REQUEST);

    expect(calls).toHaveLength(1);
    expect(result.ok === false && result.error.kind).toBe('unavailable');
    if (!result.ok && result.error.kind === 'unavailable') {
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain('daily free limit');
    }
  });

  it('still backs off and retries a per-minute cap', async () => {
    const perMinute = JSON.stringify({ error: { message: 'Rate limit reached on requests per minute (RPM)' } });
    const { fetchImpl, calls } = recordingFetch([new Response(perMinute, { status: 429 }), new Response(OK_BODY)]);
    const provider = createChatCompletionsProvider(options({ fetchImpl }));

    expect((await provider.complete(REQUEST)).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('states the schema in the system prompt once the service refuses to enforce it', async () => {
    const rejection = new Response('{"error":{"message":"response_format json_schema is not supported"}}', { status: 400 });
    const { fetchImpl, calls } = recordingFetch([rejection, new Response(OK_BODY)]);
    const provider = createChatCompletionsProvider(options({ fetchImpl }));

    const result = await provider.complete(REQUEST);

    expect(result.ok && result.value.schemaDowngraded).toBe(true);
    const first = JSON.parse(String(calls[0]?.init.body)) as { messages: { content: string }[] };
    const second = JSON.parse(String(calls[1]?.init.body)) as {
      messages: { content: string }[];
      response_format: { type: string };
    };
    expect(first.messages[0]?.content).toBe('Name this module.');
    expect(second.response_format.type).toBe('json_object');
    expect(second.messages[0]?.content).toContain('matching this JSON schema exactly');
    expect(second.messages[0]?.content).toContain('"required":["label"]');
  });
});

describe('isDailyLimit', () => {
  it.each([
    'Rate limit reached for model on requests per day (RPD)',
    'Rate limit exceeded: free-models-per-day',
    'Rate limit of 150 per 86400s exceeded for UserByModelByDay',
    'You have exceeded your daily quota',
  ])('recognises %s', (body) => {
    expect(isDailyLimit(body)).toBe(true);
  });

  it.each(['Rate limit reached on requests per minute (RPM)', 'Too many requests', 'rate limited'])(
    'does not treat %s as daily',
    (body) => {
      expect(isDailyLimit(body)).toBe(false);
    },
  );
});
