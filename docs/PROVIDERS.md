# LLM providers

Two adapters implement `CompletionProvider`: Anthropic and Google Gemini.
Everything above them — the cached labeller, the intent extractor, the pipeline
— is provider-agnostic and unaware of either.

**Gemini is the default**, because it is genuinely free and Week 14 runs
labelling across 50–100 repositories. Anthropic stays fully wired and one
variable away.

```bash
# default: Gemini
vibe-blueprint .

VIBE_LLM_PROVIDER=anthropic vibe-blueprint .
VIBE_LLM_MODEL=gemini-3.5-flash-lite vibe-blueprint .
```

| Variable | Meaning |
|---|---|
| `VIBE_LLM_PROVIDER` | `gemini` (default) or `anthropic` |
| `VIBE_LLM_MODEL` | Overrides the model for the selected provider |
| `GEMINI_API_KEY` | Read from the environment or `.env` |
| `ANTHROPIC_API_KEY` | Read from the environment or `.env` |

Selection is explicit, never "whichever key happens to be set". A machine with
both keys would otherwise pick a provider by accident, and a run would be
reproducible only until somebody's environment changed.

---

## Choosing the model: what the API actually said

The brief proposed `gemini-2.0-flash`. **It does not work**, and neither does
the other obvious candidate. Verified against the live `ListModels` endpoint and
by real `generateContent` calls on 2026-08-09:

| Model | Result |
|---|---|
| `gemini-2.0-flash` | **429** `RESOURCE_EXHAUSTED` — the 2.0 family carries no free quota |
| `gemini-2.0-flash-lite` | **429** — same |
| `gemini-2.5-flash` | **404** — "no longer available to new users" |
| `gemini-2.5-flash-lite` | **404** — same |
| `gemini-3.5-flash` | works; `thinkingBudget: 0` supported |
| `gemini-3.5-flash-lite` | works; rejects `thinkingConfig` |
| `gemini-3.6-flash` | works; rejects `thinkingConfig`, and slower |

Either of the first two would have shipped as a confident default that fails on
every single run. This is the argument for checking rather than assuming.

**Default: `gemini-3.5-flash`.** Newest flash model that is stable, pinned, free,
and supports both `responseSchema` and `thinkingConfig`.

Deliberately **not** `gemini-flash-latest`. A floating alias changes model
underneath a cache keyed on the model string, silently mixing answers from two
models in one cache file and breaking the reproducibility the whole project
rests on. Pinning is the point.

---

## Rate limits

The free tier is metered per project **per model**, which matters more than it
sounds: exhausting one model does not touch another's quota, and switching model
is a real workaround.

A 429 body names exactly which limit was hit:

```
quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier
quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier
quotaId: GenerateContentInputTokensPerModelPerMinute-FreeTier
```

Google does not publish these as response headers, and none of the successful
responses carried a quota header of any kind — the only way to learn a limit is
to hit it.

### Measured, the hard way

Development on 2026-08-09 exhausted the **daily** request quota on
`gemini-3.5-flash` after roughly twenty requests, and then on `gemini-3.6-flash`
shortly after. That is a small number, and the consequence is worth stating
plainly:

> **The free tier cannot label a medium repository more than once or twice a
> day on a single model.** Pyright is 46 modules, so one full run is 46 requests
> plus intent extraction.

The three-repository test in this document (71 label requests) completed only by
moving to `gemini-3.5-flash-lite`, which still had its own daily quota.

For Week 14's 50–100 repositories this is the binding constraint, not cost.
Realistic options, in order:

1. **Lean on the cache.** A repository is paid for once; re-runs are free. The
   study is not 100 cold runs, it is 100 first runs spread over time.
2. **Rotate models.** Quota is per model, so `gemini-3.5-flash`,
   `-flash-lite` and `gemini-3.6-flash` are three separate daily budgets.
3. **Use Anthropic for the study.** It is already wired, and the projected cost
   is $0.0021–$0.0195 per repository (see `docs/LABELLING.md`) — a few dollars
   for the whole study, against a schedule dictated by daily caps.

The honest reading is that "free" bought a lower bill and a harder schedule.

### What happens when a request is rate-limited

Never a silent failure. The behaviour depends on which limit was hit, and the
distinction is the reason the retry logic is not three lines:

**Per-minute limits are retried with backoff.** Up to 5 attempts. The delay
comes from the server's own `RetryInfo.retryDelay` when it supplies one —
guessing longer than instructed wastes time, guessing shorter earns another 429
— otherwise exponential from 1 s, doubling, capped at 60 s.

**Per-day limits fail immediately** with a message saying so:

```
daily free-tier quota exhausted (GenerateRequestsPerDayPerProjectPerModel-FreeTier).
This resets at midnight Pacific; retrying now cannot help.
```

Backing off through five attempts against a daily cap burns about a minute per
module to arrive at the same failure. On a 46-module repository that is three
quarters of an hour of sleeping before the run gives up.

**Other outcomes:** 5xx and network errors retry with backoff; 400, 401, 403 and
404 do not, because a bad key or a wrong model name fails identically five times.
A module whose call ultimately fails keeps its mechanical name and is listed in
the run report — labelling degrades, it never breaks a run.

---

## Untrusted input and validation are unchanged

The Gemini adapter reuses every defence built in Week 6, and weakens none of
them:

