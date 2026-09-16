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
import { SELECTABLE_PROVIDERS, type ProviderRegistry } from '../llm/provider-registry.js';
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

export function createProviderRoutes(deps: ProviderRouteDeps): Hono {
  const app = new Hono();

  app.get('/', async (c) =>
    c.json({ current: deps.registry.current(), providers: await deps.registry.status() }),
  );

  app.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);

    const provider = parseProviderRequest(body);
    if (provider === null) {
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
    return c.json({ current: deps.registry.current(), providers, warning: chosen?.available === false ? chosen.detail : undefined });
  });

  return app;
}
