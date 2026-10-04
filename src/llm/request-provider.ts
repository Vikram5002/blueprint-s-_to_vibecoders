/**
 * A model chosen by the person making the request, with their own API key -
 * the "use my own key" option. The key arrives with the request, is used for
 * that request (and the background job it starts) only, and is never stored:
 * it lives in an AsyncLocalStorage context, which a job started inside the
 * request keeps until it finishes, and nothing else can see.
 *
 * Only vendors with a fixed public address are offered. A user-supplied base
 * URL (Ollama, a "compatible server", the local model) would let any visitor
 * of a hosted server make it call addresses inside its own network.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CompletionProvider } from './provider.js';
import { chooseProvider, createProvider } from './select-provider.js';
import { isOpenAiService, OPENAI_SERVICES } from './openai-services.js';
import { type Result, ok, err } from '../types/result.js';

export const USER_KEY_PROVIDERS = ['groq', 'gemini', 'openrouter', 'github', 'anthropic'] as const;
export type UserKeyProvider = (typeof USER_KEY_PROVIDERS)[number];

const KEY_ENV: Readonly<Record<UserKeyProvider, string>> = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  github: 'GITHUB_MODELS_TOKEN',
  anthropic: 'ANTHROPIC_API_KEY',
};

export interface UserKey {
  readonly provider: string;
  readonly apiKey: string;
  readonly model?: string;
}

const KEY_SHAPE = /^[\x21-\x7e]{8,400}$/;
const MODEL_SHAPE = /^[\w.:/-]{1,120}$/;

function isUserKeyProvider(name: string): name is UserKeyProvider {
  return (USER_KEY_PROVIDERS as readonly string[]).includes(name);
}

/**
 * Builds the provider from the request's key alone - never from this
 * server's own environment, so a request can neither borrow the server's
 * keys nor move a vendor's address.
 */
export async function providerFromUserKey(input: UserKey): Promise<Result<CompletionProvider, string>> {
  const name = input.provider.trim().toLowerCase();
  if (!isUserKeyProvider(name)) return err(`"${input.provider}" cannot be used with your own key; use one of: ${USER_KEY_PROVIDERS.join(', ')}`);
  const apiKey = input.apiKey.trim();
  if (!KEY_SHAPE.test(apiKey)) return err('that API key does not look like one (8-400 printable characters, no spaces)');
  const model = input.model?.trim() ?? '';
  if (model !== '' && !MODEL_SHAPE.test(model)) return err('the model name has characters a model name never has');

  const env: NodeJS.ProcessEnv = { VIBE_LLM_PROVIDER: name, [KEY_ENV[name]]: apiKey, VIBE_GEMINI_KEY_STATE_PATH: 'off' };
  if (model !== '') {
    const modelEnv = isOpenAiService(name) ? OPENAI_SERVICES[name].modelEnv : 'VIBE_LLM_MODEL';
    env[modelEnv] = model;
  }
  const provider = await createProvider(chooseProvider(env));
  return provider === null ? err(`could not set up ${name} with that key`) : ok(provider);
}

const current = new AsyncLocalStorage<CompletionProvider>();

/** Runs `fn` (and everything it starts) with `provider` answering every model call. */
export function runWithRequestProvider<T>(provider: CompletionProvider, fn: () => T): T {
  return current.run(provider, fn);
}

/** The person's own provider, when the current request (or job) brought one. */
export function requestProvider(): CompletionProvider | undefined {
  return current.getStore();
}
