import { test, expect, type Page } from '@playwright/test';

/**
 * The workspace's navigation surfaces: the Ctrl/Cmd+K command palette, the
 * header's model menu, sidebar search and "New project". The API is stubbed
 * (page.route) so these run without a backend.
 */

test.use({ viewport: { width: 1280, height: 800 } });

const SESSIONS = [
  { id: 's1', title: 'Quiz Website', prompt: 'a quiz', createdAt: '2026-09-29T15:49:00.000Z' },
  { id: 's2', title: 'Food Delivery Marketplace', prompt: 'food', createdAt: '2026-09-29T15:35:00.000Z' },
  { id: 's3', title: 'Cafe Website', prompt: 'cafe', createdAt: '2026-09-16T14:30:00.000Z' },
];

const PROVIDERS = {
  current: 'groq',
  codeProvider: null,
  localBaseUrl: 'http://127.0.0.1:8712',
  localCodeBaseUrl: 'http://127.0.0.1:8712',
  providers: [
    { id: 'gemini', label: 'Gemini (free tier, cloud)', model: 'gemini-3.5-flash', available: false, detail: 'GEMINI_API_KEY is not set' },
    { id: 'groq', label: 'Groq (free tier, cloud)', model: 'openai/gpt-oss-120b', available: true, detail: 'GROQ_API_KEY is set' },
  ],
};

async function stub(page: Page): Promise<void> {
  await page.route('**/api/workflow/sessions', (route) => route.fulfill({ json: { sessions: SESSIONS } }));
  await page.route('**/api/workflow/application-runs/latest', (route) => route.fulfill({ json: { runs: [] } }));
  await page.route('**/api/providers', (route) => route.fulfill({ json: PROVIDERS }));
}

test('Ctrl+K opens the command palette; typing filters and Enter goes there', async ({ page }) => {
  await stub(page);
  await page.goto('/workspace.html');

  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await expect(page.getByTestId('command-input')).toBeFocused();

  await page.getByTestId('command-input').fill('workflow');
  await expect(page.getByTestId('command-item')).toHaveCount(1);
  await page.keyboard.press('Enter');

  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Workflow' })).toHaveAttribute('aria-selected', 'true');
});

test('the palette lists saved projects and closes on Escape or a click outside', async ({ page }) => {
  await stub(page);
  await page.goto('/workspace.html');

  await page.getByTestId('open-command').click();
  await page.getByTestId('command-input').fill('quiz');
  await expect(page.getByTestId('command-item').filter({ hasText: 'Open Quiz Website' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  await page.keyboard.press('Control+k');
  await page.mouse.click(20, 780);
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

test('the model chip opens a menu with both pickers, and Escape closes it', async ({ page }) => {
  await stub(page);
  await page.goto('/workspace.html');

  const chip = page.getByTestId('model-menu');
  await expect(chip).toContainText('Groq');
  await chip.click();
  await expect(page.getByRole('dialog', { name: 'AI models' })).toBeVisible();
  await expect(page.getByTestId('provider-select')).toHaveValue('groq');
  await expect(page.getByTestId('code-provider-select')).toHaveValue('same');
  await expect(page.getByTestId('provider-detail')).toContainText('GROQ_API_KEY is set');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'AI models' })).toHaveCount(0);
});

test('sidebar search narrows the projects list', async ({ page }) => {
  await stub(page);
  await page.goto('/workspace.html');

  await expect(page.getByTestId('session-item')).toHaveCount(3);
  await page.getByRole('searchbox', { name: 'Search projects' }).fill('website');
  await expect(page.getByTestId('session-item')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search projects' }).fill('nothing like this');
  await expect(page.getByTestId('session-item')).toHaveCount(0);
  await expect(page.getByText('Nothing matches')).toBeVisible();
});

test('New project returns to an empty Agent page from anywhere', async ({ page }) => {
  await stub(page);
  await page.goto('/workspace.html');

  await page.getByTestId('agent-prompt').fill('half-written idea');
  await page.getByRole('tab', { name: 'Workflow' }).click();
  await page.getByTestId('new-project').click();

  await expect(page.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('agent-prompt')).toBeFocused();
  await expect(page.getByText('What will you build today?')).toBeVisible();
});
