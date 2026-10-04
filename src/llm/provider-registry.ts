/**
 * Runtime provider switching: one place that knows which model answers
 * generation requests right now, and can be told to change its mind.
 *
 * ## Why a proxy rather than rebuilding the server's wiring
 *
 * `startServer` resolves a provider once and hands it to the workflow and
 * application route deps, which capture it. Making every one of those deps
 * re-resolve per request would mean changing their types (and every test
 * that constructs them) to take a getter instead of a value.
 *
 * `createSwitchableProvider` avoids all of it: it is a real
 * `CompletionProvider` with a stable identity that forwards each call to
 * whichever provider is selected at the moment of the call. Everything
 * upstream keeps its existing "there is one provider" shape and never learns
 * that switching exists - which also means switching cannot break an
 * in-flight request, since that request already holds the concrete provider
 * `complete()` dispatched to.
 *
 * ## This is not the rejected provider-fallback decision
 *
 * `select-provider.ts`'s header documents a deliberate choice: never
 * *silently* fall back from one vendor to another on failure, because that
 * breaks reproducibility and can route failure traffic into a weaker
 * backend. Untouched here. This is the opposite thing - an explicit,
 * deliberate, user-initiated choice, recorded and reported as such. Nothing
 * in this file ever switches on its own.
 */
import { requestProvider } from './request-provider.js';
import { chooseProvider, createProvider, isLocalProvider, type ProviderName } from './select-provider.js';
import {
  DEFAULT_LOCAL_BASE_URL,
  LOCAL_BASE_URL_ENV,
  LOCAL_CODE_BASE_URL_ENV,
  probeModels,
  readLocalBaseUrl,
  readLocalCodeBaseUrl,
} from './local.js';
import {
  isOpenAiService,
  listServedModels,
  missingModelHint,
  missingSetting,
  OPENAI_SERVICES,
  type OpenAiServiceName,
} from './openai-services.js';
import type { CompletionProvider, CompletionRequest, CompletionResult } from './provider.js';

/** The key `settings-store.ts` holds the persisted choice under. */
export const PROVIDER_SETTING_KEY = 'llm.provider';

/**
 * Where the local inference server is, when it is not on loopback.
 *
 * Persisted separately from the provider choice because it changes for a
 * different reason and on a different cadence: a tunnel to a cloud GPU
 * (Colab's free T4 being the reason this exists at all) hands out a fresh
 * hostname every session, so this is edited far more often than the choice
 * of provider itself ever is.
 */
export const LOCAL_BASE_URL_SETTING_KEY = 'llm.localBaseUrl';

/**
 * Where the local CODE model is served from. A second key, not a reuse of
 * the first, because the coder may live in the planner's Colab session
 * (same URL) or in its own (a second tunnel) - and which of the two it is
 * changes per session, so it has to be editable on its own.
 */
export const LOCAL_CODE_BASE_URL_SETTING_KEY = 'llm.localCodeBaseUrl';

/**
 * Which provider writes application CODE, when it should differ from the one
 * that writes the plan. Stored as a provider name, or `CODE_PROVIDER_SAME`.
 *
 * Exists because the two jobs need different models: the fine-tuned local
 * checkpoint was trained on ProjectSchema output only (zero code rows), and
 * live runs showed it failing `npm run build` on plans Gemini built cleanly
 * first time. Planning locally and generating code with a vendor model is
 * the working combination - and flipping one dropdown between the two steps
 * every time is exactly the kind of step people forget.
 */
export const CODE_PROVIDER_SETTING_KEY = 'llm.codeProvider';
export const CODE_PROVIDER_SAME = 'same';

/**
 * Every provider a user may pick between, in the order the picker shows them:
 * the free options first - Gemini's free tier, then the free OpenAI-compatible
 * services, then the person's own GPU - and the paid vendors last.
 */
export const SELECTABLE_PROVIDERS: readonly ProviderName[] = [
  'gemini',
  'groq',
  'openrouter',
  'github',
  'ollama',
  'local',
  'local-code',
  'openai-compatible',
  'anthropic',
  'bluesminds',
];

export const PROVIDER_LABELS: Readonly<Record<ProviderName, string>> = {
  gemini: 'Gemini (free tier, cloud)',
  groq: OPENAI_SERVICES.groq.label,
  openrouter: OPENAI_SERVICES.openrouter.label,
  github: OPENAI_SERVICES.github.label,
  ollama: OPENAI_SERVICES.ollama.label,
  local: 'Local model (this machine)',
  'local-code': 'Local code model (Qwen2.5-Coder)',
  'openai-compatible': OPENAI_SERVICES['openai-compatible'].label,
  anthropic: 'Anthropic (cloud)',
  bluesminds: 'Bluesminds (cloud)',
};

