# LLM providers

Three adapters implement `CompletionProvider`: Bluesminds, Google Gemini and
Anthropic. Everything above them — the cached labeller, the intent extractor,
the pipeline — is provider-agnostic and unaware of any of them.

## The three have different jobs

| Provider | Role | Why |
|---|---|---|
| **Bluesminds** | Default, for corpus-scale labelling and extraction | Not quota-capped. Gemini's free tier caps at roughly 20 requests per model per day, which one repository can exhaust — that cap, not money, is what blocks Week 14. |
| **Gemini** | Fallback, retained and working | Free, fast, and measurably better label quality (below). The right choice for anything small enough to fit the daily cap. |
| **Anthropic** | Reserved for the Haiku/Sonnet comparison | That comparison **must run direct**. Routing a provider comparison through a gateway measures the gateway. |

```bash
# default: Bluesminds
vibe-blueprint .

VIBE_LLM_PROVIDER=gemini    vibe-blueprint .
VIBE_LLM_PROVIDER=anthropic vibe-blueprint .
VIBE_LLM_MODEL=meta/llama-3.1-8b-instruct vibe-blueprint .
```

| Variable | Meaning |
|---|---|
| `VIBE_LLM_PROVIDER` | `bluesminds` (default), `gemini`, or `anthropic` |
| `VIBE_LLM_MODEL` | Overrides the model for the selected provider |
| `BLUESMINDS_API_KEY` | Read from the environment or `.env` |
| `GEMINI_API_KEY` | Read from the environment or `.env` |
| `ANTHROPIC_API_KEY` | Read from the environment or `.env` |

Selection is explicit, never "whichever key happens to be set". A machine with
all three keys would otherwise pick a provider by accident, and a run would be
reproducible only until somebody's environment changed.

---

## ⚠️ Provenance: what a gateway result can and cannot support

**For the paper's methodology section.**

Bluesminds is a *gateway*. It resells access to upstream models behind an
OpenAI-compatible API, and that changes what a result from it means:

- **A request routed through a third-party gateway cannot be attributed to a
  specific model version with certainty.** We send a model string and receive
  an answer. What actually served it — which weights, which quantisation, which
  serving stack, which silently substituted fallback — is not observable from
  the client.
