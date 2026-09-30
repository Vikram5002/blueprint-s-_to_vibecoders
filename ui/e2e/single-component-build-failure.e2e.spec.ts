import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LIVE_RESULT_TIMEOUT_MS, LIVE_TEST_TIMEOUT_MS } from './live-timeouts';

/**
 * The one remaining precisely-scoped gap (see docs/GENERATION.md): the
 * build-failure retry's `attributeBuildFailure` returning `{ kind:
 * 'attributed' }` -> `regenerateForBuildFailure` -> a real, passing rebuild,
 * observed live through the actual browser. Never reached via the
 * recipe-box prompt (three separate live attempts across sessions all
 * produced a co-occurring, unrelated frontend/main.tsx prop-mismatch
 * alongside whatever backend bug appeared, making every real failure
 * multi-file and therefore correctly ambiguous - not the branch this test
 * exists to exercise).
 *
 * SINGLE_COMPONENT_SCHEMA (workflow-mocks.ts) is constructed specifically to
 * make a single-file failure structurally reachable: only the backend
 * domain is populated, so the only LLM-generated file in the whole project
 * is InventoryService's own file - there is no second domain for an
 * independent bug to occur in. Whether a real bug occurs at all is still up
 * to the model; this fixture only guarantees that IF one occurs, it can
 * only ever be attributed to the one file.
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

test.describe('Single-component fixture: live verification of the build-failure retry\'s attributed branch', () => {
  test.setTimeout(LIVE_TEST_TIMEOUT_MS);

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  }, 60_000);

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('a real single-file tsc failure, if it occurs, attributes cleanly and the retry produces a real passing rebuild', async ({ page }) => {
    await page.goto(`${cli.baseUrl}/workspace.html`);
    await page.getByRole('tab', { name: 'Workflow' }).click();
    await page.getByRole('button', { name: 'Single-component fixture (build-failure retry)' }).click();

    const generateButton = page.getByRole('button', { name: 'Generate Application' });
    await expect(generateButton).toBeVisible();

    const probe = await page.request.post(`${cli.baseUrl}/api/workflow/application-jobs`, {
      data: { schema: { provenance: 'STATED' } },
    });
    if (probe.status() === 503) {
      test.skip(true, 'No live provider available in this environment (application-jobs responded 503).');
      return;
    }

    await generateButton.click();
    await expect(generateButton).toBeHidden();

    const buildBadge = page.getByText(/npm run build: (passed|failed)/);
    await expect(buildBadge).toBeVisible({ timeout: LIVE_RESULT_TIMEOUT_MS });

    const installBadge = page.getByText(/npm install: (passed|failed)/);
    await expect(installBadge).toHaveText('npm install: passed');

    const buildBadgeText = (await buildBadge.textContent()) ?? '';
    console.log(`[single-component e2e] real npm run build outcome: ${buildBadgeText}`);

    const buildFailureBadges = page.getByText('npm run build failure');
    const buildFailureCount = await buildFailureBadges.count();
    console.log(`[single-component e2e] real build-failure retry entries observed: ${buildFailureCount}`);

    if (buildFailureCount === 0) {
      // The model did not happen to write a compile error this run - a real,
      // honest possibility. No forced positive result; log and pass.
      console.log('[single-component e2e] no build failure occurred this run - nothing to attribute.');
    } else {
      // The exact live observation this test exists to make: a real
      // build-failure-triggered retry, attributed to InventoryService
      // specifically (the only component this schema could ever attribute
      // to), and the FINAL build outcome genuinely passing.
      await expect(buildFailureBadges.first()).toBeVisible();
      await expect(page.getByText(/InventoryService \(backend\)/).first()).toBeVisible();
      await expect(buildBadge).toHaveText('npm run build: passed');
    }

    await expect(page.getByRole('link', { name: 'Download generated project (.zip)' })).toBeVisible();

    await page.screenshot({ path: 'test-results/single-component-outcome.png', fullPage: true });
  });
});
