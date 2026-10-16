import { describe, expect, it } from 'vitest';
import { createLocalProvider, reportedLocalLabel } from './local.js';

const REQUEST = { system: 's', user: 'u', maxOutputTokens: 8 };

it('uses a reported desktop model label, preserving quantization and adapter identity', async () => {
  const label = 'local:qwen+run_20260822_130636+gguf-q4_k_m-f16';
  const probe = (async () => new Response(JSON.stringify({ models: [{ name: 'local', base: 'qwen', adapter: 'a', label }], default: 'local' }))) as typeof fetch;
  expect(await reportedLocalLabel('http://127.0.0.1:8712', 'local:fallback', probe)).toBe(label);
  expect(await reportedLocalLabel('http://127.0.0.1:8712', 'local-code:fallback', probe)).toBe('local-code:fallback');
  const offline = (async () => { throw new Error('offline'); }) as typeof fetch;
  expect(await reportedLocalLabel('http://127.0.0.1:8712', 'local:fallback', offline)).toBe('local:fallback');
});

function answering(response: () => Response): { fetchImpl: typeof fetch; bodies: unknown[]; urls: string[] } {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)));
    return response();
  }) as typeof fetch;
  return { fetchImpl, bodies, urls };
}

describe('createLocalProvider', () => {
  it("posts to <baseUrl>/complete and names the served model by its label's prefix", async () => {
    const ok = { ok: true, value: { text: 'hi', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 }, model: 'local-code' } };
    const { fetchImpl, bodies, urls } = answering(() => new Response(JSON.stringify(ok)));
    const provider = createLocalProvider({ baseUrl: 'https://gpu.example', model: 'local-code:qwen2.5-coder-7b-instruct+code-adapter', fetchImpl });

    const result = await provider.complete(REQUEST);

    expect(result.ok).toBe(true);
    expect(urls).toEqual(['https://gpu.example/complete']);
    expect((bodies[0] as { model: string }).model).toBe('local-code');
  });

  it('says no server is answering when a sleeping cloud session answers with its own page', async () => {
    const { fetchImpl } = answering(() => new Response('<html>Studio is sleeping</html>', { status: 404 }));
    const provider = createLocalProvider({ baseUrl: 'https://8712-abc.cloudspaces.example', fetchImpl });

    const result = await provider.complete(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unavailable');
      expect(result.error.message).toContain('no inference server is answering at https://8712-abc.cloudspaces.example');
      expect(result.error.message).toContain('wake the cloud GPU session');
    }
  });
});
