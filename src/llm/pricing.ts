/**
 * Token pricing, for cost estimation.
 *
 * Estimates, not invoices. Rates are per million tokens and are baked in
 * deliberately: the tool is local-first and must not phone a pricing endpoint
 * to tell a user what a run cost. They will drift — the table records when it
 * was written so a stale number is visible rather than silently trusted.
 *
 * Cached reads are ~0.1x input and cache writes ~1.25x, which matters here: a
 * second run on an unchanged repository should cost nothing at all, because the
 * response cache means no request is made.
 */

export interface ModelPricing {
  /** USD per million input tokens. */
  readonly inputPerMillion: number;
  /** USD per million output tokens. */
  readonly outputPerMillion: number;
}

/** Rates as published on 2026-08-09. */
export const PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },

  /**
   * Gemini on the free tier: no money changes hands, so the rate is genuinely
   * zero rather than unknown.
   *
   * Listed explicitly instead of relying on the unknown-model fallback, which
   * also returns 0. The two zeroes mean different things — "this costs
   * nothing" against "no idea what this costs" — and `isPricedModel` is what
   * separates them, so a report can say "free" where it means free and
   * "unknown model" where it means that.
   *
   * A paid tier exists and is not free. If this project ever bills for Gemini,
   * these numbers must change, and the entry being here is what makes that a
   * visible edit rather than a silent one.
   */
  'gemini-3.5-flash': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemini-3.5-flash-lite': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemini-3.6-flash': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemini-2.0-flash': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemini-2.0-flash-lite': { inputPerMillion: 0, outputPerMillion: 0 },
};

/** Models billed at nothing, as opposed to models whose price is unknown. */
export function isFreeModel(model: string): boolean {
  const pricing = PRICING[model];
  return pricing !== undefined && pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0;
}

/**
 * Cost of a call in USD. Returns 0 for an unknown model rather than guessing —
 * a zero that is obviously wrong beats a plausible number that is quietly wrong.
 */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING[model];
  if (pricing === undefined) {
    return 0;
  }
  return (
    (promptTokens / 1_000_000) * pricing.inputPerMillion +
    (completionTokens / 1_000_000) * pricing.outputPerMillion
  );
}

export function isPricedModel(model: string): boolean {
  return PRICING[model] !== undefined;
}
