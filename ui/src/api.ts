/**
 * Thin client over the local JSON API. The only route into the pipeline.
 */
import type {
  CorrectionKind,
  CorrectionsResponse,
  EdgeResponse,
  GraphResponse,
  ModuleDetailResponse,
  ModuleViewResponse,
  NodeResponse,
  SummaryResponse,
  ViewLevel,
  IntentResponse,
  DriftHistoryResponse,
  DiffResponse,
} from './api-types';

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

export function fetchModules(): Promise<ModuleViewResponse> {
  return getJson<ModuleViewResponse>('/api/modules');
}

export function fetchModule(id: string): Promise<ModuleDetailResponse> {
  return getJson<ModuleDetailResponse>(`/api/module/${encodeURIComponent(id)}`);
}

export function fetchModuleEdge(id: string): Promise<EdgeResponse> {
  return getJson<EdgeResponse>(`/api/module-edge/${encodeURIComponent(id)}`);
}

export function fetchCorrections(): Promise<CorrectionsResponse> {
  return getJson<CorrectionsResponse>('/api/corrections');
}

export interface NewCorrectionRequest {
  kind: CorrectionKind;
  moduleIds: string[];
  label?: string;
  sides?: { label: string; files: string[] }[];
}

/** Saved immediately; takes effect on the next run, which the caller must say. */
export async function saveCorrection(request: NewCorrectionRequest): Promise<void> {
  const response = await fetch('/api/corrections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `save failed: ${response.status}`);
  }
}

export async function deleteCorrection(id: string): Promise<void> {
  const response = await fetch(`/api/corrections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`delete failed: ${response.status}`);
  }
}

export async function fetchIntent(): Promise<IntentResponse> {
  const response = await fetch('/api/intent');
  if (!response.ok) {
    throw new Error(`intent failed: ${response.status}`);
  }
  return (await response.json()) as IntentResponse;
}

export async function fetchDriftHistory(): Promise<DriftHistoryResponse> {
  const response = await fetch('/api/drift-history');
  // 404 carries a usable body here — "no snapshots yet" is a state, not a bug.
  return (await response.json()) as DriftHistoryResponse;
}

export async function fetchDiff(from: string, to: string): Promise<DiffResponse> {
  const response = await fetch(
    `/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return (await response.json()) as DiffResponse;
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
