import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { startCli, type RunningCli } from './cli-server';
import { expectLiveResult, LIVE_TEST_TIMEOUT_MS } from './live-timeouts';

/**
 * Hosted mode end to end, against the real built server and a real model:
 *
 * - the server has NO model key of its own (started outside the repository,
 *   key variables removed) and a daily limit of 0 on its own models, so the
 *   only way a plan can be made is with the visitor's own key;
 * - the visitor types the access code, pastes a Groq key in the model menu,
 *   and generates a plan;
 * - a second browser (another visitor) sees none of the first one's projects.
 *
 * The Groq key is read from the repository's .env and never printed; without
 * one the spec is skipped.
 */

const ACCESS_CODE = 'e2e-access-code-123';

function groqKey(): string | null {
  try {
    const env = readFileSync(
      resolve(fileURLToPath(new URL('.', import.meta.url)), '../../.env'),
      'utf8',
    );
    const line = env.split(/\r?\n/).find((l) => l.startsWith('GROQ_API_KEY='));
    const value = line?.slice('GROQ_API_KEY='.length).trim().replace(/^"|"$/g, '') ?? '';
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

let cli: RunningCli;

test.beforeAll(async () => {
  cli = await startCli({
    args: ['--hosted'],
    env: { VIBE_ACCESS_CODE: ACCESS_CODE, VIBE_DAILY_RUNS: '0', VIBE_LLM_PROVIDER: 'groq' },
    withoutOwnKeys: true,
  });
});

test.afterAll(async () => {
  await cli?.stop();
});

async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('access-code').fill(code);
  await page.getByRole('button', { name: 'Enter' }).click();
}

test('asks for the access code, refuses a wrong one, and blocks server-side routes', async ({
  page,
  request,
}) => {
  await page.goto(`${cli.baseUrl}/workspace.html`);
  await expect(page.getByRole('heading', { name: 'This VibeCoder is invite-only' })).toBeVisible();
  await enterCode(page, 'wrong-code-000');
  await expect(page.getByRole('alert')).toContainText('not right');
  await enterCode(page, ACCESS_CODE);
  await expect(page.getByTestId('model-menu')).toBeVisible();

  const headers = { 'x-vibe-access': ACCESS_CODE, 'x-vibe-owner': 'e2e-owner-0123456789ab' };
  expect((await request.get(`${cli.baseUrl}/api/projects`, { headers })).status()).toBe(403);
  expect((await request.get(`${cli.baseUrl}/api/summary`)).status()).toBe(401);
  // The server's own model is off (limit 0): a run without a key is refused with a pointer to "your own key".
  const shared = await request.post(`${cli.baseUrl}/api/workflow/jobs`, {
    headers,
    data: { prompt: 'a todo app' },
  });
  expect(shared.status()).toBe(429);
  expect(((await shared.json()) as { error: string }).error).toContain('own API key');
});

test("a visitor's own key makes a real plan, and another visitor cannot see it", async ({
  page,
  browser,
}) => {
  const key = groqKey();
  test.skip(key === null, 'no GROQ_API_KEY in .env');
  test.setTimeout(LIVE_TEST_TIMEOUT_MS);

  await page.goto(`${cli.baseUrl}/workspace.html`);
  await enterCode(page, ACCESS_CODE);

  await page.getByTestId('model-menu').click();
  await expect(page.getByTestId('provider-select')).toBeDisabled();
  await page.getByTestId('own-key-provider').selectOption('groq');
  await page.getByTestId('own-key-value').fill(key ?? '');
  await page.getByTestId('own-key-save').click();
  await expect(page.getByTestId('own-key-active')).toContainText('Groq');
  await expect(page.getByTestId('model-menu')).toContainText('Your key: Groq');
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Workflow' }).click();
  await page.getByRole('button', { name: 'Generate from prompt' }).click();
  await page
    .getByPlaceholder('Describe the app you want to build...')
    .fill('a small library app to lend and return books');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expectLiveResult(page, page.getByRole('button', { name: 'Generate Application' }));

  // The plan was saved as this browser's project.
  await expect(page.getByTestId('session-item').first()).toBeVisible();
  const mine = await page.getByTestId('session-item').count();
  expect(mine).toBeGreaterThan(0);

  // Another visitor: own browser profile, so a different browser id.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(`${cli.baseUrl}/workspace.html`);
  await enterCode(otherPage, ACCESS_CODE);
  await expect(otherPage.getByTestId('model-menu')).toBeVisible();
  await expect(otherPage.getByTestId('session-item')).toHaveCount(0);
  await other.close();
});
