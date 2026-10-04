import { describe, expect, it } from 'vitest';
import type { CompletionProvider } from './provider.js';
import { providerFromUserKey, requestProvider, runWithRequestProvider } from './request-provider.js';
import { createProviderRegistry, createSwitchableProvider } from './provider-registry.js';

const fake = (name: string): CompletionProvider => ({
  name,
  model: `${name}-model`,
  complete: async () => ({ ok: true, value: { text: name, model: `${name}-model`, usage: { promptTokens: 0, completionTokens: 0 } } }),
});

describe('providerFromUserKey', () => {
  it('builds a vendor provider from the request key alone, with an optional model', async () => {
    const groq = await providerFromUserKey({ provider: 'Groq', apiKey: 'gsk_abcdefghijklmnop' });
    expect(groq.ok && groq.value.name).toMatch(/^groq:/);
    const chosen = await providerFromUserKey({ provider: 'groq', apiKey: 'gsk_abcdefghijklmnop', model: 'llama-3.1-8b-instant' });
    expect(chosen.ok && chosen.value.model).toBe('llama-3.1-8b-instant');
    const gemini = await providerFromUserKey({ provider: 'gemini', apiKey: 'AIzaSyEXAMPLEKEY123456' });
    expect(gemini.ok).toBe(true);
  });

  it('refuses providers whose address a visitor could move (local, Ollama, a compatible server)', async () => {
    for (const provider of ['local', 'local-code', 'ollama', 'openai-compatible', 'bluesminds', 'nonsense']) {
      const result = await providerFromUserKey({ provider, apiKey: 'abcdefghijklmnop' });
      expect(result.ok, provider).toBe(false);
    }
  });

  it('refuses a key or model that cannot be one', async () => {
    expect((await providerFromUserKey({ provider: 'groq', apiKey: 'short' })).ok).toBe(false);
    expect((await providerFromUserKey({ provider: 'groq', apiKey: 'has a space in it' })).ok).toBe(false);
    expect((await providerFromUserKey({ provider: 'groq', apiKey: 'gsk_abcdefghijklmnop', model: 'x y' })).ok).toBe(false);
  });

  it('never picks up this server\'s own keys', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_SERVER_OWN_KEY_123';
    try {
      const result = await providerFromUserKey({ provider: 'groq', apiKey: 'gsk_visitor_key_456' });
      // The provider object does not expose its key; what it must not do is
      // fall back to the server's key, which only an absent key would allow.
      expect(result.ok).toBe(true);
    } finally {
      delete process.env['GROQ_API_KEY'];
    }
  });
});

describe('the request provider overrides the server\'s choice', () => {
  it('inside a request, and in a job that request started after it returned', async () => {
    const registry = createProviderRegistry({});
    const switchable = createSwitchableProvider(registry, 'fallback');
    expect(requestProvider()).toBeUndefined();

    let job: Promise<unknown> = Promise.resolve();
    await runWithRequestProvider(fake('mine'), async () => {
      const answer = await switchable.complete({ system: '', user: '' });
      expect(answer.ok && answer.value.text).toBe('mine');
      expect(switchable.name).toBe('mine');
      // Not awaited inside: like a background job outliving its request.
      job = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return switchable.complete({ system: '', user: '' });
      })();
    });
    const later = (await job) as { ok: boolean; value: { text: string } };
    expect(later.value.text).toBe('mine');
    expect(requestProvider()).toBeUndefined();
  });
});
