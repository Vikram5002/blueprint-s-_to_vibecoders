/**
 * Client for /api/projects (src/server/projects-api.ts): which project the
 * analysis views show, and switching to another one.
 */
import type {
  AnalyseRequest,
  BrowseResponse,
  CurrentProject,
  ProjectJob,
  RecentProject,
} from './projects-types';

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function fetchCurrentProject(): Promise<CurrentProject> {
  const response = await fetch('/api/projects/current');
  if (!response.ok)
    throw new Error(await readError(response, `current project failed: ${response.status}`));
  return (await response.json()) as CurrentProject;
}

export async function fetchProjectJob(): Promise<ProjectJob> {
  const response = await fetch('/api/projects/job');
  if (!response.ok)
    throw new Error(await readError(response, `job status failed: ${response.status}`));
  return (await response.json()) as ProjectJob;
}

export async function fetchRecentProjects(): Promise<readonly RecentProject[]> {
  const response = await fetch('/api/projects/recent');
  if (!response.ok) return [];
  return ((await response.json()) as { recent: readonly RecentProject[] }).recent;
}

/** Starts an analysis. Resolves once the server has accepted it; poll `fetchProjectJob` for the outcome. */
export async function startAnalysis(request: AnalyseRequest): Promise<CurrentProject> {
  const response = await fetch('/api/projects/analyse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok)
    throw new Error(await readError(response, `analyse failed: ${response.status}`));
  return (await response.json()) as CurrentProject;
}

export async function switchToHomeProject(): Promise<CurrentProject> {
  const response = await fetch('/api/projects/home', { method: 'POST' });
  if (!response.ok) throw new Error(await readError(response, `switch failed: ${response.status}`));
  return (await response.json()) as CurrentProject;
}

export async function browseFolders(path: string): Promise<BrowseResponse> {
  const response = await fetch(`/api/projects/browse?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(await readError(response, `browse failed: ${response.status}`));
  return (await response.json()) as BrowseResponse;
}

/** Opens the operating system's own folder dialog on this machine. Null when cancelled. */
export async function pickFolderNatively(): Promise<string | null> {
  const response = await fetch('/api/projects/pick-folder', { method: 'POST' });
  if (!response.ok)
    throw new Error(await readError(response, `folder dialog failed: ${response.status}`));
  const body = (await response.json()) as { path?: string; cancelled?: boolean };
  return body.path ?? null;
}
