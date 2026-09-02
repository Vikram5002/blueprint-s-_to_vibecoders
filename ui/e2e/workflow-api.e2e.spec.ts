import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Exercises the real /api/workflow/jobs + /api/workflow/jobs/:id HTTP
 * surface (docs/ADR-002-generation-api-request-model.md), against a real
 * running server — not app.request() in-process like
 * src/server/workflow-api.test.ts, and not mock data.
 *
 * Deliberately does NOT import anything from src/server/ into ui/e2e/ —
 * that would itself be the exact ui/-must-not-import-src/ violation
 * CLAUDE.md rule 4 exists to prevent, even in test code. Instead this
 * spawns the real built CLI (dist/cli.js) as a subprocess and talks to it
 * over real HTTP, the same way an actual user's browser would — arguably a
 * more genuine end-to-end path than an in-process import.
 *
 * Requires `npm run build` at the repo root to have produced dist/cli.js
 * with the workflow routes and ui/ static assets.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli.js');
const FIXTURE_PATH = resolve(REPO_ROOT, 'src/graph/fixtures/ts-monorepo');

interface RunningCli {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Spawns `node dist/cli.js <fixture> --no-open` with cwd = repo root, so
 * the real .env at the root loads exactly the way it does for a real user
 * (see src/cli.ts's own comment: `.env` is loaded once, at the process
 * boundary). Waits for the real "Blueprint ready at http://..." line
 * server.ts's formatServing() prints, which carries the OS-assigned port.
 */
async function startCli(): Promise<RunningCli> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI_PATH, FIXTURE_PATH, '--no-open'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });

  const baseUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      rejectUrl(new Error(`CLI did not print a server URL within 30s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 30_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolveUrl(match[0]);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      rejectUrl(new Error(`CLI exited early with code ${code} before printing a server URL.\nstderr: ${stderr}`));
    });
  });

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolveStop) => {
        child.once('exit', () => resolveStop());
        child.kill();
      }),
  };
}

/** Not aggressive on purpose — Gemini measures 3-16s, the local model 10.7-27s (ADR-002). */
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

interface WorkflowJobResponse {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly result?: {
    readonly schema: { readonly domains: Record<string, unknown> };
    readonly prohibitions: readonly unknown[];
    readonly permissions: readonly unknown[];
  };
  readonly error?: { readonly phase: string };
}

test.describe('real workflow API — POST /jobs, GET /jobs/:id', () => {
  test.setTimeout(120_000);

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  });

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('submit-and-poll against a real live provider, with prohibitions and permissions kept as separate fields', async ({
    request,
  }) => {
    const submitted = await request.post(`${cli.baseUrl}/api/workflow/jobs`, {
      data: { prompt: 'A dice roller for tabletop games, no accounts, purely local.' },
    });

    // Presence-only: this is exactly the signal src/server/workflow-api.ts's
    // POST handler already gives when createProvider() resolved null (no
    // GEMINI_API_KEY / ANTHROPIC_API_KEY / BLUESMINDS_API_KEY in this
    // environment's .env) — the same real check workflow-api.test.ts's own
    // live-path test relies on, reused here rather than re-implemented by
    // reading .env ourselves. Never logs a key value, only whether one
    // resolved.
    if (submitted.status() === 503) {
      const body = (await submitted.json()) as { error: string };
      test.skip(
        true,
        `No live provider available in this environment (server responded 503: "${body.error}"). ` +
          'Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or BLUESMINDS_API_KEY to exercise this test against a real call.',
      );
      return;
    }

    // ADR-002's whole point: the POST returns before generation starts, not
    // after it finishes. If this were a flattened synchronous design, this
    // assertion would be the first thing to fail once a live provider is
    // configured.
    expect(submitted.status()).toBe(202);
    const submittedBody = (await submitted.json()) as { id: string; status: string };
    expect(submittedBody.status).toBe('pending');
    expect(submittedBody.id).toBeTruthy();

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let job: WorkflowJobResponse;
    for (;;) {
      const response = await request.get(`${cli.baseUrl}/api/workflow/jobs/${submittedBody.id}`);
      expect(response.status()).toBe(200);
      job = (await response.json()) as WorkflowJobResponse;

      if (job.status === 'succeeded' || job.status === 'failed') break;
      if (Date.now() > deadline) {
        throw new Error(`job ${submittedBody.id} did not reach a terminal state within ${POLL_TIMEOUT_MS}ms (last status: ${job.status})`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
    }

    if (job.status === 'failed') {
      throw new Error(`job failed (phase: ${job.error?.phase ?? 'unknown'}) — see server stderr for details`);
    }

    expect(job.status).toBe('succeeded');
    if (job.result === undefined) {
      throw new Error(`job succeeded but carried no result: ${JSON.stringify(job)}`);
    }

    // Real, validated ProjectSchema from a real model call — not a fixture.
    expect(Object.keys(job.result.schema.domains).sort()).toEqual(['backend', 'database', 'frontend', 'security']);

    // ADR-001: prohibitions and permissions stay two separate fields, never
    // flattened into one list.
    expect(Array.isArray(job.result.prohibitions)).toBe(true);
    expect(Array.isArray(job.result.permissions)).toBe(true);
    expect('prohibitions' in job.result && 'permissions' in job.result).toBe(true);
    // Real compileDomainConstraints() invariant for 4 fixed domains: exactly
    // 12 ordered pairs, split across the two fields above.
    expect(job.result.prohibitions.length + job.result.permissions.length).toBe(12);
  });

  // MAX_CONCURRENT_JOBS rejection (503 + Retry-After) is deliberately NOT
  // duplicated here. It's already covered, fast and deterministic, by
  // workflow-api.test.ts's unit test using a stuckGenerator() that never
  // resolves — the only way to hold MAX_CONCURRENT_JOBS jobs open reliably
  // without waiting on real latency. Reproducing that at this e2e level
  // would mean firing 9 real live-provider calls (real cost, real quota,
  // 3-27s each per ADR-002's measured latencies) just to prove a
  // capacity-counting edge case the unit test already proves for free.
  // Left as a unit-level concern.
});
