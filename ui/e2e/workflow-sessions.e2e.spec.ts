import { test, expect } from '@playwright/test';
import { startCli, type RunningCli } from './cli-server';

/**
 * Live coverage for the Sessions sidebar's real persistence path
 * (src/store/workflow-sessions-store.ts, `/api/workflow/sessions`), the fix
 * for the "sessions never survive a tab switch or reload" gap: every
 * schema-generation job that reaches 'succeeded' is now saved server-side,
 * and the Sidebar lists and can reopen it.
 *
 * Same `startCli` pattern as page-builder.e2e.spec.ts and
 * single-component-build-failure.e2e.spec.ts (duplicated rather than shared
 * — see those files) — a real CLI process, a real HTTP server, a real
 * browser. The one live model call this test makes is intentionally the
 * cheapest prompt in this suite (a local dice roller): the point here is
 * exercising the persistence plumbing around generation, not generation
 * quality itself.
 */

test.describe('Sessions sidebar: real, server-persisted generation runs', () => {
  test.setTimeout(180_000);

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  }, 60_000);

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('a live generation is saved as a session, survives a reload, and reopens into the same graph', async ({
    page,
  }) => {
    // Each spec now serves its own fresh copy of the fixture (cli-server.ts),
    // so the sidebar starts empty here; the test still identifies ITS OWN
    // session by the schema's real, model-produced title text rather than by
    // position, which stays correct however many sessions the run creates.
    await page.goto(`${cli.baseUrl}/workspace.html`);

    await page.getByRole('tab', { name: 'Workflow' }).click();
    await page.getByRole('button', { name: 'Generate from prompt' }).click();
    await page
      .getByPlaceholder('Describe the app you want to build...')
      .fill('A dice roller for tabletop games, no accounts, purely local.');
    await page.getByRole('button', { name: 'Generate', exact: true }).click();

    // Real generation, not a stub - the terminal state is whatever a real
    // model actually returns for this prompt (`.react-flow__node` on
    // success). If provider credentials are missing in this environment the
    // job fails fast with a clear error rather than hanging, so this would
    // time out loudly rather than silently pass either way.
    await page.waitForSelector('.react-flow__node', { timeout: 90_000 });

    // The sidebar has no dependency on which tab is active - switching away
    // and back is what a real user does, and is exactly what exposed the
    // original "session opens into an empty idle view" bug live. The newest
    // session is always first (ORDER BY created_at DESC, workflow-sessions-store.ts).
    await page.getByRole('tab', { name: 'Agent' }).click();
    const sessionButton = page.getByTestId('session-item').first();
    await expect(sessionButton).toBeVisible();
    const sessionTitle = (await sessionButton.textContent())?.trim();
    expect(sessionTitle).toBeTruthy();

    // Persisted server-side, not just in the page's own JS state.
    await page.reload();
    const reloadedButton = page.getByTestId('session-item').filter({ hasText: sessionTitle ?? '' }).first();
    await expect(reloadedButton).toBeVisible();

    await reloadedButton.click();
    await expect(page.getByRole('tab', { name: 'Workflow' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    // Reopened from the server, not a stale in-memory idle view — the
    // "Enter a prompt above..." placeholder is exactly what a broken reopen
    // regressed to, live, before the WorkflowDemo key/consume fix.
    await expect(page.getByText('Enter a prompt above to generate a real ProjectSchema.')).not.toBeVisible();
  });
});

/**
 * The model picker: switching which provider answers generation requests,
 * without editing an env var and restarting. Runs against the real CLI
 * server (so `/api/providers` is really mounted and really probes for a
 * local inference server), in the same spec file as the sessions test
 * because both need exactly this `startCli` harness.
 */
test.describe('Model picker: choosing between a cloud API and the local model', () => {
  test.setTimeout(120_000);

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  }, 60_000);

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('lists every provider with real availability, and a switch reaches the server and survives a reload', async ({
    page,
  }) => {
    await page.goto(`${cli.baseUrl}/workspace.html`);

    // The pickers live in the header's model menu.
    await page.getByTestId('model-menu').click();
    const picker = page.getByTestId('provider-select');
    await expect(picker).toBeVisible();

    // Every selectable provider is offered, and the ones that cannot serve a
    // request right now say so rather than silently failing later.
    const options = await picker.locator('option').allTextContents();
    // Gemini, the five free OpenAI-compatible services, local, local-code, Anthropic, Bluesminds.
    expect(options).toHaveLength(10);
    expect(options.some((text) => text.startsWith('Gemini'))).toBe(true);
    expect(options.some((text) => text.startsWith('Local model'))).toBe(true);

    // The local inference server is not running in CI or on a dev box by
    // default, so it must be offered but marked unavailable - selectable
    // anyway, because you may be about to start it.
    const localOption = options.find((text) => text.startsWith('Local model'));
    expect(localOption).toContain('not set up');

    await picker.selectOption('local');
    await expect(picker).toHaveValue('local');
    // The warning names the actual thing to run, not a generic error.
    await expect(page.getByTestId('provider-detail')).toContainText('local_inference_server.py');

    // The server agrees - this is not just client-side state.
    const serverCurrent = await page.evaluate(async () => {
      const response = await fetch('/api/providers');
      return ((await response.json()) as { current: string }).current;
    });
    expect(serverCurrent).toBe('local');

    // And it is persisted, not per-tab.
    await page.reload();
    await page.getByTestId('model-menu').click();
    await expect(page.getByTestId('provider-select')).toHaveValue('local');

    // Put it back so this test leaves the shared fixture's .vibe database as
    // it found it - the setting outlives the process, so not restoring it
    // would silently change what every later run of any other spec uses.
    await page.getByTestId('provider-select').selectOption('gemini');
    await expect(page.getByTestId('provider-select')).toHaveValue('gemini');
  });
});