- **Any result that needs firm provenance must be reproduced on a direct
  provider** (Gemini or Anthropic, calling the vendor's own endpoint) before it
  is published.

This is not hypothetical caution. Concretely observed on 2026-08-10:

- Every one of the 137 models in `GET /v1/models` reports `"owned_by": "openai"`,
  including `meta/*`, `nvidia/*`, `google/*` and `mistralai/*`. The field is a
  placeholder, not provenance.
- Response headers carry `nvcf-reqid` and `nvcf-status`, which identify
  **NVIDIA Cloud Functions** as the upstream for at least some models. The
  gateway itself runs `new-api` (`x-new-api-version: v1.0.0-rc.21`). Neither
  fact is documented; both were read off the wire.
- The catalogue advertises model names this project could not verify as genuine
  upstream releases (`gpt-5.5`, `deepseek-v4-pro`, `kimi-k2.6`, `gemma-4`).
  Some may be real; the point is that the gateway is the only witness.

The adapter reports the model the gateway *says* served each request, rather
than echoing the one we asked for, so a substitution is at least visible when
it is declared. It cannot detect an undeclared one.

**Practical rule:** Bluesminds for bulk work where the finding is about
repositories; Gemini or Anthropic for any finding about a model.

---

## The catalogue is not a list of working models

`GET /v1/models` returned **137 entries**. Eleven were probed with a real
schema-constrained request. **Two worked.**

| Model | Result |
|---|---|
| `meta/llama-3.3-70b-instruct` | ✅ works, ~15s, schema honoured, `finish_reason=length` correct |
| `meta/llama-3.1-8b-instruct` | ✅ works, ~1.3s, schema honoured, `finish_reason=length` correct |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | ⚠️ HTTP 200, `finish_reason=length`, **empty content** — spent the whole budget reasoning |
| `mistralai/mistral-medium-3.5-128b` | ❌ 410 end-of-life 2026-08-07 (three days before testing) |
| `deepseek-ai/deepseek-v4-flash` | ❌ 410 end-of-life 2026-08-07 |
| `qwen/qwen3-next-80b-a3b-instruct` | ❌ 410 end-of-life 2026-07-27 |
| `z-ai/glm4.7` | ❌ 410 end-of-life 2026-05-14 |
| `gpt-4o-mini` | ❌ 400 `"No connected db."`, later 429 |
| `gpt-4o` | ❌ 500 upstream error |
| `openai/gpt-oss-120b` | ❌ 504 gateway timeout |
| `google/gemma-3-12b-it` | ❌ 404 naming an internal function id |

Four of eleven were **listed but end-of-life**. The list endpoint is not
filtered against what is actually served, so "check the API instead of the
docs" is necessary but not sufficient — the only reliable test is a real call.

The adapter names a 410 explicitly rather than surfacing a bare status, because
the failure otherwise looks like a typo in a model string and is not.

### The pinned default

`meta/llama-3.3-70b-instruct`, an exact string. Never a floating alias, for the
same reason as `gemini-3.5-flash`: the response cache is keyed on the model
string, so an alias that silently repointed would mix two models' answers in
one cache file and break reproducibility.

`meta/llama-3.1-8b-instruct` is the fast alternative — roughly 1.3s against 15s
— when throughput matters more than label quality.

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

## Bluesminds, measured

All figures from 2026-08-10 against the three reference repositories.

### Rate limits: real, and undocumented

**The gateway sends no `Retry-After` and no `x-ratelimit-*` headers at all.**
A client has nothing to pace against; backoff is the only lever.

Measured: a full zod run (19 labels + 5 documents) exhausted the limit, after
which **six consecutive requests returned 429 immediately** — including
sequential ones, so this is not a concurrency limit. The window cleared after
roughly **90 seconds**.

This produced a real regression on first use. The adapter initially inherited
Gemini's retry policy — 5 attempts spanning about 15 seconds — and 15 seconds
is far inside a 90-second window:

| zod run | Labelled | Mechanical fallback | Intent failures |
|---|---|---|---|
| Gemini retry policy (5 attempts, ~15s) | 12 / 19 | 7 | 3 of 5 documents |
| Tuned policy (6 attempts, ~120s) | **19 / 19** | **0** | **0** |

Nine of the ten failures were `rate limited after 5 attempt(s)`. The tenth was
a genuine truncation, correctly reported as `incomplete` rather than accepted
as an empty label — the Week 10 check doing its job in production.

The gateway is also intermittently unstable independent of rate limiting: 504s
from `openresty` appeared under load on models that worked moments earlier.

### Label quality against the Gemini baseline

Same repository (zod), same 19 modules, same prompt:

| | Gemini `3.5-flash-lite` | Bluesminds `llama-3.3-70b` |
|---|---|---|
| Modules labelled | 19 / 19 | 19 / 19 |
| **Distinct labels** | **19 (100%)** | 17 (89.5%) |
| Repeated labels | none | `Validation Framework` ×3 |
| Domain-aware (names the project) | 4 | 0 |
| Average words per label | 2.95 | 2.37 |

**Gemini's labels are better**, and not marginally. Where Gemini distinguished
`Classic Zod API`, `Zod Core Engine`, `Classic Zod Schemas` and
`Schema Validation Core`, Bluesminds returned `Validation Framework` three
times plus `Validation Framework Core` — generic, repeated, and much less
useful in a diagram whose whole purpose is telling modules apart. Gemini also
correctly identified `Open Graph Image Generator` where Bluesminds guessed
`Edge Config Module`.

Extraction is worse too: on the same five zod documents Gemini found **8**
architectural-but-uncheckable statements; Bluesminds found **0**. Both found 0
checkable constraints.

**So the default is a throughput decision, not a quality one.** Bluesminds is
the default because it can finish a 100-repository run and Gemini cannot. For
any single repository small enough to fit the daily cap, `VIBE_LLM_PROVIDER=gemini`
gives better output.

### Cost

The gateway bills a prepaid balance and does not publish per-model rates in a
form the pricing table could track, so **Bluesminds models are deliberately
absent from `PRICING`**. `isPricedModel` returns false for them and the CLI
prints *"cost not tracked here — check your provider balance"* rather than
`$0.0000`, which would claim the calls were free.

Measured from `GET /v1/dashboard/billing/usage`:

| Point | `total_usage` |
|---|---|
| Baseline, before any run | 0.0223 |
| After requests + zod + model probing | 0.9765 |
| After the full zod re-run | 1.7954 |

**≈1.77 consumed** for roughly 60 calls across two repositories plus eleven
model probes. Following OpenAI's convention — which this gateway's API mirrors
— `total_usage` is in **cents**, putting the whole exercise near **US$0.018**.
The unit is not documented, so that reading is stated rather than asserted; the
reported limits (`hard_limit_usd: 100000000`) are placeholders and give no
independent check.

Either way the order of magnitude is the finding: this is roughly a cent and a
half for work that Gemini's free tier could not complete at all. **Cost is not
the constraint. Throughput, reliability and label quality are.**

---

## Secrets

- Read from `BLUESMINDS_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`, in
  the environment or in `.env` (gitignored).
- `.env` is loaded **only** at the binary entry point, and from the *working
  directory* — never from the repository being analysed. Pointing this tool at
  an untrusted checkout must not pick up a stranger's `.env` and spend against
  it. A guard test enforces that only `cli.ts` loads it.
- The Gemini key travels in the `x-goog-api-key` **header**, never a `?key=`
  query parameter, so it cannot surface in a URL that reaches an error message,
  a proxy log or a stack trace.
- The Bluesminds key travels as a `Bearer` **header**, never in a URL. Unlike
  Google's `AIza…`, this token has no documented shape to pattern-match, so
  redaction is an **exact substring replacement against the configured key**
  rather than a regex — a shape-based rule would silently fail to redact it.
  `Bearer …` sequences are scrubbed as well, since some gateways echo the
  received request back inside an error body.
- Every error body is passed through a redaction pass before display, and a test
  asserts no failure message contains the key.
- Nothing logs, returns or formats a key value. `describeKeySource` reports
  *where* a key came from without revealing what it is, or even how long it is.
