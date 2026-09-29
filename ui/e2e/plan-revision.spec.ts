import { test, expect, type Route } from '@playwright/test';
import { SMALL_PROJECT_SCHEMA } from '../src/workspace/workflow-mocks';

/**
 * Plan revision by prompt (PlanChangeBar): plan, ask for a change, and the
 * plan is replaced in place while the application is still ungenerated.
 * The workflow API is stubbed with page.route - the server side (prompt
 * folding, session replaced in place) is covered by
 * src/server/workflow-api.test.ts.
 */

const ORIGINAL = 'A food delivery site.';
const REVISED = `${ORIGINAL}\n\nChanges to the plan:\n- add a restaurant dashboard`;

test.use({ viewport: { width: 1280, height: 800 } });

test('a change typed under the plan re-plans the same session and leaves Generate to the person', async ({ page }) => {
  const posted: unknown[] = [];
  const jobs = new Map<string, { prompt: string; title: string }>();

  await page.route('**/api/workflow/jobs', async (route: Route) => {
    const body = route.request().postDataJSON() as { prompt?: string; revises?: string; change?: string };
    posted.push(body);
    const id = `job-${posted.length}`;
    jobs.set(id, body.revises === undefined
      ? { prompt: body.prompt ?? '', title: 'Food delivery' }
      : { prompt: REVISED, title: 'Food delivery with restaurant dashboard' });
    await route.fulfill({ status: 202, json: { id, status: 'pending' } });
  });
  await page.route('**/api/workflow/jobs/*', async (route: Route) => {
    const id = route.request().url().split('/').pop() ?? '';
    const job = jobs.get(id);
    await route.fulfill({
      json: {
        id,
        prompt: job?.prompt,
        createdAt: '2026-09-29T00:00:00.000Z',
        status: 'succeeded',
        result: { schema: { ...SMALL_PROJECT_SCHEMA, title: job?.title }, prohibitions: [], permissions: [] },
      },
    });
  });

  await page.goto('/workspace.html');
  await page.getByRole('tab', { name: 'Workflow graph (mock)' }).click();
  await page.getByText('Generate from prompt').click();
  await page.getByPlaceholder('Describe the app you want to build...').fill(ORIGINAL);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();

  await expect(page.getByTestId('plan-change-bar')).toBeVisible();
  await page.getByTestId('plan-change-input').fill('add a restaurant dashboard');
  await page.getByTestId('plan-change-submit').click();

  await expect(page.getByTestId('plan-change-input')).toHaveValue('');
  expect(posted[1]).toEqual({ revises: SMALL_PROJECT_SCHEMA.sessionId, change: 'add a restaurant dashboard' });
  // The full, revised prompt is now in the prompt box, where it can be edited directly.
  await expect(page.getByPlaceholder('Describe the app you want to build...')).toHaveValue(REVISED);
  // Nothing was generated: only the two plan requests were made.
  expect(posted).toHaveLength(2);
});
