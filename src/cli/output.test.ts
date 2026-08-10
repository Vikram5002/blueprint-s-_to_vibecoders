import { describe, expect, it } from 'vitest';
import { describeCost } from './output.js';

describe('cost reporting distinguishes free from unknown', () => {
  /**
   * "$0.0000" meant two opposite things: Gemini's free tier genuinely costs
   * nothing, while a gateway absent from the pricing table costs something we
   * cannot compute. Printing the same string for both understates a real bill
   * as free — the same unmeasured-versus-measured conflation fixed in
   * extraction, drift and check_import.
   */
  it('says free when the model really is free', () => {
    expect(describeCost('gemini:gemini-3.5-flash', 0)).toBe('about $0.0000');
  });

  it('reports a real price when there is one', () => {
    expect(describeCost('anthropic:claude-haiku-4-5', 0.0123)).toBe('about $0.0123');
  });

  it('refuses to call an untracked gateway model free', () => {
    const described = describeCost('bluesminds:meta/llama-3.3-70b-instruct', 0);
    expect(described).not.toContain('$0.0000');
    expect(described).toContain('check your provider balance');
  });

  it('handles a model id containing colons or slashes', () => {
    expect(describeCost('bluesminds:meta/llama-3.1-8b-instruct', 0)).toContain('not tracked');
  });

  it('falls back to the figure when no provider ran', () => {
    expect(describeCost(null, 0)).toBe('about $0.0000');
  });
});
