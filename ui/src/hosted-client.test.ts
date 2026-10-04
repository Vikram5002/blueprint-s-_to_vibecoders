import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HostedClient from './hosted-client';

function fakeWindow() {
  const store = new Map<string, string>();
  const events = new EventTarget();
  const calls: { url: string; headers: Headers }[] = [];
  const win = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    location: {
      href: 'https://vibe.example.org/workspace.html',
      origin: 'https://vibe.example.org',
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  };
  return { win, store, calls };
}

let client: typeof HostedClient;
let fake: ReturnType<typeof fakeWindow>;

beforeEach(async () => {
  vi.resetModules();
  fake = fakeWindow();
  vi.stubGlobal('window', fake.win);
  client = await import('./hosted-client');
});

describe('browserId', () => {
  it('is made once and kept', () => {
    const first = client.browserId();
    expect(first).toMatch(/^[0-9a-f]{36}$/);
    expect(client.browserId()).toBe(first);
    expect(fake.store.get('vibe.owner')).toBe(first);
  });
});

describe('apiHeaders', () => {
  it('carries the id always, and the code and own key once set', () => {
    expect(Object.keys(client.apiHeaders())).toEqual(['x-vibe-owner']);
    client.setAccessCode('let-me-in-123');
    client.setOwnKey({ provider: 'groq', apiKey: 'gsk_abc123456', model: 'llama-3.1-8b-instant' });
    expect(client.apiHeaders()).toMatchObject({
      'x-vibe-access': 'let-me-in-123',
      'x-vibe-provider': 'groq',
      'x-vibe-api-key': 'gsk_abc123456',
      'x-vibe-model': 'llama-3.1-8b-instant',
    });
    client.setOwnKey(null);
    expect(client.apiHeaders()['x-vibe-api-key']).toBeUndefined();
  });

  it('ignores a stored key for a provider it does not know', () => {
    fake.store.set('vibe.ownKey', JSON.stringify({ provider: 'ollama', apiKey: 'x' }));
    expect(client.ownKey()).toBeNull();
  });
});

describe('installApiHeaders', () => {
  it("adds the headers to this app's own /api requests only - never to another site", async () => {
    client.setOwnKey({ provider: 'gemini', apiKey: 'AIzaSyEXAMPLE123' });
    client.installApiHeaders();
    await window.fetch('/api/workflow/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    await window.fetch('https://other.example.com/api/steal');
    await window.fetch('/assets/app.js');
    const [own, other, asset] = fake.calls;
    expect(own?.headers.get('x-vibe-api-key')).toBe('AIzaSyEXAMPLE123');
    expect(own?.headers.get('content-type')).toBe('application/json');
    expect(other?.headers.has('x-vibe-api-key')).toBe(false);
    expect(asset?.headers.has('x-vibe-owner')).toBe(false);
  });

  it('announces when the server asks for an access code', async () => {
    fake.win.fetch = vi.fn(
      async () => new Response(JSON.stringify({ needsAccessCode: true }), { status: 401 }),
    );
    client.installApiHeaders();
    const heard = vi.fn();
    window.addEventListener(client.NEEDS_ACCESS_CODE, heard);
    await window.fetch('/api/summary');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
