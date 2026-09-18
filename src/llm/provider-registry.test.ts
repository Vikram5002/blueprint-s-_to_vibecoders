import { describe, expect, it, vi } from 'vitest';
import {
  createProviderRegistry,
  createSwitchableProvider,
  LOCAL_CODE_BASE_URL_SETTING_KEY,
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

describe('local base URL - pointing at a machine that is not this one', () => {
  it('defaults to loopback when nothing is configured or persisted', () => {
    const registry = createProviderRegistry({ env: {}, initial: null });
    expect(registry.localBaseUrl()).toBe('http://127.0.0.1:8712');
  });

  it('prefers a persisted origin over the environment default', () => {
    const registry = createProviderRegistry({
      env: { VIBE_LOCAL_BASE_URL: 'http://192.168.1.50:8712' } as NodeJS.ProcessEnv,
      initial: null,
      initialLocalBaseUrl: 'https://saved-tunnel.trycloudflare.com',
    });
    expect(registry.localBaseUrl()).toBe('https://saved-tunnel.trycloudflare.com');
  });

  it('falls back to the environment when nothing was persisted', () => {
    const registry = createProviderRegistry({
      env: { VIBE_LOCAL_BASE_URL: 'http://192.168.1.50:8712' } as NodeJS.ProcessEnv,
      initial: null,
      initialLocalBaseUrl: null,
    });
    expect(registry.localBaseUrl()).toBe('http://192.168.1.50:8712');
  });

  it('accepts a tunnel URL, trims its trailing slash, and persists it once', () => {
    const saved: string[] = [];
    const registry = createProviderRegistry({
      env: {},
      initial: null,
      onLocalBaseUrl: (url) => saved.push(url),
    });

    expect(registry.setLocalBaseUrl('https://abc-def.trycloudflare.com/')).toBe(true);
    expect(registry.localBaseUrl()).toBe('https://abc-def.trycloudflare.com');
    // Same value again is a no-op, not a second write.
    expect(registry.setLocalBaseUrl('https://abc-def.trycloudflare.com')).toBe(true);
    expect(saved).toEqual(['https://abc-def.trycloudflare.com']);
  });

  it('rejects anything that is not an http(s) URL, leaving the current origin untouched', () => {
    const registry = createProviderRegistry({ env: {}, initial: null });
    for (const bad of ['', '   ', 'not a url', 'ftp://host/x', 'localhost:8712']) {
      expect(registry.setLocalBaseUrl(bad)).toBe(false);
    }
    expect(registry.localBaseUrl()).toBe('http://127.0.0.1:8712');
  });

  it('probes the configured origin, not loopback, and says which one it tried', async () => {
    const probed: string[] = [];
    const registry = createProviderRegistry({
      env: {},
      initial: null,
      fetchImpl: (async (url: unknown) => {
        probed.push(String(url));
        return new Response('', { status: 404 });
      }) as typeof fetch,
    });
    registry.setLocalBaseUrl('https://abc-def.trycloudflare.com');

    const local = (await registry.status()).find((entry) => entry.id === 'local');
    // Nothing goes to loopback - the coder, having no origin of its own, follows the planner's tunnel too.
    expect(probed[0]).toBe('https://abc-def.trycloudflare.com');
    expect(probed.every((url) => url.startsWith('https://abc-def.trycloudflare.com'))).toBe(true);
    expect(local?.available).toBe(true);
    expect(local?.detail).toContain('https://abc-def.trycloudflare.com');
  });

  it('discards the cached local provider when the origin changes, so requests follow the new tunnel', async () => {
    const registry = createProviderRegistry({ env: {}, initial: 'local', fetchImpl: reachable });

    const before = await registry.resolve();
    registry.setLocalBaseUrl('https://new-tunnel.trycloudflare.com');
    const after = await registry.resolve();

    // A fresh instance, not the one that captured the previous origin - this
    // is the difference between a switch that works and one that silently
    // keeps talking to a dead Colab session.
    expect(before).not.toBe(after);
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

describe('code-generation provider override', () => {
  it('follows the plan provider until an override is chosen', () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: 'local' });
    expect(registry.codeSelection()).toBeNull();
    expect(registry.currentCode()).toBe('local');
  });

  it('uses the override for code while the plan provider stays put, and persists both set and clear', () => {
    const saved: (string | null)[] = [];
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: 'local', onSelectCode: (p) => saved.push(p) });

    expect(registry.selectCode('gemini')).toBe(true);
    expect(registry.current()).toBe('local');
    expect(registry.currentCode()).toBe('gemini');

    registry.selectCode('gemini'); // no-op - never persisted twice
    registry.selectCode(null);
    expect(registry.currentCode()).toBe('local');
    expect(saved).toEqual(['gemini', null]);
  });

  it('restores a persisted override, and treats "same" or an unknown value as no override', () => {
    expect(createProviderRegistry({ env: GEMINI_ENV, initial: 'local', initialCode: 'gemini' }).currentCode()).toBe('gemini');
    expect(createProviderRegistry({ env: GEMINI_ENV, initial: 'local', initialCode: 'same' }).codeSelection()).toBeNull();
    expect(createProviderRegistry({ env: GEMINI_ENV, initial: 'local', initialCode: 'nope' }).codeSelection()).toBeNull();
  });

  it("a 'code' switchable provider dispatches to the code choice, a 'plan' one to the plan choice", async () => {
    const registry = createProviderRegistry({ env: GEMINI_ENV, initial: 'local', initialCode: 'gemini' });
    const answer = (name: string) => async () =>
      stubProvider(name, () => ({ ok: true, value: { text: name, model: name, usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 } } }));
    vi.spyOn(registry, 'resolve').mockImplementation(answer('plan-target'));
    vi.spyOn(registry, 'resolveCode').mockImplementation(answer('code-target'));

    const plan = await createSwitchableProvider(registry, 'm').complete({ system: 's', user: 'u', maxOutputTokens: 8 });
    const code = await createSwitchableProvider(registry, 'm', 'code').complete({ system: 's', user: 'u', maxOutputTokens: 8 });

    expect(plan.ok && plan.value.text).toBe('plan-target');
    expect(code.ok && code.value.text).toBe('code-target');
    vi.restoreAllMocks();
  });
});