- The same `SYSTEM_PROMPT`, the same fencing of repository content, the same
  neutralising of the delimiter.
- The same `validate.ts` on the way back. Structured output from a provider is a
  convenience, not a guarantee; the strict check runs regardless of who answered.
- The same response cache, so an unchanged repository is never re-sent.

One difference is worth recording. Gemini's schema dialect rejects
`additionalProperties`, so it is stripped from the copy sent to Gemini. That is
not a weakening: `additionalProperties: false` stops a provider inventing extra
fields, and the check that actually matters — is this a two-field object with a
short string label — happens in `validate.ts` for both providers identically.

### A bug the second provider exposed

The labeller never sent its output schema. The Anthropic adapter substituted one
whenever a caller left `schema` unset, so nothing failed and nothing looked
wrong. Gemini received no schema, returned `{"name": ...}` where the validator
wanted `label`, and every module in the first live run was rejected.

The validation layer behaved correctly — it refused output that did not match the
contract. The contract was simply never sent. Both call sites now pass the schema
explicitly and no adapter supplies a default, because an interface that works
only because one implementation guesses on your behalf is not provider-agnostic.

That is the concrete argument for keeping Anthropic wired rather than deleting
it: a second implementation is what turns "provider-agnostic" from a claim into
a tested property.

---

## The cache is shared, and stays keyed on the model

The cache layer is reused unchanged. Its key is a SHA-256 of **model, system
prompt, user prompt and schema** — the same derivation for every provider, with
no provider-specific branch.

The brief asked that switching providers not invalidate the cache, and it does
not: entries are **additive**. Nothing is deleted or overwritten when the
provider changes. Switching to Gemini populates Gemini entries alongside the
Anthropic ones, and switching back still hits every entry Anthropic wrote.

The model does stay *in* the key, and it has to. Serving a Gemini answer to an
Anthropic request would mean a run reporting labels a model never produced —
and it would break `scripts/compare-label-models.mjs` completely, since that
script exists to compare what different models say about the same modules. A
provider-blind key would have it compare a model against a cached copy of
itself.

So: no invalidation, no cross-contamination, and one cold pass per model.

---

## Measured results

All three reference repositories, real API calls, `gemini-3.5-flash-lite`
(the default's daily quota having been exhausted during development).

| Repo | Files | Modules | Labelled | Input tok | Output tok | Cost | Cold run |
|---|---|---|---|---|---|---|---|
| requests | 37 | 6 | **6/6** | 1,907 | 187 | **$0** | 9 s |
| zod | 406 | 19 | **19/19** | 11,677 | 627 | **$0** | 92 s |
| pyright | 1,917 | 46 | **46/46** | 19,941 | 1,477 | **$0** | 179 s |

100% of modules labelled on every repository, zero failures.

**Cache on an unchanged re-run: 100% hit, zero calls, zero cost** — 1 s, 2 s and
6 s respectively.

### Against Week 6's Haiku projections

Week 6 never ran Haiku, so those figures were projections from real prompts.
Comparing like with like on input tokens:

| Repo | Haiku projected in/out | Gemini measured in/out | Haiku projected cost | Gemini actual |
|---|---|---|---|---|
| requests | 860 / 240 | 1,907 / 187 | $0.0021 | **$0** |
| zod | 6,732 / 760 | 11,677 / 627 | $0.0105 | **$0** |
| pyright | 10,303 / 1,840 | 19,941 / 1,477 | $0.0195 | **$0** |

Gemini's input counts run roughly 2× the projection. That is not a difference in
what was sent — the prompts are identical — but in tokenisation and in the fact
that the projection assumed Anthropic's prompt caching would make the repeated
system prompt nearly free after the first call. Gemini is not asked to cache the
prefix, so every call pays for it in full. Output tokens are consistently
*lower*, because thinking is disabled for labelling.

The like-for-like conclusion: **same work, same prompts, roughly double the
billed input tokens, and a bill of nothing.**

### Label quality

Not vaguer. On pyright, 46 labels:

- mean **3.09 words** per label
- **41 of 46 distinct**

It also disambiguates modules that share a mechanical name, which is the job:
four separate modules all rooted at `packages/pyright-internal/src/` came back as
*Code Analysis Engine*, *Type Analyzer Core*, *Docstring Processing Engine* and
*Type Server Protocol*.

A side-by-side run against Haiku is still **not possible** — no
`ANTHROPIC_API_KEY` exists in this environment, which is the same blocker
recorded in Week 6. `scripts/compare-label-models.mjs` now spans providers and
will produce the comparison in one command as soon as a key is available:

```bash
node scripts/compare-label-models.mjs . gemini-3.5-flash claude-haiku-4-5
```

---

## Secrets

- Read from `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`, in the environment or in
  `.env` (gitignored).
- `.env` is loaded **only** at the binary entry point, and from the *working
  directory* — never from the repository being analysed. Pointing this tool at
  an untrusted checkout must not pick up a stranger's `.env` and spend against
  it. A guard test enforces that only `cli.ts` loads it.
- The Gemini key travels in the `x-goog-api-key` **header**, never a `?key=`
  query parameter, so it cannot surface in a URL that reaches an error message,
  a proxy log or a stack trace.
- Every error body is passed through a redaction pass before display, and a test
  asserts no failure message contains the key.
- Nothing logs, returns or formats a key value. `describeKeySource` reports
  *where* a key came from without revealing what it is, or even how long it is.
