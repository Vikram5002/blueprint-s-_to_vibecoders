import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * The final milestone's live verification (Task 3): drives the REAL
 * built UI in a real browser - clicks, not curl, not a script calling the
 * API directly - through the whole "prompt to verified, downloadable
 * application" loop this phase exists to deliver.
 *
 * Same spawn-the-real-CLI pattern workflow-api.e2e.spec.ts already
 * established, for the same reason: this must not import anything from
 * src/server/ into ui/e2e/ (rule 4 applies to test code too), so the real
 * dist/cli.js is spawned as a subprocess and the browser talks to it over
 * real HTTP, exactly as a real user's browser would.
 *
 * Uses the "Known-tension fixture (Milestone 1)" mock scenario
 * (KNOWN_TENSION_SCHEMA in workflow-mocks.ts) rather than a live Layer-2
 * prompt: that fixture is the exact schema a live Milestone 1 run already
 * proved produces a real, unforced Blueprint violation on first generation
 * attempt, which is what Task 3.4 asks this test to demonstrate
 * deterministically rather than hoping a raw prompt happens to reproduce
 * it. Application generation itself still calls the real configured LLM
 * provider for real component code - nothing about the generation,
 * install, build, or Blueprint verification is mocked.
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
      rejectUrl(new Error(`CLI did not print a server URL within 30s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 30_000);

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

test.describe('real "Generate Application" flow, driven from the actual browser UI', () => {
  test.setTimeout(180_000);

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  });

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('known-tension fixture: generates real code, installs, builds, and honestly reports the real Blueprint outcome (fixed or hard-failed)', async ({
    page,
  }) => {
    await page.goto(`${cli.baseUrl}/workspace.html`);

    await page.getByRole('tab', { name: 'Workflow graph (mock)' }).click();
    await page.getByRole('button', { name: 'Known-tension fixture (Milestone 1)' }).click();

    const generateButton = page.getByRole('button', { name: 'Generate Application' });
    await expect(generateButton).toBeVisible();

    // Same 503-means-no-provider-configured skip precedent
    // workflow-api.e2e.spec.ts already uses - this test needs a real key to
    // exercise real generation and cannot fabricate one.
    const probe = await page.request.post(`${cli.baseUrl}/api/workflow/application-jobs`, {
      data: { schema: { provenance: 'STATED' } }, // deliberately invalid - only checking for 503-before-400
    });
    if (probe.status() === 503) {
      test.skip(true, 'No live provider available in this environment (application-jobs responded 503).');
      return;
    }

    await generateButton.click();

    // Real phases as they actually happen - generating, verifying, and
    // possibly regenerating/reverifying, then installing/building
    // server-side. Not asserting on any one phase text (real timing means
    // some may flash by too fast to catch), just that the button becomes
    // unavailable while a job is in flight and real, terminal report
    // content eventually appears.
    await expect(generateButton).toBeHidden();

    const buildBadge = page.getByText(/npm run build: (passed|failed)/);
    await expect(buildBadge).toBeVisible({ timeout: 170_000 });

    const installBadge = page.getByText(/npm install: (passed|failed)/);
    await expect(installBadge).toBeVisible();
    await expect(installBadge).toHaveText('npm install: passed');
    await expect(buildBadge).toHaveText('npm run build: passed');

    // The real, load-bearing assertion for Task 3.4: a genuine retry
    // happened, with real evidence shown - not asserting which of the two
    // real outcomes (fixed vs. still-violating) occurred, since that
    // depends on what the live model actually did on its second attempt,
    // and asserting a specific one would mean either hard-coding a fake
    // expectation or laundering non-determinism into a false failure.
    const auditLogHeading = page.getByText(/Auto-regeneration audit log/);
    await expect(auditLogHeading).toBeVisible();
    await expect(page.getByText('Rule violated: backend/src/middleware must not import backend/src/routes')).toBeVisible();
    await expect(page.getByText(/backend\/src\/middleware\/auth-middleware\.ts:\d+:/)).toBeVisible();

    const fixedBadge = page.getByText('FIXED on retry');
    const stillViolatingBadge = page.getByText('STILL VIOLATING — review item');
    const outcome = (await fixedBadge.isVisible()) ? 'fixed' : (await stillViolatingBadge.isVisible()) ? 'still-violating' : 'unknown';
    console.log(`[generate-application e2e] real retry outcome observed in the browser: ${outcome}`);
    expect(outcome).not.toBe('unknown');

    if (outcome === 'still-violating') {
      // The hard-fail path Task 3.4 specifically asks to confirm: shown
      // honestly, with the review-item styling and real evidence, not
      // folded into a generic success state.
      await expect(page.getByText(/Blueprint: \d+ unresolved violation/)).toBeVisible();
      await expect(page.getByText(/Unresolved violations — \d+ review item/)).toBeVisible();
    } else {
      await expect(page.getByText('Blueprint: all constraints satisfied')).toBeVisible();
    }

    // A real download link for the real generated project is offered
    // regardless of outcome - a hard-failed component is still a real,
    // reviewable project on disk.
    const downloadLink = page.getByRole('link', { name: 'Download generated project (.zip)' });
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute('href');
    expect(href).toMatch(/^\/api\/workflow\/application-jobs\/.+\/download$/);

    // Independent check, same discipline every prior milestone's "final
    // independent verification" step used: fetch the zip directly (not
    // through the UI) and confirm it is a real, non-trivial archive - not
    // trusting the UI's own claim that a download exists without checking.
    const zipResponse = await page.request.get(`${cli.baseUrl}${href}`);
    expect(zipResponse.status()).toBe(200);
    expect(zipResponse.headers()['content-type']).toBe('application/zip');
    const zipBody = await zipResponse.body();
    expect(zipBody.length).toBeGreaterThan(500);
    expect(zipBody.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});
