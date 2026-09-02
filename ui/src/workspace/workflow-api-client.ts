/**
 * Client for the real /api/workflow/jobs surface (src/server/workflow-api.ts).
 *
 * Submit-and-poll per docs/ADR-002-generation-api-request-model.md: `POST
 * /jobs` returns 202 immediately with just `{ id, status }` — the job is not
 * done, there is no result yet — and the caller polls `GET /jobs/:id` until
 * the job reaches a terminal status. Deliberately does NOT assume a
 * synchronous response the way a naive fetch-and-use-the-body client would;
 * that is exactly the contract ADR-002 rejected (Option A) because the local
 * model's 10.7-27s, zero-concurrency latency makes a single blocking call
 * unsafe.
 *
 * Follows ui/src/api.ts's existing fetch-based pattern (no client library),
 * kept in workspace/ rather than merged into api.ts since this hits a
 * separate Hono sub-app (`/api/workflow`, mounted only when an LLM provider
 * is configured) with its own job-shaped contract, not the analysis-graph
 * JSON API api.ts otherwise wraps.
 */
import type { WorkflowJob, WorkflowJobStatus } from './workflow-job-types';

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return detail?.error ?? fallback;
}

export interface SubmittedWorkflowJob {
  readonly id: string;
  readonly status: WorkflowJobStatus;
}

/** POSTs the prompt; resolves as soon as the server acknowledges (202), before generation starts. */
export async function submitWorkflowJob(prompt: string): Promise<SubmittedWorkflowJob> {
  const response = await fetch('/api/workflow/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `submit failed: ${response.status}`));
  }
  return (await response.json()) as SubmittedWorkflowJob;
}

export async function fetchWorkflowJob(id: string): Promise<WorkflowJob> {
  const response = await fetch(`/api/workflow/jobs/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `fetch job failed: ${response.status}`));
  }
  return (await response.json()) as WorkflowJob;
}

const TERMINAL_STATUSES: ReadonlySet<WorkflowJobStatus> = new Set(['succeeded', 'failed']);

/** Default cadence between polls. Cheap relative to generation's multi-second latency either provider measures. */
const DEFAULT_POLL_INTERVAL_MS = 1500;

export interface GenerateViaApiOptions {
  /** Called once per status transition, including the initial 'pending' from the 202 response. */
  readonly onStatus?: (status: WorkflowJobStatus) => void;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Submits a prompt and polls until the job reaches a terminal state,
 * resolving with the finished job either way (`succeeded` or `failed` — the
 * caller reads `.result` or `.error`, never a thrown exception for a job
 * that ran to completion). Throws only for a transport/HTTP-level failure —
 * the submit itself rejected (400/503), or a poll request failed outright.
 */
export async function generateProjectSchemaViaApi(
  prompt: string,
  options: GenerateViaApiOptions = {},
): Promise<WorkflowJob> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const submitted = await submitWorkflowJob(prompt);
  options.onStatus?.(submitted.status);

  for (;;) {
    if (options.signal?.aborted) {
      throw new DOMException('generation cancelled', 'AbortError');
    }

    const job = await fetchWorkflowJob(submitted.id);
    options.onStatus?.(job.status);
    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }

    await delay(pollIntervalMs, options.signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('generation cancelled', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
