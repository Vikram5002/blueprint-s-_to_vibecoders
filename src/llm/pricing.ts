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
};

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
