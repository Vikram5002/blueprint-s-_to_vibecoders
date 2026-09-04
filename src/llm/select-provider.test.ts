import { describe, expect, it } from 'vitest';
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
