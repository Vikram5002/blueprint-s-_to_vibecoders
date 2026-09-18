/**
 * Local implementation of CompletionProvider — serves a QLoRA checkpoint
 * (Qwen2.5-7B-Instruct + LoRA adapter, r=16/alpha=16, 3 epochs) via an HTTP
 * inference server, instead of a vendor API.
 *
 * Two checkpoints exist. training/eval/RESULTS-run_20260912_154324.md records
 * why run_20260912_154324 (288 rows) is the better one: tied with the
 * baseline on held-out pass-count and the (structurally unfixable) fake-id
 * defect, but a real, measured fix to the training data's 73.6%
 * empty-constraint skew (0/10 constraint-bearing outputs under the baseline,
 * vs. 4/10 and then 17/18 grounded on a larger targeted probe).
 *
 * `DEFAULT_LOCAL_MODEL` nonetheless names the BASELINE, run_20260822_130636
 * (91 rows), because it is the checkpoint that is actually served: it is the
 * only adapter present in the distributed bundle and the Colab notebook
 * (docs/colab/), whose server is started with exactly this model name. The
 * default previously named the newer checkpoint, so every answer the
 * baseline produced was labelled - and cached - as the newer model's, which
 * is precisely the provenance confusion this project exists to prevent.
 * When the newer adapter is what is being served, say so explicitly:
 * VIBE_LLM_MODEL=local:qwen2.5-7b-instruct+run_20260912_154324.
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

/**
 * Overrides where the local model is served from.
 *
 * Loopback is the common case, but it is not the only one: this checkpoint
 * is a 7B that needs more VRAM than some machines have, so the server
 * legitimately runs somewhere else — another machine on the LAN, or a free
 * cloud GPU reached through a tunnel — while the workspace stays local. The
 * adapter is unchanged either way; only the origin moves.
 *
 * A tunnel hands out a new hostname every session, which is why the runtime
 * setting (provider-registry.ts, persisted alongside the provider choice)
 * exists on top of this: nobody should have to edit a dotfile and restart
 * the server twice an hour. This variable is the initial default.
 */
export const LOCAL_BASE_URL_ENV = 'VIBE_LOCAL_BASE_URL';

/** Trailing slashes are trimmed so `${baseUrl}/complete` can never produce a double slash, which some tunnels answer with a redirect rather than the route. */
export function readLocalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[LOCAL_BASE_URL_ENV]?.trim();
  return configured === undefined || configured === '' ? DEFAULT_LOCAL_BASE_URL : configured.replace(/\/+$/, '');
}
export const DEFAULT_LOCAL_MODEL = 'local:qwen2.5-7b-instruct+run_20260822_130636';

/**
 * The code-writing checkpoint (Qwen2.5-Coder + the code adapter; see
 * docs/LOCAL-CODE-MODEL-PLAN.md). A *served name*, matched verbatim by
 * `local_inference_server.py` against its `--model name=base:adapter` list -
 * the `local-code:` prefix is part of the name, not stripped, so a cached or
 * recorded answer can never be confused with the planner's.
 */
/** The name the inference server knows a model by: everything before the first ':' of its label. */
export function servedModelName(label: string): string {
  const colon = label.indexOf(':');
  return colon === -1 ? label : label.slice(0, colon);
}

export const DEFAULT_LOCAL_CODE_MODEL = 'local-code:qwen2.5-coder-7b-instruct+code-adapter';

/**
 * Where the code model is served from, when that is not the same server as
 * the planner. Both adapters can run in one Colab session (one process, two
 * `--model` flags) or in two sessions with two tunnels; unset, this falls
 * back to `VIBE_LOCAL_BASE_URL` and so to the single-server case.
 */
export const LOCAL_CODE_BASE_URL_ENV = 'VIBE_LOCAL_CODE_BASE_URL';

export function readLocalCodeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[LOCAL_CODE_BASE_URL_ENV]?.trim();
  return configured === undefined || configured === '' ? readLocalBaseUrl(env) : configured.replace(/\/+$/, '');
}

/**
 * Wall-clock ceiling on a single request. Node's `fetch` has no default
 * timeout — `gemini.ts`'s own `REQUEST_TIMEOUT_MS` exists because an untimed
 * call once hung a corpus run for over twenty minutes at near-zero CPU, and
 * this adapter had no equivalent until now, unlike every other one.
 *
 * That gap mattered more here than it would for a vendor API: this server
 * has been measured at 10.7-27s per request with zero concurrency handling
 * — one GPU, one model, requests serialize — so a stuck or heavily contended
 * request had no path to ever reach a terminal state; a caller polling a job
 * (see `server/workflow-api.ts`) would see it sit in `running` forever.
 *
 * This was 300s while the only thing served was the planner (worst
 * single-request latency measured: 27s). The code model changed the
 * arithmetic: a 4,096-token code file at the ~12 tok/s a T4 manages for a
 * 7B in 4-bit is ~340s of pure generation, before prompt processing and
 * before any queuing behind another request on the same GPU - so 300s
 * would have cut off exactly the requests that were working. 900s covers
 * a full-length file plus one request queued ahead of it, while still
 * eventually surfacing a genuinely dead connection as a real failure rather
 * than an invisible hang. Not tuned to bound expected contention — like
 * `gemini.ts`'s timeout, it exists to catch the dead-connection case, not to
 * promise a latency ceiling under load.
 */
export const REQUEST_TIMEOUT_MS = 900_000;

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

/** What `GET /models` on the inference server reports: every served checkpoint, and which one a request without `model` gets. */
export interface ServedModels {
  readonly models: readonly { readonly name: string; readonly base: string; readonly adapter: string }[];
  readonly default: string;
}

function isServedModels(value: unknown): value is ServedModels {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { models?: unknown; default?: unknown };
  if (typeof v.default !== 'string' || !Array.isArray(v.models)) return false;
  return v.models.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as { name?: unknown; base?: unknown; adapter?: unknown };
    return typeof e.name === 'string' && typeof e.base === 'string' && typeof e.adapter === 'string';
  });
}

/**
 * Asks the server which models it serves. Null on any failure - transport,
 * non-2xx, or a server too old to have the route - so a caller can treat
 * "reachable" and "tells us what it serves" as separate facts.
 */
export async function probeModels(
  baseUrl: string = DEFAULT_LOCAL_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<ServedModels | null> {
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(MODELS_PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    return isServedModels(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Short, like the registry's reachability probe: this renders a picker, it does not serve a request. */
const MODELS_PROBE_TIMEOUT_MS = 4_000;

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
          // `model` picks which served checkpoint answers when the server
          // hosts more than one; a server that predates the field ignores it.
          // The served NAME is the label's prefix before the first ':' -
          // 'local', 'local-code', 'teacher' - so the Colab notebook's
          // --model names and these labels cannot disagree.
          body: JSON.stringify({ ...request, model: servedModelName(model) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
