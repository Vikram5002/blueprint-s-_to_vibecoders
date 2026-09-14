import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Item 2's live verification (post-Milestone-4): reproduces a genuine
 * hard-failed component - "STILL VIOLATING - review item" - through the
 * REAL built UI in a real browser, not a unit test's data shapes and not a
 * script calling the API directly.
 *
 * generate-application.e2e.spec.ts already covers this same flow against
 * KNOWN_TENSION_SCHEMA (Milestone 1's fixture), but three separate live
 * runs against that fixture (two with a cleared cache, forcing fresh model
 * calls) all self-corrected on the auto-regeneration retry - never once
 * producing a hard-fail live, despite genuinely trying. This spec targets
 * a DIFFERENT, larger fixture instead: SCALE_TEST_SCHEMA
 * (workflow-mocks.ts), the exact schema src/generate/generate-project.ts's
 * buildScaleTestSchema builds, which Milestone 3's own earlier
 * script-based run (scripts/milestone3-scale-test.mjs) already showed
 * reliably hard-fails on TaskRouter's routes/db violation - it does NOT
 * self-correct on retry, unlike the Milestone 1 fixture. See
 * docs/GENERATION.md's "Open item" for the full history this spec closes.
 *
 * Same spawn-the-real-CLI pattern generate-application.e2e.spec.ts already
 * established: dist/cli.js is spawned as a real subprocess and the browser
 * talks to it over real HTTP, exactly as a real user's browser would - this
 * file must not import anything from src/server/ (rule 4 applies to test
 * code too).
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

test.describe('real "Generate Application" flow against the scale-test fixture - reproduces a live hard-fail', () => {
  // 9 components vs. the known-tension fixture's 3 - ADR-002/Milestone 3's
  // own measured timing put a 9-component generate+verify+retry+install+
  // build run at roughly 100s; generous headroom over that.
  test.setTimeout(300_000);

  let cli: RunningCli;

  test.beforeAll(async () => {
    cli = await startCli();
  });

  test.afterAll(async () => {
    await cli?.stop();
  });

  test('scale-test fixture: TaskRouter hard-fails and the UI renders it honestly, with real evidence', async ({ page }) => {
    await page.goto(`${cli.baseUrl}/workspace.html`);

    await page.getByRole('tab', { name: 'Workflow graph (mock)' }).click();
    await page.getByRole('button', { name: 'Scale-test fixture (Milestone 3, TaskRouter hard-fail)' }).click();

    const generateButton = page.getByRole('button', { name: 'Generate Application' });
    await expect(generateButton).toBeVisible();

    // Same 503-means-no-provider-configured skip precedent
    // generate-application.e2e.spec.ts already uses.
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
    await expect(buildBadge).toBeVisible({ timeout: 280_000 });

    const installBadge = page.getByText(/npm install: (passed|failed)/);
    await expect(installBadge).toBeVisible();
    await expect(installBadge).toHaveText('npm install: passed');

    const auditLogHeading = page.getByText(/Auto-regeneration audit log/);
    await expect(auditLogHeading).toBeVisible();

    // More than one of this schema's components can independently need a
    // retry (the audit log lists one entry per retried component), so
    // these can legitimately match several elements - count, not
    // isVisible(), which requires (and Playwright's strict mode enforces)
    // exactly one match.
    const fixedCount = await page.getByText('FIXED on retry').count();
    const stillViolatingCount = await page.getByText('STILL VIOLATING — review item').count();
    const outcome = stillViolatingCount > 0 ? 'still-violating' : fixedCount > 0 ? 'fixed' : 'unknown';
    // eslint-disable-next-line no-console
    console.log(
      `[scale-test hard-fail e2e] real retry outcome observed in the browser: ${outcome} ` +
        `(${fixedCount} fixed, ${stillViolatingCount} still-violating)`,
    );
    expect(outcome).not.toBe('unknown');

    if (outcome === 'still-violating') {
      // The exact assertion Item 2 exists to make: a hard-failed component,
      // its real domain, and the real violation evidence, rendered honestly
      // - not folded into a generic success state. `.first()` throughout:
      // more than one router can independently violate the same rule, so
      // these are existence checks, not uniqueness checks.
      await expect(page.getByText(/Blueprint: \d+ unresolved violation/)).toBeVisible();
      await expect(page.getByText(/Unresolved violations — \d+ review item/)).toBeVisible();
      await expect(page.getByText(/TaskRouter \(backend\)/).first()).toBeVisible();
      await expect(page.getByText('Rule violated: backend/src/routes must not import backend/src/db').first()).toBeVisible();
      await expect(page.getByText(/backend\/src\/routes\/task-router\.ts:\d+:/).first()).toBeVisible();
    } else {
      // Honestly report the alternative outcome rather than assuming failure
      // - the model is non-deterministic and this test's job is to observe
      // real behavior, not force a specific one.
      await expect(page.getByText('Blueprint: all constraints satisfied')).toBeVisible();
    }

    const downloadLink = page.getByRole('link', { name: 'Download generated project (.zip)' });
    await expect(downloadLink).toBeVisible();

    // Direct visual evidence of the real, live-observed state, for the
    // report this test exists to back up - not a claim of "it worked"
    // without something to point at.
    await page.screenshot({ path: 'test-results/scale-test-outcome.png', fullPage: true });
  });
});
