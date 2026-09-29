import { describe, expect, it } from 'vitest';
import {
  createOpenAiServiceProvider,
  missingSetting,
  OPENAI_SERVICES,
  readServiceSettings,
} from './openai-services.js';
import { chooseProvider, createProvider } from './select-provider.js';

describe('readServiceSettings', () => {
  it('reads the key from any of its names, in order - OpenRouter keys are often saved as OPEN_ROUTER_API_KEY', () => {
    const settings = readServiceSettings(OPENAI_SERVICES.openrouter, { OPEN_ROUTER_API_KEY: ' or-key ' });
    expect(settings.apiKey).toBe('or-key');
    expect(settings.keyEnv).toBe('OPEN_ROUTER_API_KEY');
  });

  it('names the first key variable to set when none is', () => {
    const settings = readServiceSettings(OPENAI_SERVICES.groq, {});
    expect(settings.apiKey).toBeNull();
    expect(settings.keyEnv).toBe('GROQ_API_KEY');
  });

  it('lets a local runtime move, trimming a trailing slash', () => {
    const settings = readServiceSettings(OPENAI_SERVICES.ollama, { OLLAMA_BASE_URL: 'http://192.168.1.9:11434/v1/' });
    expect(settings.baseUrl).toBe('http://192.168.1.9:11434/v1');
    expect(settings.keyEnv).toBe('');
  });

  it("reads the service's own model variable and ignores the shared VIBE_LLM_MODEL", () => {
    expect(readServiceSettings(OPENAI_SERVICES.groq, { GROQ_MODEL: 'qwen/qwen3-32b' }).model).toBe('qwen/qwen3-32b');
    expect(readServiceSettings(OPENAI_SERVICES.groq, { VIBE_LLM_MODEL: 'local:checkpoint' }).model).toBe(
      OPENAI_SERVICES.groq.defaultModel,
    );
  });
});

describe('missingSetting', () => {
  it('asks a cloud service for its key, and says how to get one free', () => {
    const service = OPENAI_SERVICES.groq;
    expect(missingSetting(service, readServiceSettings(service, {}))).toBe('GROQ_API_KEY is not set');
    expect(service.howToGet).toContain('console.groq.com');
  });

  it('needs nothing for Ollama, which has no key', () => {
    const service = OPENAI_SERVICES.ollama;
    expect(missingSetting(service, readServiceSettings(service, {}))).toBeNull();
  });

  it('needs a URL and a model for a generic server, but not a key', () => {
    const service = OPENAI_SERVICES['openai-compatible'];
    expect(missingSetting(service, readServiceSettings(service, {}))).toBe('VIBE_OPENAI_BASE_URL is not set');
    const withUrl = readServiceSettings(service, { VIBE_OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1' });
    expect(missingSetting(service, withUrl)).toBe('VIBE_OPENAI_MODEL is not set');
    const ready = readServiceSettings(service, { VIBE_OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1', VIBE_OPENAI_MODEL: 'qwen2.5-7b' });
    expect(missingSetting(service, ready)).toBeNull();
  });
});

describe('createOpenAiServiceProvider', () => {
  it('posts to <baseUrl>/chat/completions and reports itself as <service>:<model>', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: {} }),
      );
    }) as typeof fetch;
    const service = OPENAI_SERVICES.groq;
    const provider = createOpenAiServiceProvider(service, readServiceSettings(service, { GROQ_API_KEY: 'k' }), fetchImpl);

    await provider.complete({ system: 's', user: 'u', maxOutputTokens: 8 });

    expect(urls).toEqual(['https://api.groq.com/openai/v1/chat/completions']);
    expect(provider.name).toBe(`groq:${service.defaultModel}`);
  });
});

describe('selecting a service', () => {
  it('builds Groq from VIBE_LLM_PROVIDER=groq and its key', async () => {
    const provider = await createProvider(chooseProvider({ VIBE_LLM_PROVIDER: 'groq', GROQ_API_KEY: 'k' }));
    expect(provider?.name).toBe(`groq:${OPENAI_SERVICES.groq.defaultModel}`);
  });

  it('returns null - run mechanically - when the key is missing', async () => {
    expect(await createProvider(chooseProvider({ VIBE_LLM_PROVIDER: 'openrouter' }))).toBeNull();
  });

  it('builds Ollama with no key at all', async () => {
    const provider = await createProvider(chooseProvider({ VIBE_LLM_PROVIDER: 'ollama' }));
    expect(provider?.name).toBe(`ollama:${OPENAI_SERVICES.ollama.defaultModel}`);
  });
});
