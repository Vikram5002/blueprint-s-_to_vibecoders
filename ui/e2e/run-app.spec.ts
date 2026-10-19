import { test, expect, type Page } from '@playwright/test';

/**
 * "Run app" on a run that built: starts the generated app, shows install
 * progress, then the live app in a frame, and "Stop app" ends it. A failed
 * start shows the server's reason. The API (and the app itself) are stubbed.
 */

test.use({ viewport: { width: 1280, height: 800 } });

const SESSION = 'mock-session-1';

function job(id: string, createdAt: string) {
  return {
    id,
    createdAt,
    sessionId: SESSION,
    kind: 'generate',
    status: 'succeeded',
    result: {
      files: [],
      regenerationLog: [],
      unresolvedViolations: [],
      unresolvedServiceLocatorFindings: [],
      build: { installOk: true, buildOk: true },
    },
  };
}

async function stub(
  page: Page,
  runCount: number,
  deleteStatus = 200,
): Promise<{ deleted: string[] }> {
  let jobs = [
    job('run-new', '2026-09-30T10:00:00.000Z'),
    job('run-old', '2026-09-29T10:00:00.000Z'),
  ].slice(0, runCount);
  const deleted: string[] = [];
  await page.route(`**/api/workflow/sessions/${SESSION}/application-runs`, (route) =>
    route.fulfill({
      json: {
        runs: jobs.map(({ id, sessionId, kind, status, createdAt }) => ({
          id,
          sessionId,
          kind,
          parentId: null,
          status,
          createdAt,
        })),
        latest: jobs[0] ?? null,
      },
    }),
  );
  await page.route('**/api/workflow/application-runs/*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = decodeURIComponent(route.request().url().split('/').pop() ?? '');
    if (deleteStatus !== 200) {
      return route.fulfill({
        status: deleteStatus,
        json: {
          error: 'a job of this session is still running - wait for it to finish, then delete',
        },
      });
    }
    deleted.push(id);
    jobs = jobs.filter((entry) => entry.id !== id);
    return route.fulfill({ json: { deleted: id } });
  });
  await page.route('**/api/workflow/application-jobs/*/pages', (route) =>
    route.fulfill({ json: { pages: [] } }),
  );
  await page.route('**/api/workflow/sessions', (route) =>
    route.fulfill({ json: { sessions: [] } }),
  );
  await page.route('**/api/workflow/application-runs/latest', (route) =>
    route.fulfill({ json: { runs: [] } }),
  );
  await page.route('**/api/providers', (route) =>
    route.fulfill({
      json: {
        current: 'gemini',
        codeProvider: null,
        localBaseUrl: '',
        localCodeBaseUrl: '',
        providers: [],
      },
    }),
  );
  return { deleted };
}

const APP_URL = 'http://127.0.0.1:59999';

async function stubPreview(page: Page, startResult: 'running' | 'failed'): Promise<string[]> {
  const calls: string[] = [];
  let polls = 0;
  let state: Record<string, unknown> = { runId: 'run-new', state: 'stopped' };
  await page.route('**/api/workflow/application-jobs/*/preview', (route) => {
    const method = route.request().method();
    calls.push(method);
    if (method === 'POST') state = { runId: 'run-new', state: 'starting', step: 'install' };
    else if (method === 'DELETE') state = { runId: 'run-new', state: 'stopped' };
    else if (state['state'] === 'starting' && (polls += 1) > 1) {
      state =
        startResult === 'running'
          ? { runId: 'run-new', state: 'running', url: APP_URL }
          : { runId: 'run-new', state: 'failed', error: 'npm install failed: ERESOLVE' };
    }
    return route.fulfill({ json: state });
  });
  await page.route(`${APP_URL}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Library Lending</h1>' }),
  );
  return calls;
}

async function openMockRun(page: Page): Promise<void> {
  await page.goto('/workspace.html');
  await page.getByRole('tab', { name: 'Workflow' }).click();
  await expect(page.getByTestId('restored-run-note')).toBeVisible();
}

test('runs the app, shows progress then the live app, and stops it', async ({ page }) => {
  await stub(page, 1);
  const calls = await stubPreview(page, 'running');
  await openMockRun(page);

  await page.getByTestId('run-app-start').click();
  await expect(page.getByTestId('run-app-progress')).toContainText('Installing packages');
  const frame = page.frameLocator('[data-testid="run-app-frame"]');
  await expect(frame.getByRole('heading', { name: 'Library Lending' })).toBeVisible();
  await expect(page.getByTestId('run-app-open')).toHaveAttribute('href', APP_URL);

  await page.getByTestId('run-app-stop').click();
  await expect(page.getByTestId('run-app-frame')).toHaveCount(0);
  await expect(page.getByTestId('run-app-start')).toHaveText(/Run app/);
  expect(calls).toContain('POST');
  expect(calls).toContain('DELETE');
});

test("shows why the app could not start, and offers to try again", async ({ page }) => {
  await stub(page, 1);
  await stubPreview(page, 'failed');
  await openMockRun(page);

  await page.getByTestId('run-app-start').click();
  await expect(page.getByText('The app could not start')).toBeVisible();
  await expect(page.getByText(/ERESOLVE/)).toBeVisible();
  await expect(page.getByTestId('run-app-start')).toHaveText(/Try again/);
});
