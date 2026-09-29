import { describe, expect, it } from 'vitest';
import { createLocalProvider } from './local.js';

const REQUEST = { system: 's', user: 'u', maxOutputTokens: 8 };

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
