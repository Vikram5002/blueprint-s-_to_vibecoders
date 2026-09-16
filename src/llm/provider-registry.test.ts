import { describe, expect, it, vi } from 'vitest';
import {
  createProviderRegistry,
  createSwitchableProvider,
  probeLocalServer,
  PROVIDER_SETTING_KEY,
  SELECTABLE_PROVIDERS,
} from './provider-registry.js';
import type { CompletionProvider, CompletionResult } from './provider.js';

const GEMINI_ENV = { GEMINI_API_KEY: 'g-key' } as NodeJS.ProcessEnv;

/** Any HTTP answer at all means a server is listening; only a transport failure means it is not. */
const reachable = (async () => new Response('not found', { status: 404 })) as typeof fetch;
const refused = (async () => {
  throw new Error('ECONNREFUSED');
}) as typeof fetch;

function stubProvider(name: string, respond: () => CompletionResult): CompletionProvider {
  return { name, model: name, complete: async () => respond() };
}

describe('createProviderRegistry', () => {
  it('starts on the environment default when nothing was ever persisted', () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: null });
    expect(registry.current()).toBe('gemini');
  });

  it('restores a persisted choice in preference to the environment default', () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: 'local' });
    expect(registry.current()).toBe('local');
  });

  it('ignores a persisted value this build does not recognise rather than trusting the database', () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: 'openai-from-some-future-version' });
    expect(registry.current()).toBe('gemini');
  });

  it('persists a real change exactly once, and never on a no-op re-selection', () => {
    const saved: string[] = [];
    const registry = createProviderRegistry({
      env: GEMINI_ENV,
      initial: null,
      onSelect: (provider) => saved.push(provider),
    });

    expect(registry.select('local')).toBe(true);
    expect(registry.select('local')).toBe(true); // same value again
    expect(registry.current()).toBe('local');
    expect(saved).toEqual(['local']);
  });

  it('refuses an unknown provider name and leaves the selection untouched', () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: null });
    expect(registry.select('openai' as never)).toBe(false);
    expect(registry.current()).toBe('gemini');
  });

  it('reports every selectable provider, with availability read from real configuration', async () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: null, fetchImpl: refused });
    const status = await registry.status();

    expect(status.map((entry) => entry.id)).toEqual([...SELECTABLE_PROVIDERS]);

    const gemini = status.find((entry) => entry.id === 'gemini');
    expect(gemini?.available).toBe(true);
    expect(gemini?.detail).toContain('GEMINI_API_KEY');

    // No key set for these in this env.
    expect(status.find((entry) => entry.id === 'anthropic')?.available).toBe(false);

    // Nothing listening locally.
    const local = status.find((entry) => entry.id === 'local');
    expect(local?.available).toBe(false);
    expect(local?.detail).toContain('local_inference_server.py');
  });

  it('reports local as available the moment something answers on its port - a 404 counts, since the real server has no health route', async () => {
    const registry = createProviderRegistry({ env: {}, initial: null, fetchImpl: reachable });
    const local = (await registry.status()).find((entry) => entry.id === 'local');
    expect(local?.available).toBe(true);
    expect(local?.detail).toContain('Reachable');
  });

  it('reads each provider\'s OWN key and model when reporting, not the selected one\'s', async () => {
    const registry = createProviderRegistry({
      env: { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' } as NodeJS.ProcessEnv,
      initial: 'gemini',
      fetchImpl: refused,
    });
    const status = await registry.status();
    expect(status.find((entry) => entry.id === 'anthropic')?.available).toBe(true);
    // Distinct models, so nothing is leaking the selected provider's identity.
    const models = new Set(status.map((entry) => entry.model));
    expect(models.size).toBe(SELECTABLE_PROVIDERS.length);
  });

  it('exposes the settings key it persists under, so the server does not hardcode a second copy of it', () => {
    expect(PROVIDER_SETTING_KEY).toBe('llm.provider');
  });
});

describe('probeLocalServer', () => {
  it('treats any HTTP response as "a server is listening"', async () => {
    await expect(probeLocalServer('http://127.0.0.1:8712', reachable)).resolves.toBe(true);
  });

  it('treats a transport failure as "not running"', async () => {
    await expect(probeLocalServer('http://127.0.0.1:8712', refused)).resolves.toBe(false);
  });
});

describe('createSwitchableProvider', () => {
  it('dispatches to whichever provider is selected at the time of the call', async () => {
    const calls: string[] = [];
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: null });
    vi.spyOn(registry, 'resolve').mockImplementation(async () =>
      stubProvider(registry.current(), () => {
        calls.push(registry.current());
        return { ok: true, value: { text: registry.current(), model: registry.current(), usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 } } };
      }),
    );

    const provider = createSwitchableProvider(registry, 'fallback-model');
    await provider.complete({ system: 's', user: 'u', maxOutputTokens: 16 });
    registry.select('local');
    await provider.complete({ system: 's', user: 'u', maxOutputTokens: 16 });

    expect(calls).toEqual(['gemini', 'local']);
    vi.restoreAllMocks();
  });

  it('reports the model actually in use after a call, not the one selected at startup', async () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: null });
    vi.spyOn(registry, 'resolve').mockImplementation(async () =>
      stubProvider(`${registry.current()}:real-model`, () => ({
        ok: true,
        value: { text: '', model: 'x', usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 } },
      })),
    );

    const provider = createSwitchableProvider(registry, 'fallback-model');
    // Before any call there is nothing concrete to report, so it names the selection.
    expect(provider.model).toBe('fallback-model');

    registry.select('local');
    await provider.complete({ system: 's', user: 'u', maxOutputTokens: 16 });
    expect(provider.name).toBe('local:real-model');

    vi.restoreAllMocks();
  });

  it('fails with a clear, explicitly non-retryable error when the selected provider has no credentials - never silently falls back to another one', async () => {
    const registry = createProviderRegistry({ env: {}, initial: 'anthropic' });
    const provider = createSwitchableProvider(registry, 'fallback-model');

    const result = await provider.complete({ system: 's', user: 'u', maxOutputTokens: 16 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('anthropic');
    if (result.error.kind !== 'unavailable') throw new Error('expected an unavailable failure');
    expect(result.error.retryable).toBe(false);
  });
});
