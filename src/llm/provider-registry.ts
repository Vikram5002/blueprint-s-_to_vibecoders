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
import { chooseProvider, createProvider, type ProviderName } from './select-provider.js';
import { DEFAULT_LOCAL_BASE_URL, LOCAL_BASE_URL_ENV, readLocalBaseUrl } from './local.js';
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

/** Every provider a user may pick between, in the order the picker shows them. */
export const SELECTABLE_PROVIDERS: readonly ProviderName[] = ['gemini', 'local', 'anthropic', 'bluesminds'];

export const PROVIDER_LABELS: Readonly<Record<ProviderName, string>> = {
  gemini: 'Gemini (cloud)',
  local: 'Local model (this machine)',
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
 * How long to wait for the local inference server to answer before calling it
 * unreachable. Short on purpose: this runs to render a picker, not to serve a
 * request, and a hung probe would stall the UI. The real request timeout is
 * `local.ts`'s own 300s, which is a completely different question - "is
 * anything listening" vs "how long may generation take".
 *
 * Sized for a tunnelled origin rather than loopback: a cloud-GPU tunnel's
 * first request crosses a real network and can take a second or two to
 * establish, and reporting a working Colab server as "not running" because
 * a loopback-sized budget expired would be worse than a slightly slower
 * picker.
 */
const LOCAL_PROBE_TIMEOUT_MS = 4_000;

/**
 * Is the local inference server up?
 *
 * ANY HTTP response counts, including a 404: `local_inference_server.py`
 * exposes only `POST /complete` and has no health endpoint, so a GET to the
 * base URL is expected to be refused by the route table - which still proves
 * a server is listening and is exactly what this needs to know. Only a
 * transport-level failure (connection refused, DNS, timeout) means "not
 * running".
 */
export async function probeLocalServer(
  baseUrl: string = DEFAULT_LOCAL_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetchImpl(baseUrl, { method: 'GET', signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
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
  /** One entry per selectable provider, with real availability. Probes the network only for `local`. */
  status(): Promise<readonly ProviderStatus[]>;
  /** The concrete provider for the current selection, or null when it cannot be constructed (no key). */
  resolve(): Promise<CompletionProvider | null>;
  /** Where the local inference server is currently expected to be. */
  localBaseUrl(): string;
  /** Points `local` at a different origin. Returns false for anything that is not a usable http(s) URL. */
  setLocalBaseUrl(baseUrl: string): boolean;
}

export interface ProviderRegistryOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Restores a previously persisted choice. Ignored when it names a provider this build does not have. */
  readonly initial?: string | null;
  /** Restores a previously persisted local origin. Falls back to the env var, then loopback. */
  readonly initialLocalBaseUrl?: string | null;
  /** Called whenever the selection actually changes, so the caller can persist it. */
  readonly onSelect?: (provider: ProviderName) => void;
  /** Called whenever the local origin actually changes, so the caller can persist it. */
  readonly onLocalBaseUrl?: (baseUrl: string) => void;
  readonly fetchImpl?: typeof fetch;
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

  let localBaseUrl = normaliseBaseUrl(options.initialLocalBaseUrl ?? '') ?? readLocalBaseUrl(env);

  /** Constructed once each and reused: `createProvider` loads a vendor module, and a picker that rebuilt providers per keystroke would pay that repeatedly. */
  const constructed = new Map<ProviderName, CompletionProvider | null>();

  function envFor(name: ProviderName): NodeJS.ProcessEnv {
    // The local origin is threaded in as the env var `chooseProvider` already
    // reads, rather than as a second parallel channel, so there is exactly
    // one path a base URL can travel and the runtime setting and the
    // environment cannot disagree about which won.
    return { ...env, VIBE_LLM_PROVIDER: name, [LOCAL_BASE_URL_ENV]: localBaseUrl };
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
        options.onLocalBaseUrl?.(normalised);
      }
      return true;
    },

    status: async () => {
      const localUp = await probeLocalServer(localBaseUrl, fetchImpl);
      return SELECTABLE_PROVIDERS.map((id) => {
        const choice = chooseProvider(envFor(id));
        if (id === 'local') {
          return {
            id,
            label: PROVIDER_LABELS[id],
            model: choice.model,
            available: localUp,
            detail: localUp
              ? `Reachable at ${localBaseUrl}`
              : `No server responding at ${localBaseUrl} - start local_inference_server.py first`,
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
export function createSwitchableProvider(registry: ProviderRegistry, fallbackModel: string): CompletionProvider {
  let lastKnown: CompletionProvider | null = null;

  return {
    get name(): string {
      return lastKnown?.name ?? `${registry.current()}:${fallbackModel}`;
    },
    get model(): string {
      return lastKnown?.model ?? fallbackModel;
    },
    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      const target = await registry.resolve();
      if (target === null) {
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: `no credentials configured for the selected provider '${registry.current()}'`,
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
