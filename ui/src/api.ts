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
  ViolationsResponse,
  SnapshotResponse,
  BlueprintResponse,
  SeedsResponse,
  BlueprintGraph,
  CompileBlueprintResponse,
  SaveBlueprintResponse,
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

export async function fetchViolations(): Promise<ViolationsResponse> {
  const response = await fetch('/api/violations');
  if (!response.ok) throw new Error(`violations failed: ${response.status}`);
  return (await response.json()) as ViolationsResponse;
}

export async function fetchSnapshot(commit: string): Promise<SnapshotResponse> {
  const response = await fetch(`/api/snapshot?commit=${encodeURIComponent(commit)}`);
  // 404 carries a usable body: "no snapshots yet" is a state, not a failure.
  return (await response.json()) as SnapshotResponse;
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

// --- Type-1 authoring (Parts A.1/A.2/A.3) ---

export function fetchBlueprint(): Promise<BlueprintResponse> {
  return getJson<BlueprintResponse>('/api/blueprint');
}

export function fetchBlueprintSeeds(): Promise<SeedsResponse> {
  return getJson<SeedsResponse>('/api/blueprint/seeds');
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Never persists — Part A.3's live DSL preview calls this on every edit. */
export function compileBlueprintDsl(dsl: string): Promise<CompileBlueprintResponse> {
  return postJson<CompileBlueprintResponse>('/api/blueprint/compile', { dsl });
}

/**
 * Same preview endpoint, fed a visual graph instead of typed text — the
 * server turns it into the identical DSL text before compiling. There is no
 * separate "compile a graph" code path on either side of this call.
 */
export function compileBlueprintGraph(graph: BlueprintGraph): Promise<CompileBlueprintResponse> {
  return postJson<CompileBlueprintResponse>('/api/blueprint/compile', { graph });
}

/** Replaces the entire stored blueprint — same semantics as `--blueprint=<file>`. */
export function saveBlueprintDsl(dsl: string): Promise<SaveBlueprintResponse> {
  return postJson<SaveBlueprintResponse>('/api/blueprint/save', { dsl });
}

export function saveBlueprintGraph(graph: BlueprintGraph): Promise<SaveBlueprintResponse> {
  return postJson<SaveBlueprintResponse>('/api/blueprint/save', { graph });
}

/** Accepting is the only way a seeded candidate ever reaches the store. */
export function acceptBlueprintSeeds(ids: string[]): Promise<{ accepted: unknown[] }> {
  return postJson<{ accepted: unknown[] }>('/api/blueprint/accept-seeds', { ids });
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
