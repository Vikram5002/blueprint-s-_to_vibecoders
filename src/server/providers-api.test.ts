import { describe, expect, it } from 'vitest';
import { createProviderRoutes } from './providers-api.js';
import { createProviderRegistry } from '../llm/provider-registry.js';

const refused = (async () => {
  throw new Error('ECONNREFUSED');
}) as typeof fetch;

function routes(initial: string | null, onSelect?: (provider: string) => void) {
  const registry = createProviderRegistry({
    env: { GEMINI_API_KEY: 'g-key' } as NodeJS.ProcessEnv,
    initial,
    fetchImpl: refused,
    ...(onSelect === undefined ? {} : { onSelect }),
  });
  return { app: createProviderRoutes({ registry }), registry };
}

describe('GET /api/providers', () => {
  it('reports the current selection alongside every selectable provider and its availability', async () => {
    const { app } = routes(null);
    const response = await app.request('/');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      current: string;
      providers: { id: string; available: boolean; detail: string; model: string }[];
    };
    expect(body.current).toBe('gemini');
    expect(body.providers.map((entry) => entry.id)).toEqual(['gemini', 'local', 'anthropic', 'bluesminds']);
    expect(body.providers.find((entry) => entry.id === 'gemini')?.available).toBe(true);
    expect(body.providers.find((entry) => entry.id === 'local')?.available).toBe(false);
    // Every entry names a real model, so the picker can say what it would run.
    expect(body.providers.every((entry) => entry.model.length > 0)).toBe(true);
  });
});

describe('POST /api/providers', () => {
  it('switches the selection and reports the new state back', async () => {
    const { app, registry } = routes(null);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'local' }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { current: string }).current).toBe('local');
    expect(registry.current()).toBe('local');
  });

  it('persists the switch through the registry\'s own callback, so it survives a restart', async () => {
    const saved: string[] = [];
    const { app } = routes(null, (provider) => saved.push(provider));
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'local' }),
    });
    expect(saved).toEqual(['local']);
  });

  it('allows selecting a provider that is not up yet, and warns instead of refusing', async () => {
    // Someone about to start their local server must be able to pick it
    // first; a refusal would report a transient probe as a permanent fact.
    const { app } = routes(null);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'local' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { current: string; warning?: string };
    expect(body.current).toBe('local');
    expect(body.warning).toContain('local_inference_server.py');
  });

  it('rejects an unknown provider name rather than silently ignoring it', async () => {
    const { app, registry } = routes(null);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    });

    expect(response.status).toBe(400);
    expect(registry.current()).toBe('gemini');
  });

  it('points the local provider at a tunnel URL, without needing a provider field', async () => {
    const { app, registry } = routes(null);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localBaseUrl: 'https://abc-def.trycloudflare.com' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { localBaseUrl: string; current: string };
    expect(body.localBaseUrl).toBe('https://abc-def.trycloudflare.com');
    // A URL-only update must not disturb which provider is selected.
    expect(body.current).toBe('gemini');
    expect(registry.localBaseUrl()).toBe('https://abc-def.trycloudflare.com');
  });

  it('accepts the tunnel URL and the switch to it in ONE request - no window where local points at a dead origin', async () => {
    const { app, registry } = routes(null);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'local', localBaseUrl: 'https://abc-def.trycloudflare.com' }),
    });

    expect(response.status).toBe(200);
    expect(registry.current()).toBe('local');
    expect(registry.localBaseUrl()).toBe('https://abc-def.trycloudflare.com');
  });

  it('rejects a URL that is not http(s) and changes nothing', async () => {
    const { app, registry } = routes(null);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'local', localBaseUrl: 'localhost:8712' }),
    });

    expect(response.status).toBe(400);
    expect(registry.current()).toBe('gemini');
    expect(registry.localBaseUrl()).toBe('http://127.0.0.1:8712');
  });

  it('reports the current local origin on GET, so the picker can show what it will talk to', async () => {
    const { app } = routes(null);
    const body = (await (await app.request('/')).json()) as { localBaseUrl: string };
    expect(body.localBaseUrl).toBe('http://127.0.0.1:8712');
  });

  it('rejects a malformed body without throwing', async () => {
    const { app } = routes(null);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('code-generation override over /api/providers', () => {
  const post = (app: ReturnType<typeof routes>['app'], body: unknown) =>
    app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('reports no override (null) by default', async () => {
    const { app } = routes('local');
    expect(((await (await app.request('/')).json()) as { codeProvider: unknown }).codeProvider).toBeNull();
  });

  it('sets the override on its own, without touching the plan provider', async () => {
    const { app, registry } = routes('local');
    const response = await post(app, { codeProvider: 'gemini' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { codeProvider: string }).codeProvider).toBe('gemini');
    expect(registry.current()).toBe('local');
    expect(registry.currentCode()).toBe('gemini');
  });

  it("clears the override with 'same'", async () => {
    const { app, registry } = routes('local');
    await post(app, { codeProvider: 'gemini' });
    await post(app, { codeProvider: 'same' });
    expect(registry.codeSelection()).toBeNull();
  });

  it('rejects an unknown code provider and changes nothing', async () => {
    const { app, registry } = routes('local');
    expect((await post(app, { codeProvider: 'nope' })).status).toBe(400);
    expect(registry.codeSelection()).toBeNull();
  });
});
