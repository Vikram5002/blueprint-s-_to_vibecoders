import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api';

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

describe('ApiClient', () => {
  it('asks for one file\'s violations with the path encoded, and sends the access code when set', async () => {
    const fetchImpl = respond(200, { violations: [{ ruleText: 'r', explanation: 'e', evidence: [] }] });
    const api = new ApiClient({ baseUrl: 'http://127.0.0.1:9/', accessCode: ' abc ', fetchImpl });
    expect(await api.violations('src/a b.ts')).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9/api/rework/violations?path=src%2Fa%20b.ts');
    expect(new Headers(init.headers).get('x-vibe-access')).toBe('abc');
  });

  it('posts a rework and returns the server\'s answer', async () => {
    const answer = { path: 'a.ts', violations: [], proposed: 'x', checks: [], unchanged: false };
    const fetchImpl = respond(200, answer);
    const api = new ApiClient({ baseUrl: 'http://h', fetchImpl });
    expect(await api.rework({ path: 'a.ts', source: 'y', instruction: 'z' })).toEqual(answer);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ path: 'a.ts', source: 'y', instruction: 'z' });
    expect(new Headers(init.headers).has('x-vibe-access')).toBe(false);
  });

  it('throws the server\'s own error message', async () => {
    const api = new ApiClient({ baseUrl: 'http://h', fetchImpl: respond(503, { error: 'no model is configured' }) });
    await expect(api.rework({ path: 'a.ts', source: '' })).rejects.toThrow('no model is configured');
    const plain = new ApiClient({ baseUrl: 'http://h', fetchImpl: respond(500, 'boom') });
    await expect(plain.violations('a.ts')).rejects.toThrow('HTTP 500');
  });

  it('says plainly when the server does not answer', async () => {
    const api = new ApiClient({ baseUrl: 'http://h', fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    await expect(api.violations('a.ts')).rejects.toThrow('the VibeCoder server at http://h did not answer (fetch failed)');
  });
});
