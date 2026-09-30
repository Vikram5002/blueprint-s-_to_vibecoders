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