export interface ProviderStatus {
  readonly id: ProviderName;
  readonly label: string;
  /** The model that would actually serve requests if this one were selected. */
  readonly model: string;
  /** False means picking it would fail - no key configured, or nothing listening locally. */
  readonly available: boolean;
  /** Plain-language reason, shown to the user. Always populated, available or not. */
  readonly detail: string;
}

/**
 * Is the local inference server up?
 *
 * Only when `GET /models` answers with the server's own model list.
 * Counting any HTTP answer as "up" was wrong for every tunnelled setup: a
 * Colab, Lightning or cloudflared tunnel answers with its own 404 or 502
 * page while the inference server behind it is stopped, so the picker showed
 * a ready model and every request then failed. `local_inference_server.py`
 * (and the Modal deployment, which runs it) serves `GET /models`; a
 * transport failure, a timeout, an error status or any other body means
 * "not running".
 */
export async function probeLocalServer(
  baseUrl: string = DEFAULT_LOCAL_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return (await probeModels(baseUrl, fetchImpl)) !== null;
}

export interface ProviderRegistry {
  /** The currently selected provider - what `createSwitchableProvider` dispatches to. */
  current(): ProviderName;
  /**
   * Switches. Returns false (and changes nothing) for a provider this build
   * does not recognise, so a bad persisted value or a malformed request can
   * never leave the registry pointing at nothing.
   */
  select(provider: ProviderName): boolean;
  /** One entry per selectable provider, with real availability. Probes the network only for `local` and `local-code`. */
  status(): Promise<readonly ProviderStatus[]>;
  /** The concrete provider for the current selection, or null when it cannot be constructed (no key). */
  resolve(): Promise<CompletionProvider | null>;
  /** The provider chosen for code generation, or null when it follows `current()`. */
  codeSelection(): ProviderName | null;
  /** Sets (or, with null, clears) the code-generation override. Returns false for an unrecognised provider. */
  selectCode(provider: ProviderName | null): boolean;
  /** The concrete provider code generation should use right now. */
  resolveCode(): Promise<CompletionProvider | null>;
  /** The provider name code generation resolves to right now - the override, or the plan provider. */
  currentCode(): ProviderName;
  /** Where the local inference server is currently expected to be. */
  localBaseUrl(): string;
  /** Points `local` at a different origin. Returns false for anything that is not a usable http(s) URL. */
  setLocalBaseUrl(baseUrl: string): boolean;
  /** Where the local code model's inference server is currently expected to be. */
  localCodeBaseUrl(): string;
  /** Points `local-code` at a different origin. Same validation as `setLocalBaseUrl`. */
  setLocalCodeBaseUrl(baseUrl: string): boolean;
}

export interface ProviderRegistryOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Restores a previously persisted choice. Ignored when it names a provider this build does not have. */
  readonly initial?: string | null;
  /** Restores a previously persisted local origin. Falls back to the env var, then loopback. */
  readonly initialLocalBaseUrl?: string | null;
  /** Restores a persisted local CODE origin. Falls back to its env var, then to the planner's origin. */
  readonly initialLocalCodeBaseUrl?: string | null;
  /** Restores a persisted code-generation override - a provider name, or `CODE_PROVIDER_SAME`/null for none. */
  readonly initialCode?: string | null;
  /** Called whenever the code-generation override changes; null means it was cleared. */
  readonly onSelectCode?: (provider: ProviderName | null) => void;
  /** Called whenever the selection actually changes, so the caller can persist it. */
  readonly onSelect?: (provider: ProviderName) => void;
  /** Called whenever the local origin actually changes, so the caller can persist it. */
  readonly onLocalBaseUrl?: (baseUrl: string) => void;
  /** Called whenever the local CODE origin actually changes, so the caller can persist it. */
  readonly onLocalCodeBaseUrl?: (baseUrl: string) => void;
  readonly fetchImpl?: typeof fetch;
}

/** True when `candidate` would be accepted by setLocalBaseUrl / setLocalCodeBaseUrl. */
export function isValidBaseUrl(candidate: string): boolean {
  return normaliseBaseUrl(candidate) !== null;
}

