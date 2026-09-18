/**
 * HTTP surface for choosing which model answers generation requests.
 *
 * Synchronous, like page-builder-api.ts and unlike the job-shaped generation
 * routes: selecting a provider is a single in-memory assignment plus one
 * SQLite row, and the only slow part is the local-server probe on GET, which
 * is bounded by its own short timeout (provider-registry.ts).
 *
 * Mounted unconditionally. A user with NO provider configured still needs to
 * see that - an endpoint that only exists once you already have credentials
 * could never tell you which ones you are missing.
 */
import { Hono } from 'hono';
import { CODE_PROVIDER_SAME, SELECTABLE_PROVIDERS, type ProviderRegistry } from '../llm/provider-registry.js';
import type { ProviderName } from '../llm/select-provider.js';

export interface ProviderRouteDeps {
  readonly registry: ProviderRegistry;
}

function parseProviderRequest(body: unknown): ProviderName | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { provider?: unknown }).provider;
  if (typeof value !== 'string') return null;
  return SELECTABLE_PROVIDERS.includes(value as ProviderName) ? (value as ProviderName) : null;
}

/** `undefined`: the field was absent. `null`: clear the override (`'same'`). `false`: present but invalid. */
function parseCodeProviderRequest(body: unknown): ProviderName | null | undefined | false {
  if (typeof body !== 'object' || body === null || !('codeProvider' in body)) return undefined;
  const value = (body as { codeProvider?: unknown }).codeProvider;
  if (value === CODE_PROVIDER_SAME || value === null) return null;
  if (typeof value === 'string' && SELECTABLE_PROVIDERS.includes(value as ProviderName)) return value as ProviderName;
  return false;
}

async function snapshot(registry: ProviderRegistry) {
  return {
    current: registry.current(),
    codeProvider: registry.codeSelection(),
    localBaseUrl: registry.localBaseUrl(),
    localCodeBaseUrl: registry.localCodeBaseUrl(),
    providers: await registry.status(),
  };
}

export function createProviderRoutes(deps: ProviderRouteDeps): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await snapshot(deps.registry)));

  app.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);

    // A request may carry either field or both: pointing at a freshly-started
    // Colab tunnel AND switching to it is one user action, and splitting it
    // into two round trips would leave a visible window where `local` is
    // selected but still aimed at the previous, dead origin.
    const requestedUrl =
      typeof body === 'object' && body !== null ? (body as { localBaseUrl?: unknown }).localBaseUrl : undefined;
    if (requestedUrl !== undefined) {
      if (typeof requestedUrl !== 'string' || !deps.registry.setLocalBaseUrl(requestedUrl)) {
        return c.json({ error: 'localBaseUrl must be an http(s) URL, e.g. https://something.trycloudflare.com' }, 400);
      }
    }

    const requestedCodeUrl =
      typeof body === 'object' && body !== null ? (body as { localCodeBaseUrl?: unknown }).localCodeBaseUrl : undefined;
    if (requestedCodeUrl !== undefined) {
      if (typeof requestedCodeUrl !== 'string' || !deps.registry.setLocalCodeBaseUrl(requestedCodeUrl)) {
        return c.json({ error: 'localCodeBaseUrl must be an http(s) URL, e.g. https://something.trycloudflare.com' }, 400);
      }
    }

    const codeProvider = parseCodeProviderRequest(body);
    if (codeProvider === false) {
      return c.json({ error: `codeProvider must be '${CODE_PROVIDER_SAME}' or one of ${SELECTABLE_PROVIDERS.join(', ')}` }, 400);
    }
    if (codeProvider !== undefined) deps.registry.selectCode(codeProvider);

    const provider = parseProviderRequest(body);
    if (provider === null) {
      // A URL-only or code-only update is a complete, valid request on its own.
      if (requestedUrl !== undefined || requestedCodeUrl !== undefined || codeProvider !== undefined) {
        return c.json(await snapshot(deps.registry));
      }
      return c.json(
        { error: `expected { provider: one of ${SELECTABLE_PROVIDERS.join(', ')} }` },
        400,
      );
    }

    // Deliberately allows selecting a provider that is not currently
    // available, and says so rather than refusing. Someone who is about to
    // start their local server should be able to select it first, and a
    // refusal here would report a transient probe result as if it were a
    // permanent fact. The real consequence of choosing an unavailable
    // provider is a clear failure on the next generation, not a silent
    // fallback to a different model.
    deps.registry.select(provider);
    const providers = await deps.registry.status();
    const chosen = providers.find((entry) => entry.id === provider);
    return c.json({
      current: deps.registry.current(),
      codeProvider: deps.registry.codeSelection(),
      localBaseUrl: deps.registry.localBaseUrl(),
      localCodeBaseUrl: deps.registry.localCodeBaseUrl(),
      providers,
      warning: chosen?.available === false ? chosen.detail : undefined,
    });
  });

  return app;
}
