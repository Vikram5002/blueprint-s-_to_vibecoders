/**
 * Mirrors src/llm/provider-registry.ts's ProviderStatus and
 * src/llm/select-provider.ts's ProviderName, hand-duplicated for the same
 * rule-4 reason every other mirror file in this directory documents for
 * itself: ui/ must not import from src/ directly.
 */

export type ProviderName = 'gemini' | 'local' | 'anthropic' | 'bluesminds';

export interface ProviderStatus {
  readonly id: ProviderName;
  readonly label: string;
  readonly model: string;
  readonly available: boolean;
  readonly detail: string;
}

export interface ProvidersResponse {
  readonly current: ProviderName;
  readonly providers: readonly ProviderStatus[];
  /** Present when the provider just selected is not currently reachable/configured. */
  readonly warning?: string;
}
