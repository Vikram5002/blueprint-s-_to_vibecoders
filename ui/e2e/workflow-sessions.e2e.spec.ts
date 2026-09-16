import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli.js');
const FIXTURE_PATH = resolve(REPO_ROOT, 'src/graph/fixtures/ts-monorepo');

interface RunningCli {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

async function startCli(): Promise<RunningCli> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI_PATH, FIXTURE_PATH, '--no-open'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });

  const baseUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      rejectUrl(new Error(`CLI did not print a server URL within 45s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 45_000);

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
    // Deliberately does not assert the sidebar starts empty: this fixture's
    // own .vibe/blueprint.db is shared with every other live e2e spec that
    // generates against the same FIXTURE_PATH (page-builder.e2e.spec.ts,
    // single-component-build-failure.e2e.spec.ts), so a prior run - in this
    // suite or a previous one - may have already left sessions behind. This
    // test identifies ITS OWN session by the schema's real, model-produced
    // title text instead, which is robust regardless of run order or what
    // else has accumulated there.
    await page.goto(`${cli.baseUrl}/workspace.html`);

    await page.getByRole('tab', { name: 'Workflow graph (mock)' }).click();
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
    await page.getByRole('tab', { name: 'Conversation' }).click();
    const sessionButton = page.getByTestId('session-item').first();
    await expect(sessionButton).toBeVisible();
    const sessionTitle = (await sessionButton.textContent())?.trim();
    expect(sessionTitle).toBeTruthy();

    // Persisted server-side, not just in the page's own JS state.
    await page.reload();
    const reloadedButton = page.getByTestId('session-item').filter({ hasText: sessionTitle ?? '' }).first();
    await expect(reloadedButton).toBeVisible();

    await reloadedButton.click();
    await expect(page.getByRole('tab', { name: 'Workflow graph (mock)' })).toHaveAttribute(
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
