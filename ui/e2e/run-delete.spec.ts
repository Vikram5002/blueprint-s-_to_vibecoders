import { test, expect, type Page } from '@playwright/test';

/**
 * Deleting one run of a project from the Generate Application panel: an
 * inline "Delete / Cancel" confirmation, then the session's next newest run
 * is shown (or an empty panel when none is left), and the server's refusal
 * (a job still running) is shown under the buttons. The API is stubbed
 * (page.route), with a run list that really shrinks after a DELETE.
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

async function openMockRun(page: Page): Promise<void> {
  await page.goto('/workspace.html');
  await page.getByRole('tab', { name: 'Workflow' }).click();
  await expect(page.getByTestId('restored-run-note')).toBeVisible();
}

test('deletes the shown run only after confirming, then shows the next newest run', async ({
  page,
}) => {
  const { deleted } = await stub(page, 2);
  await openMockRun(page);
  const before = await page.getByTestId('restored-run-note').innerText();

  await page.getByTestId('delete-run').click();
  await expect(page.getByTestId('confirm-delete-run')).toBeVisible();
  expect(deleted).toEqual([]);

  await page.getByTestId('confirm-delete-run').click();
  await expect(page.getByTestId('confirm-delete-run')).toHaveCount(0);
  expect(deleted).toEqual(['run-new']);
  // The note names the run's date, so a different note is the older run.
  await expect(page.getByTestId('restored-run-note')).not.toHaveText(before);
  await expect(page.getByTestId('delete-run')).toBeVisible();
});

test('deleting the only run leaves an empty panel', async ({ page }) => {
  const { deleted } = await stub(page, 1);
  await openMockRun(page);

  await page.getByTestId('delete-run').click();
  await page.getByTestId('confirm-delete-run').click();

  await expect(page.getByRole('button', { name: 'Generate Application' })).toBeVisible();
  await expect(page.getByTestId('restored-run-note')).toHaveCount(0);
  await expect(page.getByTestId('delete-run')).toHaveCount(0);
  expect(deleted).toEqual(['run-new']);
});

test('Cancel and Escape keep the run', async ({ page }) => {
  const { deleted } = await stub(page, 1);
  await openMockRun(page);

  await page.getByTestId('delete-run').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('confirm-delete-run')).toHaveCount(0);

  await page.getByTestId('delete-run').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-delete-run')).toHaveCount(0);

  expect(deleted).toEqual([]);
  await expect(page.getByTestId('restored-run-note')).toBeVisible();
});

test("shows the server's refusal and keeps the run", async ({ page }) => {
  await stub(page, 1, 409);
  await openMockRun(page);

  await page.getByTestId('delete-run').click();
  await page.getByTestId('confirm-delete-run').click();

  await expect(page.getByTestId('delete-run-error')).toContainText('still running');
  await expect(page.getByTestId('restored-run-note')).toBeVisible();
});
