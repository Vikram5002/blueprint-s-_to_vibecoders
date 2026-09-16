import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseProvider, createProvider, PROVIDER_ENV, type ProviderChoice } from './select-provider.js';
import { DEFAULT_LOCAL_MODEL } from './local.js';

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
