import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Time limits for the specs that drive a real, live model.
 *
 * On a free tier a single call can wait out several rate-limit backoffs:
 * one Gemini call measured 189 s on 2026-09-30, and a small project makes a
 * handful of calls before its npm install and build. Limits of three to five
 * minutes turned throttling into test failures, so these allow fifteen.
 * Mocked specs keep Playwright's defaults.
 */
export const LIVE_TEST_TIMEOUT_MS = 15 * 60_000;

/** How long to wait for the terminal report (install/build badges) inside that budget. */
export const LIVE_RESULT_TIMEOUT_MS = 14 * 60_000;

/**
 * Waits for `result` - a plan on screen, a build badge - but stops the moment
 * the page reports that the live job failed, failing with the page's own
 * error text. Waiting out the whole budget for a result that can no longer
 * arrive (a quota ran out, a provider refused) cost fourteen minutes per
 * spec and hid the actual reason behind "element not found".
 */
export async function expectLiveResult(page: Page, result: Locator): Promise<void> {
  const failure = page.getByText(/^(Application generation failed|Generation failed)$/);
  await expect(result.or(failure).first()).toBeVisible({ timeout: LIVE_RESULT_TIMEOUT_MS });
  if (await failure.first().isVisible()) {
    const detail = await failure.first().locator('xpath=..').innerText();
    throw new Error(`the live job failed instead of finishing:\n${detail}`);
  }
}