/** http(s) only, and a parseable origin: anything else would be stored, probed, and fail later with a confusing transport error instead of being rejected where it was typed. */
function normaliseBaseUrl(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

function isProviderName(value: string | null | undefined): value is ProviderName {
  return value !== null && value !== undefined && SELECTABLE_PROVIDERS.includes(value as ProviderName);
}

export function createProviderRegistry(options: ProviderRegistryOptions = {}): ProviderRegistry {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  // The persisted choice wins over the environment, because it is the more
  // recent and more deliberate of the two: the env var is a default, a stored
  // choice is something a person actually clicked. An unrecognised stored
  // value falls through to the env default rather than throwing - see
  // settings-store.ts's own note on never trusting the database's types.
  let selected: ProviderName = isProviderName(options.initial)
    ? options.initial
    : chooseProvider(env).provider;

  let codeSelected: ProviderName | null = isProviderName(options.initialCode) ? options.initialCode : null;

  let localBaseUrl = normaliseBaseUrl(options.initialLocalBaseUrl ?? '') ?? readLocalBaseUrl(env);
  // Null until someone gives the coder an origin of its own (persisted, env
  // var, or typed in). Until then it FOLLOWS the planner's origin - live, not
  // captured at startup - so in the single-Colab-session case pasting one
  // tunnel URL into the Model field moves both, and nobody has to paste it
  // twice.
  let explicitCodeBaseUrl: string | null =
    normaliseBaseUrl(options.initialLocalCodeBaseUrl ?? '') ??
    normaliseBaseUrl(env[LOCAL_CODE_BASE_URL_ENV] ?? '');
  const localCodeBaseUrl = (): string => explicitCodeBaseUrl ?? readLocalCodeBaseUrl({ [LOCAL_BASE_URL_ENV]: localBaseUrl });

  /** Constructed once each and reused: `createProvider` loads a vendor module, and a picker that rebuilt providers per keystroke would pay that repeatedly. */
  const constructed = new Map<ProviderName, CompletionProvider | null>();

  function envFor(name: ProviderName): NodeJS.ProcessEnv {
    // The local origin is threaded in as the env var `chooseProvider` already
    // reads, rather than as a second parallel channel, so there is exactly
    // one path a base URL can travel and the runtime setting and the
    // environment cannot disagree about which won.
    return {
      ...env,
      VIBE_LLM_PROVIDER: name,
      [LOCAL_BASE_URL_ENV]: localBaseUrl,
      [LOCAL_CODE_BASE_URL_ENV]: localCodeBaseUrl(),
    };
  }

  async function providerFor(name: ProviderName): Promise<CompletionProvider | null> {
    const existing = constructed.get(name);
    if (existing !== undefined) return existing;
    // `chooseProvider` reads the env for THIS provider specifically, rather
    // than reusing the ambient selection, so switching picks up that
    // provider's own key and model - not the previously selected one's.
    const built = await createProvider(chooseProvider(envFor(name)));
    constructed.set(name, built);
    return built;
  }

  return {
    current: () => selected,

    select: (provider) => {
      if (!SELECTABLE_PROVIDERS.includes(provider)) return false;
      if (provider !== selected) {
        selected = provider;
        options.onSelect?.(provider);
      }
      return true;
    },

    codeSelection: () => codeSelected,

    selectCode: (provider) => {
      if (provider !== null && !SELECTABLE_PROVIDERS.includes(provider)) return false;
      if (provider !== codeSelected) {
        codeSelected = provider;
        options.onSelectCode?.(provider);
      }
      return true;
    },

    currentCode: () => codeSelected ?? selected,

    resolveCode: () => providerFor(codeSelected ?? selected),

    localBaseUrl: () => localBaseUrl,

    setLocalBaseUrl: (candidate) => {
      const normalised = normaliseBaseUrl(candidate);
      if (normalised === null) return false;
      if (normalised !== localBaseUrl) {
        localBaseUrl = normalised;
        // The cached local provider captured the OLD origin, so it must go -
        // otherwise pointing at a new Colab tunnel would keep talking to the
        // dead one, and the picker would show a reachable server while every
        // request still failed.
        constructed.delete('local');
        // The coder follows the planner while it has no origin of its own.
        if (explicitCodeBaseUrl === null) constructed.delete('local-code');
        options.onLocalBaseUrl?.(normalised);
      }
      return true;
    },

    localCodeBaseUrl,

    setLocalCodeBaseUrl: (candidate) => {
      const normalised = normaliseBaseUrl(candidate);
      if (normalised === null) return false;
      if (normalised !== localCodeBaseUrl()) {
        constructed.delete('local-code');
        options.onLocalCodeBaseUrl?.(normalised);
      }
      // Recorded even when equal to the followed value: from here on the
      // coder is pinned, and a later planner change must not drag it along.
      explicitCodeBaseUrl = normalised;
      return true;
    },

    status: async () => {
      const codeUrl = localCodeBaseUrl();
      const [localUp, codeUp, serviceStatuses] = await Promise.all([
        probeLocalServer(localBaseUrl, fetchImpl),
        probeLocalServer(codeUrl, fetchImpl),
        Promise.all(
          SELECTABLE_PROVIDERS.filter(isOpenAiService).map((id) => serviceStatus(id, chooseProvider(envFor(id)), fetchImpl)),
        ),
      ]);
      const byService = new Map(serviceStatuses.map((entry) => [entry.id, entry]));
      // Up means /models answered (probeLocalServer); fetched again here for
      // the names it serves, reported when known.
      const served = codeUp ? await probeModels(codeUrl, fetchImpl) : null;
      return SELECTABLE_PROVIDERS.map((id) => {
        const service = byService.get(id);
        if (service !== undefined) return service;
        const choice = chooseProvider(envFor(id));
        if (isLocalProvider(id)) {
          const url = id === 'local' ? localBaseUrl : codeUrl;
          const up = id === 'local' ? localUp : codeUp;
          const names = id === 'local-code' && served !== null ? served.models.map((entry) => entry.name) : [];
          return {
            id,
            label: PROVIDER_LABELS[id],
            model: choice.model,
            available: up,
            detail: up
              ? names.length > 0
                ? `Reachable at ${url} - serving ${names.join(', ')}`
                : `Reachable at ${url}`
              : `No inference server answering at ${url} (a tunnel's own page does not count) - start local_inference_server.py there first`,
          };
        }
        const available = choice.apiKey !== null;
        return {
          id,
          label: PROVIDER_LABELS[id],
          model: choice.model,
          available,
          detail: available ? `${choice.keyEnv} is set` : `${choice.keyEnv} is not set`,
        };
      });
    },

    resolve: () => providerFor(selected),
  };
}

/**
 * Availability for an OpenAI-compatible service. A cloud service is ready
 * once its key is set; a keyless one (Ollama, a local compatible server) is
 * probed, because "configured" says nothing about whether it is running.
 * When something is missing, the detail says how to get it for free.
 */
async function serviceStatus(
  id: OpenAiServiceName,
  choice: ReturnType<typeof chooseProvider>,
  fetchImpl: typeof fetch,
): Promise<ProviderStatus> {
  const service = OPENAI_SERVICES[id];
  const settings = { baseUrl: choice.baseUrl ?? service.baseUrl, apiKey: choice.apiKey, keyEnv: choice.keyEnv, model: choice.model };
  // The generic server has no default model; name the setting rather than show a blank.
  const base = { id, label: PROVIDER_LABELS[id], model: choice.model === '' ? `set ${service.modelEnv}` : choice.model };
  const missing = missingSetting(service, settings);
  if (missing !== null) return { ...base, available: false, detail: `${missing} - ${service.howToGet}` };
  if (settings.apiKey !== null) return { ...base, available: true, detail: `${settings.keyEnv} is set` };
  const served = await listServedModels(settings.baseUrl, fetchImpl);
  if (!served.reachable) {
    return { ...base, available: false, detail: `Nothing answering at ${settings.baseUrl} - ${service.howToGet}` };
  }
  // Running is not enough: a local runtime answers 404 for a model it has
  // not downloaded, and the picker is the place to say so, not the first request.
  if (served.models !== null && !served.models.includes(settings.model)) {
    return {
      ...base,
      available: false,
      detail: `Running at ${settings.baseUrl}, but ${settings.model} is not installed - ${missingModelHint(service, settings.model)}`,
    };
  }
  return { ...base, available: true, detail: `Reachable at ${settings.baseUrl}` };
}

/**
 * A `CompletionProvider` whose identity is stable but whose behaviour follows
 * the registry's current selection. `name`/`model` are getters, not captured
 * values, so anything that reports which model answered (the CLI's run
 * summary, a cache key, a job's recorded model) reports the one actually in
 * use rather than whichever was selected at startup.
 *
 * A `complete()` call resolves the target ONCE, up front, and keeps it for
 * the whole call - switching provider mid-request cannot retarget a request
 * that is already in flight.
 */
export function createSwitchableProvider(
  registry: ProviderRegistry,
  fallbackModel: string,
  role: 'plan' | 'code' = 'plan',
): CompletionProvider {
  let lastKnown: CompletionProvider | null = null;
  const currentName = (): ProviderName => (role === 'code' ? registry.currentCode() : registry.current());

  return {
    get name(): string {
      return requestProvider()?.name ?? lastKnown?.name ?? `${currentName()}:${fallbackModel}`;
    },
    get model(): string {
      return requestProvider()?.model ?? lastKnown?.model ?? fallbackModel;
    },
    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      // The person's own key, when their request brought one (request-provider.ts).
      const own = requestProvider();
      if (own !== undefined) return own.complete(request);
      const target = role === 'code' ? await registry.resolveCode() : await registry.resolve();
      if (target === null) {
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: `no credentials configured for the selected provider '${currentName()}'`,
            // Retrying cannot help: this is a configuration problem, and the
            // same gap key rotation deliberately refuses to paper over.
            retryable: false,
          },
        };
      }
      lastKnown = target;
      return target.complete(request);
    },
  };
}