describe('local code base URL - the coder may share the planner\'s server or have its own', () => {
  /** Answers /models like the multi-model inference server; a 404 for anything else, like the old one. */
  const servingCoder = (async (url: unknown) => {
    if (String(url).endsWith('/models')) {
      return new Response(
        JSON.stringify({
          models: [
            { name: 'local:qwen2.5-7b-instruct+run_20260822_130636', base: 'Qwen/Qwen2.5-7B-Instruct', adapter: 'plan' },
            { name: 'local-code:qwen2.5-coder-7b-instruct+code-adapter', base: 'Qwen/Qwen2.5-Coder-7B-Instruct', adapter: 'code' },
          ],
          default: 'local:qwen2.5-7b-instruct+run_20260822_130636',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  it('follows the planner origin - live - while nothing of its own is configured or persisted', () => {
    const registry = createProviderRegistry({ env: {}, initial: null, initialLocalBaseUrl: 'https://planner.trycloudflare.com' });
    expect(registry.localCodeBaseUrl()).toBe('https://planner.trycloudflare.com');
    registry.setLocalBaseUrl('https://next-session.trycloudflare.com');
    expect(registry.localCodeBaseUrl()).toBe('https://next-session.trycloudflare.com');
  });

  it('stops following the planner once given an origin of its own, even one equal to the value it was following', () => {
    const registry = createProviderRegistry({ env: {}, initial: null });
    expect(registry.setLocalCodeBaseUrl('http://127.0.0.1:8712')).toBe(true);
    registry.setLocalBaseUrl('https://planner.trycloudflare.com');
    expect(registry.localCodeBaseUrl()).toBe('http://127.0.0.1:8712');
  });

  it('drops the cached following coder when the planner origin it follows moves', async () => {
    const registry = createProviderRegistry({ env: {}, initial: 'local', initialCode: 'local-code', fetchImpl: reachable });
    const before = await registry.resolveCode();
    registry.setLocalBaseUrl('https://next-session.trycloudflare.com');
    expect(before).not.toBe(await registry.resolveCode());
  });

  it('prefers a persisted coder origin over its env var, and its env var over the planner origin', () => {
    const env = { VIBE_LOCAL_CODE_BASE_URL: 'http://coder-env:8712', VIBE_LOCAL_BASE_URL: 'http://planner-env:8712' } as NodeJS.ProcessEnv;
    expect(createProviderRegistry({ env, initial: null, initialLocalCodeBaseUrl: 'https://saved-coder.trycloudflare.com' }).localCodeBaseUrl()).toBe(
      'https://saved-coder.trycloudflare.com',
    );
    expect(createProviderRegistry({ env, initial: null, initialLocalCodeBaseUrl: null }).localCodeBaseUrl()).toBe('http://coder-env:8712');
  });

  it('accepts a tunnel URL, persists it once, rejects garbage, and leaves the planner origin alone', () => {
    const saved: string[] = [];
    const plannerSaved: string[] = [];
    const registry = createProviderRegistry({
      env: {},
      initial: null,
      onLocalCodeBaseUrl: (url) => saved.push(url),
      onLocalBaseUrl: (url) => plannerSaved.push(url),
    });

    expect(registry.setLocalCodeBaseUrl('https://coder.trycloudflare.com/')).toBe(true);
    expect(registry.setLocalCodeBaseUrl('https://coder.trycloudflare.com')).toBe(true);
    expect(registry.localCodeBaseUrl()).toBe('https://coder.trycloudflare.com');
    expect(registry.localBaseUrl()).toBe('http://127.0.0.1:8712');
    for (const bad of ['', 'not a url', 'ftp://host/x', 'localhost:8712']) {
      expect(registry.setLocalCodeBaseUrl(bad)).toBe(false);
    }
    expect(saved).toEqual(['https://coder.trycloudflare.com']);
    expect(plannerSaved).toEqual([]);
  });

  it('probes the coder at ITS origin, and reports the served model names when the server lists them', async () => {
    const probed: string[] = [];
    const registry = createProviderRegistry({
      env: {},
      initial: null,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        probed.push(String(url));
        return servingCoder(url as string, init);
      }) as typeof fetch,
    });
    registry.setLocalCodeBaseUrl('https://coder.trycloudflare.com');

    const status = await registry.status();
    const code = status.find((entry) => entry.id === 'local-code');
    expect(code?.available).toBe(true);
    expect(code?.detail).toContain('https://coder.trycloudflare.com');
    expect(code?.detail).toContain('local-code:qwen2.5-coder-7b-instruct+code-adapter');
    expect(probed).toContain('https://coder.trycloudflare.com/models');
    expect(probed).toContain('http://127.0.0.1:8712');
    // The planner entry never gains the coder's model list.
    expect(status.find((entry) => entry.id === 'local')?.detail).not.toContain('serving');
  });

  it('still reports the coder as reachable when the server predates /models', async () => {
    const registry = createProviderRegistry({ env: {}, initial: null, fetchImpl: reachable });
    const code = (await registry.status()).find((entry) => entry.id === 'local-code');
    expect(code?.available).toBe(true);
    expect(code?.detail).toBe('Reachable at http://127.0.0.1:8712');
  });

  it('reports the coder as down at its own origin, naming the script to start', async () => {
    const registry = createProviderRegistry({ env: {}, initial: null, fetchImpl: refused });
    registry.setLocalCodeBaseUrl('https://coder.trycloudflare.com');
    const code = (await registry.status()).find((entry) => entry.id === 'local-code');
    expect(code?.available).toBe(false);
    expect(code?.detail).toContain('https://coder.trycloudflare.com');
    expect(code?.detail).toContain('local_inference_server.py');
  });

  it('discards the cached local-code provider when its origin changes, and only that one', async () => {
    const registry = createProviderRegistry({ env: {}, initial: 'local', initialCode: 'local-code', fetchImpl: reachable });

    const planBefore = await registry.resolve();
    const codeBefore = await registry.resolveCode();
    registry.setLocalCodeBaseUrl('https://new-coder.trycloudflare.com');
    const planAfter = await registry.resolve();
    const codeAfter = await registry.resolveCode();

    expect(codeBefore).not.toBe(codeAfter);
    expect(planBefore).toBe(planAfter);
  });

  it('is selectable as the code provider and persisted under its own key', () => {
    const registry = createProviderRegistry({ env: {}, initial: 'gemini' });
    expect(registry.selectCode('local-code')).toBe(true);
    expect(registry.currentCode()).toBe('local-code');
    expect(LOCAL_CODE_BASE_URL_SETTING_KEY).toBe('llm.localCodeBaseUrl');
  });
});
