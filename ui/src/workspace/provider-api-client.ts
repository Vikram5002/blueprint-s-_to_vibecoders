/**
 * Client for /api/providers (src/server/providers-api.ts) - which model
 * answers generation requests.
 *
 * Plain synchronous fetch, like page-builder-api-client.ts and unlike the
 * submit-and-poll job clients: selecting a provider is one assignment plus
 * one SQLite row, and the only slow part server-side is a local-server probe
 * bounded by its own short timeout.
 */
import type { ProviderName, ProvidersResponse } from './provider-types';

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return detail?.error ?? fallback;
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  const response = await fetch('/api/providers');
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `fetch providers failed: ${response.status}`));
  }
  return (await response.json()) as ProvidersResponse;
}

export async function selectProvider(provider: ProviderName): Promise<ProvidersResponse> {
  const response = await fetch('/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `select provider failed: ${response.status}`));
  }
  return (await response.json()) as ProvidersResponse;
}
