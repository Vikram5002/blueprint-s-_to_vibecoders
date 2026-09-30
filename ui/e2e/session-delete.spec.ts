import { test, expect, type Page } from '@playwright/test';

/**
 * Deleting a project from the sidebar: a trash control on the row, an inline
 * "Delete / Cancel" confirmation so one stray click deletes nothing, and the
 * server's refusal (a job still running) shown on the row. The API is stubbed
 * (page.route), with a session list that really shrinks after a DELETE.
 */

test.use({ viewport: { width: 1280, height: 800 } });

async function stub(page: Page, deleteStatus = 200): Promise<{ deleted: string[] }> {
  let sessions = [
    { id: 's1', title: 'Quiz Website', prompt: 'a quiz', createdAt: '2026-09-29T15:49:00.000Z' },
    { id: 's2', title: 'Cafe Website', prompt: 'cafe', createdAt: '2026-09-29T15:35:00.000Z' },
  ];
  const deleted: string[] = [];
  await page.route('**/api/workflow/sessions', (route) => route.fulfill({ json: { sessions } }));
  await page.route('**/api/workflow/sessions/*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = decodeURIComponent(route.request().url().split('/').pop() ?? '');
    if (deleteStatus !== 200) {
      return route.fulfill({ status: deleteStatus, json: { error: 'this session has a job still running - wait for it to finish, then delete' } });
    }
    deleted.push(id);
    sessions = sessions.filter((session) => session.id !== id);
    return route.fulfill({ json: { deleted: id, runs: 1 } });
  });
  await page.route('**/api/workflow/application-runs/latest', (route) => route.fulfill({ json: { runs: [] } }));
  await page.route('**/api/providers', (route) => route.fulfill({ json: { current: 'gemini', codeProvider: null, localBaseUrl: '', localCodeBaseUrl: '', providers: [] } }));
  return { deleted };
}

function row(page: Page, title: string) {
  return page.getByRole('listitem').filter({ has: page.getByTestId('session-item').filter({ hasText: title }) });
}

test('deletes a project only after the inline confirmation', async ({ page }) => {
  const { deleted } = await stub(page);
  await page.goto('/workspace.html');

  const quiz = row(page, 'Quiz Website');
  await quiz.hover();
  await quiz.getByTestId('delete-session').click();
  await expect(quiz.getByTestId('confirm-delete-session')).toBeVisible();
  expect(deleted).toEqual([]);

  await quiz.getByTestId('confirm-delete-session').click();
  await expect(page.getByTestId('session-item').filter({ hasText: 'Quiz Website' })).toHaveCount(0);
  await expect(page.getByTestId('session-item').filter({ hasText: 'Cafe Website' })).toBeVisible();
  expect(deleted).toEqual(['s1']);
});

test('Cancel and Escape leave the project in place', async ({ page }) => {
  const { deleted } = await stub(page);
  await page.goto('/workspace.html');

  const cafe = row(page, 'Cafe Website');
  await cafe.hover();
  await cafe.getByTestId('delete-session').click();
  await cafe.getByRole('button', { name: 'Cancel' }).click();
  await expect(cafe.getByTestId('confirm-delete-session')).toHaveCount(0);

  await cafe.hover();
  await cafe.getByTestId('delete-session').click();
  await page.keyboard.press('Escape');
  await expect(cafe.getByTestId('confirm-delete-session')).toHaveCount(0);

  expect(deleted).toEqual([]);
  await expect(page.getByTestId('session-item')).toHaveCount(2);
});

test("shows the server's refusal on the row and keeps the project", async ({ page }) => {
  await stub(page, 409);
  await page.goto('/workspace.html');

  const quiz = row(page, 'Quiz Website');
  await quiz.hover();
  await quiz.getByTestId('delete-session').click();
  await quiz.getByTestId('confirm-delete-session').click();

  await expect(quiz.getByRole('alert')).toContainText('job still running');
  await expect(page.getByTestId('session-item').filter({ hasText: 'Quiz Website' })).toBeVisible();
});
