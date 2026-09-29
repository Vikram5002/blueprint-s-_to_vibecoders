import { test, expect, type Page, type Route } from '@playwright/test';
import { SMALL_PROJECT_SCHEMA } from '../src/workspace/workflow-mocks';

/**
 * Agent mode's plan review, with the workflow API stubbed (page.route): the
 * agent plans, stops, takes a change, and builds only on "Build this plan".
 * The agent's decisions themselves are unit-tested in agent-runner.test.ts.
 */

test.use({ viewport: { width: 1280, height: 800 } });

interface Calls {
  readonly plans: unknown[];
  readonly generations: unknown[];
}

async function stubApi(page: Page): Promise<Calls> {
  const calls: Calls = { plans: [], generations: [] };
  const titles = new Map<string, string>();
  await page.route('**/api/workflow/jobs', async (route: Route) => {
    const body = route.request().postDataJSON() as { revises?: string };
    calls.plans.push(body);
    const id = `plan-${calls.plans.length}`;
    titles.set(id, body.revises === undefined ? 'Campus Fest' : 'Campus Fest with sponsors');
    await route.fulfill({ status: 202, json: { id, status: 'pending' } });
  });
  await page.route('**/api/workflow/jobs/*', async (route: Route) => {
    const id = route.request().url().split('/').pop() ?? '';
    await route.fulfill({
      json: {
        id,
        prompt: 'p',
        createdAt: '2026-09-30T00:00:00.000Z',
        status: 'succeeded',
        result: { schema: { ...SMALL_PROJECT_SCHEMA, title: titles.get(id) }, prohibitions: [], permissions: [] },
      },
    });
  });
  await page.route('**/api/workflow/application-jobs', async (route: Route) => {
    calls.generations.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: 'app-1', status: 'pending' } });
  });
  await page.route('**/api/workflow/application-jobs/app-1', (route: Route) =>
    route.fulfill({ json: { id: 'app-1', createdAt: 't', sessionId: 's', kind: 'generate', status: 'failed', error: { phase: 'unexpected', message: 'stubbed' } } }),
  );
  return calls;
}

test('a starter idea fills the request; the plan waits for review, takes a change, and is built only when approved', async ({ page }) => {
  const calls = await stubApi(page);
  await page.goto('/workspace.html');

  await page.getByTestId('starter-idea').filter({ hasText: 'College fest website' }).click();
  await expect(page.getByTestId('agent-prompt')).toHaveValue(/college fest website/i);
  await expect(page.getByTestId('agent-review-first')).toBeChecked();
  await page.getByTestId('agent-start').click();

  const review = page.getByTestId('agent-review');
  await expect(review).toContainText('Campus Fest');
  await expect(page.getByTestId('agent-step-review')).toHaveAttribute('data-status', 'running');
  expect(calls.generations).toHaveLength(0);

  await page.getByTestId('plan-change-input').fill('add a sponsors page');
  await page.getByTestId('plan-change-submit').click();
  await expect(review).toContainText('Campus Fest with sponsors');
  expect(calls.plans[1]).toEqual({ revises: SMALL_PROJECT_SCHEMA.sessionId, change: 'add a sponsors page' });

  await page.getByTestId('agent-approve').click();
  await expect(page.getByTestId('agent-step-review')).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('agent-step-generate')).toHaveAttribute('data-status', 'failed');
  expect(calls.generations).toHaveLength(1);
  expect((calls.generations[0] as { schema: { title: string } }).schema.title).toBe('Campus Fest with sponsors');
});

test('cancelling at the review generates nothing', async ({ page }) => {
  const calls = await stubApi(page);
  await page.goto('/workspace.html');

  await page.getByTestId('agent-prompt').fill('A library system');
  await page.getByTestId('agent-start').click();
  await expect(page.getByTestId('agent-review')).toBeVisible();
  await page.getByTestId('agent-cancel').click();

  await expect(page.getByTestId('agent-step-review')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('agent-step-generate')).toHaveAttribute('data-status', 'skipped');
  expect(calls.generations).toHaveLength(0);
});
