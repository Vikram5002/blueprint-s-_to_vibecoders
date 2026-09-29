/**
 * Free and student-friendly model services, all reached through the one
 * OpenAI chat-completions adapter (`chat-completions.ts`).
 *
 * Why these: every one can be used without paying.
 *
 * - **Groq** - a free API key with no card; very fast open models.
 * - **OpenRouter** - one key, many models; the ones ending in `:free` cost
 *   nothing, under a daily request cap.
 * - **GitHub Models** - free with any GitHub account (a token with
 *   `models:read`); the GitHub Student Developer Pack raises the limits.
 * - **Ollama** - runs open models on the person's own machine: free, offline,
 *   and nothing leaves the laptop.
 * - **OpenAI-compatible** - any other service or runtime that speaks the same
 *   format (LM Studio, vLLM, Cerebras, a cloud notebook's tunnel), by URL.
 *
 * Each service reads its own model variable (`GROQ_MODEL`, ...), never the
 * shared `VIBE_LLM_MODEL`: that one names a model for the provider chosen at
 * start-up, and applying it to every service in the picker would send, say, a
 * local checkpoint label to Groq.
 */
import { createChatCompletionsProvider, type RetryPolicy } from './chat-completions.js';
import type { CompletionProvider } from './provider.js';

export type OpenAiServiceName = 'groq' | 'openrouter' | 'github' | 'ollama' | 'openai-compatible';

export interface OpenAiService {
  readonly id: OpenAiServiceName;
  readonly label: string;
  /** Endpoint prefix; requests go to `<baseUrl>/chat/completions`. Empty when the person must supply it. */
  readonly baseUrl: string;
  /** Environment variable that moves `baseUrl`. */
  readonly baseUrlEnv?: string;
  /** Checked in order for a key. Empty for a service with no key at all (a local runtime). */
  readonly keyEnvs: readonly string[];
  /** Environment variable that picks the model for this service. */
  readonly modelEnv: string;
  readonly defaultModel: string;
  readonly retry: RetryPolicy;
  readonly requestTimeoutMs: number;
  /** How to get it for free - shown when it is not set up yet. */
  readonly howToGet: string;
}

/** A free-tier 429 usually names its window; a per-minute cap clears in seconds. */
const CLOUD_FREE_TIER_RETRY: RetryPolicy = { maxAttempts: 5, baseBackoffMs: 2_000, maxBackoffMs: 60_000 };
/** A local runtime either answers or is not running; waiting a minute will not start it. */
const LOCAL_RUNTIME_RETRY: RetryPolicy = { maxAttempts: 2, baseBackoffMs: 1_000, maxBackoffMs: 2_000 };

export const OPENAI_SERVICES: Readonly<Record<OpenAiServiceName, OpenAiService>> = {
  groq: {
    id: 'groq',
    label: 'Groq (free tier, cloud)',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnvs: ['GROQ_API_KEY'],
    modelEnv: 'GROQ_MODEL',
    // Checked against GET /models on 2026-09-29: the Llama 3.3 models are
    // gone; this one writes code well and allows 65k output tokens.
    defaultModel: 'openai/gpt-oss-120b',
    retry: CLOUD_FREE_TIER_RETRY,
    requestTimeoutMs: 120_000,
    howToGet: 'free key, no card: console.groq.com -> API Keys, then set GROQ_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (free models, cloud)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnvs: ['OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY'],
    modelEnv: 'OPENROUTER_MODEL',
    // One of 16 free models on 2026-09-29 (GET /api/v1/models, ids ending
    // ":free"); the free list changes often - OPENROUTER_MODEL picks another.
    defaultModel: 'qwen/qwen3.8-27b:free',
    retry: CLOUD_FREE_TIER_RETRY,
    requestTimeoutMs: 180_000,
    howToGet: 'free key: openrouter.ai -> Keys, then set OPENROUTER_API_KEY (models ending in :free cost nothing)',
  },
  github: {
    id: 'github',
    label: 'GitHub Models (free, students get more)',
    baseUrl: 'https://models.github.ai/inference',
    keyEnvs: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'],
    modelEnv: 'GITHUB_MODELS_MODEL',
    defaultModel: 'openai/gpt-4.1-mini',
    retry: CLOUD_FREE_TIER_RETRY,
    requestTimeoutMs: 120_000,
    howToGet:
      'free with a GitHub account: a fine-grained token with "Models: read", set as GITHUB_MODELS_TOKEN ' +
      '(the GitHub Student Developer Pack raises the limits)',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (free, offline, this computer)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    keyEnvs: [],
    modelEnv: 'OLLAMA_MODEL',
    defaultModel: 'qwen2.5-coder:7b',
    retry: LOCAL_RUNTIME_RETRY,
    // A laptop CPU writing a whole component file can take minutes.
    requestTimeoutMs: 900_000,
    howToGet: 'install from ollama.com, then run: ollama pull qwen2.5-coder:7b',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'Any OpenAI-compatible server (by URL)',
    baseUrl: '',
    baseUrlEnv: 'VIBE_OPENAI_BASE_URL',
    keyEnvs: ['VIBE_OPENAI_API_KEY'],
    modelEnv: 'VIBE_OPENAI_MODEL',
    defaultModel: '',
    retry: CLOUD_FREE_TIER_RETRY,
    requestTimeoutMs: 600_000,
    howToGet:
      'set VIBE_OPENAI_BASE_URL (e.g. LM Studio http://127.0.0.1:1234/v1) and VIBE_OPENAI_MODEL; ' +
      'VIBE_OPENAI_API_KEY only if the server wants one',
  },
};

