/**
 * Which vendor answers, and whether one answers at all.
 *
 * The single place that resolves environment into a provider. `anthropic.ts`
 * and `gemini.ts` know how to talk to their vendors; neither knows it is the
 * default, and nothing above this file knows either vendor exists.
 *
 * ## Three providers, with different jobs
 *
 * - **Gemini** is the default. Free, fast, and measurably better output than
 *   the alternative — see `docs/PROVIDERS.md` for the numbers.
 * - **Bluesminds** is a documented fallback, not the default. It was made the
 *   default for one day on the theory that an uncapped gateway was what
 *   corpus work needed, and measurement said otherwise: worse labels, worse
 *   extraction, ~23x the wall-clock time.
 * - **Anthropic** is reserved for the Haiku/Sonnet comparison, which must run
 *   direct. Routing a provider comparison through a gateway measures the
 *   gateway.
 *
 * Bluesminds is a *gateway*, and a result from it cannot be attributed to a
 * specific model version with certainty — see `docs/PROVIDERS.md`. That alone
 * disqualifies it from producing any number the paper depends on.
 *
 * Selection is explicit rather than "whichever key is present". A machine with
 * both keys set would otherwise pick a provider by accident, and the run would
 * be reproducible only as long as nobody's environment changed.
 */
import { createAnthropicProvider, readApiKey, DEFAULT_MODEL as DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { createGeminiProvider, readGeminiApiKey, DEFAULT_GEMINI_MODEL } from './gemini.js';
import {
  createBluesmindsProvider,
  readBluesmindsApiKey,
  DEFAULT_BLUESMINDS_MODEL,
} from './bluesminds.js';
import type { CompletionProvider } from './provider.js';

export type ProviderName = 'bluesminds' | 'gemini' | 'anthropic';

export const PROVIDER_ENV = 'VIBE_LLM_PROVIDER';
export const MODEL_ENV = 'VIBE_LLM_MODEL';

/**
 * Free, fast, and the best output measured. Reverted here from `bluesminds`
 * after a day: see `docs/PROVIDERS.md` → "Why Bluesminds is not the default".
 */
export const DEFAULT_PROVIDER: ProviderName = 'gemini';

export interface ProviderChoice {
  readonly provider: ProviderName;
  readonly model: string;
  /** Null when the chosen provider has no key configured. */
  readonly apiKey: string | null;
  /** Which environment variable the key would come from. */
  readonly keyEnv: string;
}

/**
 * Decides provider and model without constructing anything or touching the
 * network, so the CLI can report what *would* happen — including on the no-key
 * path, where nothing is constructed at all.
 */
export function chooseProvider(env: NodeJS.ProcessEnv = process.env): ProviderChoice {
  const requested = env[PROVIDER_ENV]?.trim().toLowerCase();
  const provider: ProviderName =
    requested === 'anthropic' || requested === 'gemini' || requested === 'bluesminds'
      ? requested
      : DEFAULT_PROVIDER;
  const override = env[MODEL_ENV]?.trim();
  const pick = (fallback: string): string =>
    override !== undefined && override !== '' ? override : fallback;

  if (provider === 'anthropic') {
    return {
      provider,
      model: pick(DEFAULT_ANTHROPIC_MODEL),
      apiKey: readApiKey(env),
      keyEnv: 'ANTHROPIC_API_KEY',
    };
  }

  if (provider === 'gemini') {
    return {
      provider,
      model: pick(DEFAULT_GEMINI_MODEL),
      apiKey: readGeminiApiKey(env),
      keyEnv: 'GEMINI_API_KEY',
    };
  }

  return {
    provider,
    model: pick(DEFAULT_BLUESMINDS_MODEL),
    apiKey: readBluesmindsApiKey(env),
    keyEnv: 'BLUESMINDS_API_KEY',
  };
}

/**
 * Builds the provider, or returns null when there is no key.
 *
 * Null is not an error. It is the signal to run mechanically, and the no-key
 * path is the common one — so nothing is imported, no SDK is loaded and no
 * warning is printed.
 */
export async function createProvider(choice: ProviderChoice): Promise<CompletionProvider | null> {
  if (choice.apiKey === null) return null;

  if (choice.provider === 'anthropic') {
    return createAnthropicProvider({ apiKey: choice.apiKey, model: choice.model });
  }
  if (choice.provider === 'gemini') {
    return createGeminiProvider({ apiKey: choice.apiKey, model: choice.model });
  }
  return createBluesmindsProvider({ apiKey: choice.apiKey, model: choice.model });
}
