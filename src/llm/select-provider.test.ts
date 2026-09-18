import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseProvider, createProvider, PROVIDER_ENV, type ProviderChoice } from './select-provider.js';
import { DEFAULT_LOCAL_CODE_MODEL, DEFAULT_LOCAL_MODEL } from './local.js';

describe('select-provider — local, the always-constructible branch', () => {
  it("chooseProvider('local', ...) reports no key and no key env, truthfully", () => {
    const choice = chooseProvider({ [PROVIDER_ENV]: 'local' });
    expect(choice.provider).toBe('local');
    expect(choice.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(choice.apiKey).toBeNull();
    expect(choice.keyEnv).toBe('');
  });

  /**
   * The behavioural proof that the shared "no key, return null" gate is
   * never reached for `local`, not merely satisfied by it: if
   * `createProvider` ever evaluated `choice.apiKey === null` for this
   * provider, this call would return `null` (that condition is true here
   * by construction). It doesn't — which is only possible if the `local`
   * branch runs and returns before that check, exactly the "always
   * constructible, no key check" design this pins down.
   */
  it('createProvider constructs a local provider even with apiKey: null — proving the gate is bypassed, not passed', async () => {
    const choice: ProviderChoice = { provider: 'local', model: DEFAULT_LOCAL_MODEL, apiKey: null, keyEnv: '' };
    const provider = await createProvider(choice);
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
    expect(provider?.model).toBe(DEFAULT_LOCAL_MODEL);
  });

  /**
   * Same proof from the other side: an obviously-garbage non-null apiKey
   * produces an identical result to the null case above. If `local` ever
   * routed through the shared key-bearing construction path the way
   * anthropic/gemini/bluesminds do, a bogus key would change what gets
   * built (or how). It doesn't, because local's branch never reads
   * `choice.apiKey` at all.
   */
  it('createProvider ignores apiKey entirely for local — a garbage value changes nothing', async () => {
    const choice: ProviderChoice = {
      provider: 'local',
      model: DEFAULT_LOCAL_MODEL,
      apiKey: 'this-is-not-a-real-key-and-local-has-no-concept-of-one',
      keyEnv: '',
    };
    const provider = await createProvider(choice);
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
  });
});

describe('select-provider — gemini receives every configured key, not just the first', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('chooseProvider reads GEMINI_API_KEY_2..N into additionalApiKeys, in order', () => {
    const choice = chooseProvider({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2', GEMINI_API_KEY_3: 'k3' });
    expect(choice.apiKey).toBe('k1');
    expect(choice.additionalApiKeys).toEqual(['k2', 'k3']);
  });

  /**
   * The wiring proof, end to end. gemini.ts can rotate across keys on its
   * own, but that is worthless unless the provider this module builds is
   * actually HANDED the extra keys - and for a while it was not:
   * createProvider passed only `apiKey`, so a user with seven keys
   * configured was silently running on one, and gemini.ts's own unit tests
   * (which construct the provider directly) could not notice. This goes
   * through chooseProvider -> createProvider exactly as the server does, and
   * only passes if the second key is really used once the first is spent.
   */
  it('createProvider builds a gemini provider that rotates to the second env key when the first is exhausted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seenKeys: string[] = [];
    vi.stubGlobal('fetch', (async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-goog-api-key'] ?? '';
      seenKeys.push(key);
      if (key === 'k1') {
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
            },
          }),
          { status: 429 },
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200 },
      );
    }) as typeof fetch);

    const provider = await createProvider(chooseProvider({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' }));
    const result = await provider?.complete({ system: 's', user: 'u', maxOutputTokens: 16 });

    expect(result?.ok).toBe(true);
    expect(seenKeys).toEqual(['k1', 'k2']);
  });
});

describe('select-provider — local-code, the same adapter aimed at the code checkpoint', () => {
  it("chooseProvider('local-code') names the code model, no key, and the planner's origin by default", () => {
    const choice = chooseProvider({ [PROVIDER_ENV]: 'local-code', VIBE_LOCAL_BASE_URL: 'http://planner:8712' });
    expect(choice.provider).toBe('local-code');
    expect(choice.model).toBe(DEFAULT_LOCAL_CODE_MODEL);
    expect(choice.apiKey).toBeNull();
    expect(choice.keyEnv).toBe('');
    // No URL of its own configured: same server as the planner.
    expect(choice.baseUrl).toBe('http://planner:8712');
  });

  it('prefers VIBE_LOCAL_CODE_BASE_URL over the planner origin when both are set, trimming the trailing slash', () => {
    const choice = chooseProvider({
      [PROVIDER_ENV]: 'local-code',
      VIBE_LOCAL_BASE_URL: 'http://planner:8712',
      VIBE_LOCAL_CODE_BASE_URL: 'https://coder.trycloudflare.com/',
    });
    expect(choice.baseUrl).toBe('https://coder.trycloudflare.com');
    // And the planner is untouched by the coder's variable.
    expect(chooseProvider({ [PROVIDER_ENV]: 'local', VIBE_LOCAL_CODE_BASE_URL: 'https://coder.trycloudflare.com' }).baseUrl).toBe(
      'http://127.0.0.1:8712',
    );
  });

  it('honours the VIBE_LLM_MODEL override for local-code too', () => {
    const choice = chooseProvider({ [PROVIDER_ENV]: 'local-code', VIBE_LLM_MODEL: 'local-code:qwen2.5-coder-7b-instruct+run_x' });
    expect(choice.model).toBe('local-code:qwen2.5-coder-7b-instruct+run_x');
  });

  it('createProvider constructs local-code with apiKey: null, sends the served model name in the body, and hits its own origin', async () => {
    const choice = chooseProvider({ [PROVIDER_ENV]: 'local-code', VIBE_LOCAL_CODE_BASE_URL: 'http://coder:9000' });
    const provider = await createProvider(choice);
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe(`local:${DEFAULT_LOCAL_CODE_MODEL}`);

    let seenUrl = '';
    let seenBody: { model?: string } = {};
    vi.stubGlobal('fetch', (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body)) as { model?: string };
      return new Response(
        JSON.stringify({ ok: true, value: { text: 'x', model: DEFAULT_LOCAL_CODE_MODEL, usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 } } }),
        { status: 200 },
      );
    }) as typeof fetch);
    // The provider captured the global fetch at construction, so rebuild after stubbing.
    const rebuilt = await createProvider(choice);
    const result = await rebuilt?.complete({ system: 's', user: 'u', maxOutputTokens: 8 });
    vi.unstubAllGlobals();

    expect(result?.ok).toBe(true);
    expect(seenUrl).toBe('http://coder:9000/complete');
    // The wire carries the served NAME, not the display label - see servedModelName in local.ts.
    expect(seenBody.model).toBe('local-code');
  });
});
