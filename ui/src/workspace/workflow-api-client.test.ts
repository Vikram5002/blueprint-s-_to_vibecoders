import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWorkflowJob, generateProjectSchemaViaApi, submitWorkflowJob } from './workflow-api-client';
import type { WorkflowJob } from './workflow-job-types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('submitWorkflowJob', () => {
  it('posts the prompt and returns the 202 body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'job-1', status: 'pending' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitWorkflowJob('build a todo app');

    expect(result).toEqual({ id: 'job-1', status: 'pending' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workflow/jobs',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ prompt: 'build a todo app' }) }),
    );
  });

  it('surfaces the server error message on a non-2xx response, e.g. capacity rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'at capacity: 8 job(s) already pending or running' }, 503)),
    );

    await expect(submitWorkflowJob('x')).rejects.toThrow('at capacity: 8 job(s) already pending or running');
  });
});

describe('fetchWorkflowJob', () => {
  it('returns the job body on success', async () => {
    const job: WorkflowJob = { id: 'job-1', prompt: 'x', createdAt: 'now', status: 'running' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(job)));

    await expect(fetchWorkflowJob('job-1')).resolves.toEqual(job);
  });

  it('throws on an unknown job id (404)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'unknown job: nope' }, 404)));

    await expect(fetchWorkflowJob('nope')).rejects.toThrow('unknown job: nope');
  });
});

describe('generateProjectSchemaViaApi', () => {
  it('polls pending -> running -> succeeded and resolves with the terminal job', async () => {
    const statuses: WorkflowJob[] = [
      { id: 'job-1', prompt: 'x', createdAt: 'now', status: 'running' },
      {
        id: 'job-1',
        prompt: 'x',
        createdAt: 'now',
        status: 'succeeded',
        result: {
          schema: {
            sessionId: 's1',
            title: 't',
            originalPrompt: 'x',
            domains: {
              frontend: { components: [], dependsOn: [] },
              backend: { components: [], dependsOn: [] },
              database: { components: [], dependsOn: [] },
              security: { components: [], dependsOn: [] },
            },
            constraints: [],
            provenance: 'STATED',
          },
          prohibitions: [],
          permissions: [],
        },
      },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'pending' }, 202))
      .mockResolvedValueOnce(jsonResponse(statuses[0]))
      .mockResolvedValueOnce(jsonResponse(statuses[1]));
    vi.stubGlobal('fetch', fetchMock);

    const seenStatuses: string[] = [];
    const job = await generateProjectSchemaViaApi('x', {
      pollIntervalMs: 0,
      onStatus: (status) => seenStatuses.push(status),
    });

    expect(job.status).toBe('succeeded');
    expect(job.result?.schema.sessionId).toBe('s1');
    expect(seenStatuses).toEqual(['pending', 'running', 'succeeded']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resolves with a failed terminal job rather than throwing, so the caller reads job.error', async () => {
    const failed: WorkflowJob = {
      id: 'job-2',
      prompt: 'x',
      createdAt: 'now',
      status: 'failed',
      error: { phase: 'generate', reason: 'provider-error', message: 'network down' },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 'job-2', status: 'pending' }, 202))
        .mockResolvedValueOnce(jsonResponse(failed)),
    );

    const job = await generateProjectSchemaViaApi('x', { pollIntervalMs: 0 });
    expect(job.status).toBe('failed');
    expect(job.error).toEqual({ phase: 'generate', reason: 'provider-error', message: 'network down' });
  });

  it('rejects with AbortError when the signal is aborted mid-poll', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.resolve(jsonResponse({ id: 'job-3', status: 'pending' }, 202));
      }),
    );

    await expect(generateProjectSchemaViaApi('x', { signal: controller.signal, pollIntervalMs: 5 })).rejects.toThrow(
      /cancelled/,
    );
  });
});
