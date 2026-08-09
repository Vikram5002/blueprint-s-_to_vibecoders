/**
 * Which vendor answers, and whether one answers at all.
 *
 * The single place that resolves environment into a provider. `anthropic.ts`
 * and `gemini.ts` know how to talk to their vendors; neither knows it is the
 * default, and nothing above this file knows either vendor exists.
 *
 * ## Gemini is the default because it is free
 *
 * Week 14 runs labelling across 50-100 repositories, and a free tier turns a
 * real bill into no bill. Anthropic stays fully wired and one environment
 * variable away — `VIBE_LLM_PROVIDER=anthropic` — because the free tier has
 * daily caps that a study-scale run will hit, and because a provider-agnostic
 * interface with only one live implementation is a claim nobody has checked.
 *
 * Selection is explicit rather than "whichever key is present". A machine with
 * both keys set would otherwise pick a provider by accident, and the run would
 * be reproducible only as long as nobody's environment changed.
 */
import { createAnthropicProvider, readApiKey, DEFAULT_MODEL as DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { createGeminiProvider, readGeminiApiKey, DEFAULT_GEMINI_MODEL } from './gemini.js';
import type { CompletionProvider } from './provider.js';

export type ProviderName = 'gemini' | 'anthropic';

export const PROVIDER_ENV = 'VIBE_LLM_PROVIDER';
export const MODEL_ENV = 'VIBE_LLM_MODEL';

/** Free, so it is what a user gets without being asked to spend anything. */
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
  const provider: ProviderName = requested === 'anthropic' ? 'anthropic' : DEFAULT_PROVIDER;
  const override = env[MODEL_ENV]?.trim();

  if (provider === 'anthropic') {
    return {
      provider,
      model: override !== undefined && override !== '' ? override : DEFAULT_ANTHROPIC_MODEL,
      apiKey: readApiKey(env),
      keyEnv: 'ANTHROPIC_API_KEY',
    };
  }

  return {
    provider,
    model: override !== undefined && override !== '' ? override : DEFAULT_GEMINI_MODEL,
    apiKey: readGeminiApiKey(env),
    keyEnv: 'GEMINI_API_KEY',
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
  return createGeminiProvider({ apiKey: choice.apiKey, model: choice.model });
}
