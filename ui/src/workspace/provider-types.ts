/**
 * Mirrors src/llm/provider-registry.ts's ProviderStatus and
 * src/llm/select-provider.ts's ProviderName, hand-duplicated for the same
 * rule-4 reason every other mirror file in this directory documents for
 * itself: ui/ must not import from src/ directly.
 */

export type ProviderName = 'gemini' | 'local' | 'local-code' | 'anthropic' | 'bluesminds';

export interface ProviderStatus {
  readonly id: ProviderName;
  readonly label: string;
  readonly model: string;
  readonly available: boolean;
  readonly detail: string;
}

export interface ProvidersResponse {
  readonly current: ProviderName;
  /** Who writes application code, when that differs from `current` (who writes the plan). null = same as `current`. */
  readonly codeProvider: ProviderName | null;
  /** Where the local inference server is expected - loopback, a LAN machine, or a cloud-GPU tunnel. */
  readonly localBaseUrl: string;
  /** Where the local CODE model's server is expected - the same origin as `localBaseUrl`, or a second tunnel. */
  readonly localCodeBaseUrl: string;
  readonly providers: readonly ProviderStatus[];
  /** Present when the provider just selected is not currently reachable/configured. */
  readonly warning?: string;
}