export const OPENAI_SERVICE_NAMES = Object.keys(OPENAI_SERVICES) as readonly OpenAiServiceName[];

export function isOpenAiService(name: string): name is OpenAiServiceName {
  return (OPENAI_SERVICE_NAMES as readonly string[]).includes(name);
}

export interface OpenAiServiceSettings {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  /** Which variable the key came from, or the one to set when none is. Empty for a keyless service. */
  readonly keyEnv: string;
  readonly model: string;
}

/** Where the service is, which key and model to use - from the environment, without touching the network. */
export function readServiceSettings(service: OpenAiService, env: NodeJS.ProcessEnv): OpenAiServiceSettings {
  const read = (name: string | undefined): string | null => {
    if (name === undefined) return null;
    const value = env[name]?.trim();
    return value === undefined || value === '' ? null : value;
  };
  const keyEnv = service.keyEnvs.find((name) => read(name) !== null) ?? service.keyEnvs[0] ?? '';
  return {
    baseUrl: (read(service.baseUrlEnv) ?? service.baseUrl).replace(/\/+$/, ''),
    apiKey: keyEnv === '' ? null : read(keyEnv),
    keyEnv,
    model: read(service.modelEnv) ?? service.defaultModel,
  };
}

/**
 * What is still missing before this service can answer, or null when it is
 * ready to try. A keyless service is "ready" once it has somewhere to go;
 * whether anything is listening there is the registry's probe, not this.
 */
export function missingSetting(service: OpenAiService, settings: OpenAiServiceSettings): string | null {
  if (settings.baseUrl === '') return `${service.baseUrlEnv ?? 'a base URL'} is not set`;
  if (settings.model === '') return `${service.modelEnv} is not set`;
  // The generic server's key is optional; every cloud service needs its own.
  if (service.keyEnvs.length > 0 && service.id !== 'openai-compatible' && settings.apiKey === null) {
    return `${settings.keyEnv} is not set`;
  }
  return null;
}

/** Short, like the local-server probe: this renders a picker, it does not serve a request. */
const LIST_MODELS_TIMEOUT_MS = 4_000;

export interface ServedModels {
  /** False when nothing answers at all. */
  readonly reachable: boolean;
  /** What the server lists; null when it answers but does not list (contents unknown). An empty list is a real "none". */
  readonly models: readonly string[] | null;
}

/**
 * The models a keyless server says it has (`GET <baseUrl>/models`, which
 * Ollama, LM Studio and vLLM all answer). Ollama with nothing downloaded
 * answers an empty list - which has to read as "none", not "unknown".
 */
export async function listServedModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ServedModels> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS) });
  } catch {
    return { reachable: false, models: null };
  }
  try {
    const body = (await response.json()) as { object?: unknown; data?: unknown };
    if (!response.ok) return { reachable: true, models: null };
    // Ollama 0.34 lists nothing downloaded as `{"object":"list","data":null}`.
    if (body.object === 'list' && body.data === null) return { reachable: true, models: [] };
    if (!Array.isArray(body.data)) return { reachable: true, models: null };
    const ids = (body.data as { id?: unknown }[]).map((entry) => entry.id);
    return { reachable: true, models: ids.filter((id): id is string => typeof id === 'string') };
  } catch {
    return { reachable: true, models: null };
  }
}

/** What to do when the model is not on the server - for Ollama, the exact command. */
export function missingModelHint(service: OpenAiService, model: string): string {
  return service.id === 'ollama' ? `run: ollama pull ${model}` : 'pick a model the server lists';
}

export function createOpenAiServiceProvider(
  service: OpenAiService,
  settings: OpenAiServiceSettings,
  fetchImpl?: typeof fetch,
): CompletionProvider {
  return createChatCompletionsProvider({
    name: service.id,
    endpoint: `${settings.baseUrl}/chat/completions`,
    apiKey: settings.apiKey,
    model: settings.model,
    retry: service.retry,
    requestTimeoutMs: service.requestTimeoutMs,
    notFoundHint: missingModelHint(service, settings.model),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}
