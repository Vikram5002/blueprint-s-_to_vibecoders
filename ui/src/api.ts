/**
 * Thin client over the local JSON API. The only route into the pipeline.
 */
import type { EdgeResponse, GraphResponse, NodeResponse, SummaryResponse, ViewLevel } from './api-types';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchSummary(): Promise<SummaryResponse> {
  return getJson<SummaryResponse>('/api/summary');
}

export function fetchGraph(level: ViewLevel, expanded: readonly string[]): Promise<GraphResponse> {
  const params = new URLSearchParams({ level });
  for (const directory of expanded) {
    params.append('expand', directory);
  }
  return getJson<GraphResponse>(`/api/graph?${params.toString()}`);
}

export function fetchNode(id: string): Promise<NodeResponse> {
  return getJson<NodeResponse>(`/api/node/${encodePathId(id)}`);
}

export function fetchEdge(id: string): Promise<EdgeResponse> {
  return getJson<EdgeResponse>(`/api/edge/${id}`);
}

/**
 * Node ids are repo-relative paths; keep the slashes, escape everything else.
 *
 * The repository-root node's id is `.`, which no amount of encoding preserves:
 * browsers normalise a dot path segment away, and Chrome does it to `%2E` too.
 * The request therefore arrives as /api/node/ with an empty remainder, and the
 * server reads that as the root. Nothing to do here but not make it worse.
 */
function encodePathId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}
