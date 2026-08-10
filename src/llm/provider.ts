/**
 * Provider-agnostic completion interface.
 *
 * The rest of the codebase talks to this, never to a vendor SDK. Swapping
 * providers, or running without one, changes only which factory is constructed
 * — `pipeline/label.ts` takes a labeller as an argument and has no idea who
 * answers it.
 *
 * Deliberately small. This project asks a model two kinds of question — "name
 * this cluster" and "what does this document require" — and both are one call
 * that returns structured text. No streaming, no tools, no conversation state:
 * nothing here needs them, and an interface built for capabilities we do not
 * use is an interface nobody can reimplement.
 */

export interface CompletionRequest {
  /** Stable instructions. Kept separate so a provider can cache the prefix. */
  readonly system: string;
  /** The per-cluster payload. Untrusted repository content — see prompt.ts. */
  readonly user: string;
  readonly maxOutputTokens: number;
  /**
   * Sampling temperature, where the provider supports it.
   *
   * Present because a provider-agnostic interface needs it — most providers
   * take it and 0 is the reproducible setting. The Anthropic adapter sends it
   * only to models that still accept the parameter; see anthropic.ts.
   */
  readonly temperature?: number;
  /**
   * JSON schema the answer must conform to.
   *
   * Passed per request rather than fixed by the provider, because the two call
   * sites want different shapes. Validation still happens again on the way back
   * — a provider-enforced schema is a convenience, not a guarantee, and for
   * intent extraction it is guarding against hostile input rather than sloppy
   * output.
   */
  readonly schema?: Readonly<Record<string, unknown>>;
  /**
   * How much reasoning the task warrants. Naming a cluster is a lookup; reading
   * obligations out of prose is not.
   */
  readonly effort?: 'low' | 'medium' | 'high';
}

export interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Prompt tokens served from the provider's own cache, when reported. */
  readonly cachedPromptTokens: number;
}

export interface CompletionResponse {
  readonly text: string;
  readonly usage: CompletionUsage;
  /** Model that actually served the request, which may differ from the one asked for. */
  readonly model: string;
  /**
   * True when the provider could not enforce the requested output schema and
   * the call fell back to asking for plain JSON.
   *
   * Optional because most providers never do this. Reported rather than
   * swallowed: `validate.ts` still checks the shape on the way back, so the
   * answer is not less safe — but it is less *constrained*, and a run that
   * silently downgraded is a run whose output quality has a different
   * explanation than the model.
   */
  readonly schemaDowngraded?: boolean;
}

export type CompletionFailure =
  /** The provider declined, or returned nothing usable. */
  | { readonly kind: 'refused'; readonly message: string }
  /** Network, auth, rate limit, or any other transport-level problem. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /**
   * The answer was cut off at the output token limit.
   *
   * Its own kind, not a flavour of `refused`, because it is the one failure
   * that is indistinguishable from success unless it is named. A truncated
   * extraction parses to an empty statement list, which reads exactly like a
   * document that stated nothing — and that ambiguity is precisely what the
   * whole intent pipeline exists to avoid. Anything downstream that reports a
   * count must be able to say "incomplete" instead of "none".
   */
  | { readonly kind: 'incomplete'; readonly message: string };

export interface CompletionProvider {
  /** Short identifier for reporting, e.g. `anthropic:claude-opus-5`. */
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type CompletionResult =
  | { readonly ok: true; readonly value: CompletionResponse }
  | { readonly ok: false; readonly error: CompletionFailure };
