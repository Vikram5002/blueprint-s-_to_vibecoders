# Local CompletionProvider adapter — build & verification report

**Date:** 2026-08-24
**Checkpoint served:** baseline `run_20260822_130636` (Qwen2.5-7B-Instruct + LoRA, r=16/alpha=16/3 epochs, the config with final loss 0.903)

## What was built

Two pieces, deliberately split:

1. **`src/llm/local.ts`** — the real feature code. Implements `CompletionProvider`
   exactly as fetched from the repo's `src/llm/provider.ts` (not guessed —
   `provider.ts` is saved alongside it here for the type-check to run against).
   Plain `fetch`, no SDK, matching `bluesminds.ts`'s and `gemini.ts`'s own
   convention of avoiding a vendor dependency for a mapper this small.

2. **`local_inference_server.py`** (project root, **not** part of the TS repo) —
   loads the base model + adapter once and stays warm, serving `POST /complete`
   in the exact `CompletionResult` JSON shape. This exists because the model
   only runs in Python; `local.ts` is the thin client that talks to it. This
   split mirrors the repo's own boundary (`src/` = TypeScript orchestration,
   `training/` = Python model work) — the server is desktop-session
   infrastructure, the adapter is the reviewable feature.

**Where it belongs:** `src/llm/local.ts`, alongside `anthropic.ts`, `gemini.ts`,
`bluesminds.ts` — confirmed by listing `src/llm/` before writing anything.
**Not wired into `select-provider.ts`'s `ProviderName` union or routing** —
that changes production provider selection and felt like a separate decision,
not something to fold in unasked. Flagging it as the natural next step if this
adapter is kept.

## Interface-compliance proof (not "looks similar")

`provider.ts` was fetched from the real repo and saved locally. A strict
TypeScript type-check was run against `local.ts` plus a test harness that does
**exhaustive discriminated-union narrowing** on the real `CompletionResult`
type (`if (result.ok) { const {text, usage, model, schemaDowngraded} = ... }
else { const {kind, message} = result.error }`) — this only compiles if
`local.ts`'s actual return value structurally satisfies what `provider.ts`
declares.

```
npx tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022
  src/llm/provider.ts src/llm/local.ts test-local-provider.ts
exit code: 0, zero errors
```

## Functional test: 3 held-out prompts, through the real interface path

Not the standalone `generate-holdout-outputs.py` script — this went through
`createLocalProvider().complete(request)`, the actual `CompletionProvider`
call site.

| # | Prompt (truncated) | ok | Client latency | Server latency | Valid JSON |
|---|---|---|---|---|---|
| 1 | "A journaling app where I write a daily entry..." | true | 24844 ms | 24.82 s | yes |
| 2 | "A peer-to-peer tool lending app for a neighbourhood..." | true | 26842 ms | 26.84 s | yes |
| 3 | "A dice roller for tabletop games." | true | 20863 ms | 20.86 s | yes |

Client-measured and server-measured latency match almost exactly — localhost
network overhead is negligible, as expected.

**Also tested, separately, to exercise paths the 3 main prompts didn't hit:**
- `maxOutputTokens` set deliberately low (5) → correctly returned
  `{ok: false, error: {kind: 'incomplete', ...}}`, proving the truncation-vs-
  success distinction `provider.ts` calls out as its own failure kind actually
  works, not just typed correctly.
- A request with `schema` set → correctly returned `schemaDowngraded: true`,
  since this server has no constrained/structured decoding (unlike Anthropic's
  `output_config.format` or Gemini's `responseSchema`) — reported per the
  interface's contract rather than silently ignored.

## Peak VRAM and per-request latency (first real measurement of this)

Everything before this session measured either training VRAM or a one-shot
script's cumulative peak (model load + generation combined, 8.36GB for the
baseline eval). This is the first measurement of **steady-state, warm-model,
per-request inference** — `torch.cuda.reset_peak_memory_stats()` is called at
the start of each request handler, isolating generation-only memory:

- **Peak VRAM per request: 5.77 GB**, consistent across all 3 calls (this
  excludes the one-time model+adapter load cost, which is a separate, larger
  spike not relevant to a warm server's steady state).
- **Per-request latency: 20.9-26.8s** for ~210-270 completion tokens each
  (greedy decoding, temperature 0).

**Contention caveat, same discipline as every run today:** PID 30268 finished
partway through this session; a successor job, **PID 28748** (`spoof_generation
--expect-pool eval`, same unrelated pipeline, different job batch) was active
for the entire local-provider build and test. These latency/VRAM numbers are
not clean-GPU numbers — treat them as directionally useful, not a clean
baseline for the adapter's actual production latency.

## Open question: is 20-27s latency acceptable for the app-builder flow?

**Genuinely undecided — not answered here, stated as open rather than assumed.**

This report has no information about the orchestrator's latency requirements —
`provider.ts`, `select-provider.ts`, and the other adapters don't state an SLA,
and nothing in `TRAINING-FORMAT.md` or the dataset methodology addresses it
either (that document is about training-data shape, not serving latency). What
can be said from what was actually measured:

- **20.9-26.8s per request** (this session's 3-prompt test, ~210-270 completion
  tokens each, contended GPU) is far outside what a synchronous, in-the-loop
  "user is watching a spinner" UX typically tolerates — most such flows target
  low single-digit seconds.
- It is well within range for an **offline/batch path**: pre-generating
  ProjectSchemas for a queue, a background job, or an async "check back in a
  minute" flow.
- The other three providers' actual latency isn't measured anywhere in this
  session either, so there's no same-machine, same-conditions comparison to
  say "X times slower than Gemini" with any confidence — that would need to be
  measured, not assumed.
- The number itself is also contention-inflated (see the caveat above) and
  reflects one specific config (baseline, greedy decoding, temperature 0,
  ~1024 token budget) — a clean-GPU number, a shorter `maxOutputTokens`, or a
  smaller/faster serving setup (e.g. vLLM instead of plain `transformers.generate`,
  batching concurrent requests) could plausibly change this substantially in
  either direction, none of which was tried here.

**If this adapter moves forward, the orchestrator's actual latency tolerance is
a fact to go get, not infer** — this report flags the gap rather than guessing
which side of it 20-27s falls on.

## Not done

- Not validated against the real `validateProjectSchema` — sanity-checked as
  "valid JSON" only, per your standing instruction that real validation
  happens on LOQ.
- Not wired into `select-provider.ts` — a routing/registration decision, not
  made here.
- Not committed anywhere — this lives in this desktop session's working
  folder for review.

## Files

- `src/llm/local.ts` — the adapter (the actual deliverable, if kept)
- `src/llm/provider.ts` — real interface, fetched read-only for reference/type-checking
- `local_inference_server.py` — local desktop inference server (not repo code)
- `test-local-provider.ts` — the proof harness used above
- `local-provider-test-results.json` — raw output of the 3-prompt test
- `tsconfig.local-provider-check.json` — the type-check config used
