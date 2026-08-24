/**
 * Local implementation of CompletionProvider — serves the baseline QLoRA
 * checkpoint (run_20260822_130636: Qwen2.5-7B-Instruct + LoRA adapter) via a
 * local HTTP server, instead of a vendor API.
 *
 * ## No SDK, same as bluesminds.ts and gemini.ts
 *
 * Plain `fetch` against a local server. The model itself only runs in Python
 * (torch/transformers/peft) — there is no way to load this checkpoint inside
 * Node — so `local_inference_server.py` (project root, not part of this repo's
 * source; see the desktop session that produced this file) loads the model
 * once and stays warm, and this adapter is the thin HTTP client for it. The
 * server already speaks the exact `CompletionResult` JSON shape, so this file
 * does not reshape the response the way bluesminds.ts has to for an
 * OpenAI-shaped body — it validates and passes it through.
 *
 * ## schemaDowngraded, always true when a schema is requested
 *
 * Unlike Anthropic's `output_config.format` or Gemini's `responseSchema`,
 * there is no constrained/structured decoding wired up in the local server —
 * plain greedy or sampled generation only. Every request that supplies
 * `schema` is reported as downgraded, per provider.ts's own contract: this is
 * not less safe (`validate.ts` still checks the shape on the way back
 * regardless of provider) but it is less constrained, and that has to be
 * visible rather than silently assumed equivalent to the vendor providers.
 */
import type { CompletionProvider, CompletionRequest, CompletionResult } from './provider.js';

export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8712';
export const DEFAULT_LOCAL_MODEL = 'local:qwen2.5-7b-instruct+run_20260822_130636';

export interface LocalOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

function isCompletionResult(value: unknown): value is CompletionResult {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  const v = value as { ok: unknown };
  return typeof v.ok === 'boolean';
}

export function createLocalProvider(options: LocalOptions = {}): CompletionProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_LOCAL_BASE_URL;
  const model = options.model ?? DEFAULT_LOCAL_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: `local:${model}`,
    model,

    complete: async (request: CompletionRequest): Promise<CompletionResult> => {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch (cause) {
        return { ok: false, error: { kind: 'unavailable', message: `network error: ${String(cause)}` } };
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, error: { kind: 'unavailable', message: `response was not JSON (HTTP ${response.status})` } };
      }

      if (!response.ok) {
        return { ok: false, error: { kind: 'unavailable', message: `HTTP ${response.status}` } };
      }

      // The server already emits the CompletionResult shape directly - this
      // is the validation step, not a reshape, matching provider.ts's own
      // "trust nothing from the wire" posture even though the wire in this
      // case is a server this adapter also controls.
      if (!isCompletionResult(parsed)) {
        return { ok: false, error: { kind: 'unavailable', message: 'response did not match CompletionResult shape' } };
      }

      return parsed;
    },
  };
}
