# Gemini as a structured-output provider: what's actually been observed

Empirical findings from live calls made while building `src/workflow/generate-project-schema.ts`
against `gemini-3.5-flash`. Every claim below traces to a specific observed
call, commit, or log entry — nothing here is a general claim about LLMs or
advice sourced from outside this repo's own runs. Not a narrative; a
reference for whoever next touches this generator.

## 1. `response_schema` dialect incompatibilities

Four distinct request-schema shapes were rejected by live calls, each a real
HTTP 400 from Gemini, none caught beforehand — `PROJECT_SCHEMA_JSON_SCHEMA`
had never been sent to a real provider until then, so neither `tsc` nor the
stub-provider tests in `generate-project-schema.test.ts` could have caught
any of them; they only exercise the TypeScript shape and a fake completion
string, not Gemini's actual schema dialect.

| Rejected | Symptom | Replaced with |
|---|---|---|
| `{ const: <value> }` | 400, unsupported keyword | `{ enum: [<value>] }` |
| bare-numeric `enum` (e.g. `similarity: { enum: [0] }`) with no `type` | 400, different error than the `const` one | `type` added alongside the `enum` |
| `enum` on a `type`-annotated field, still rejected | 400, again a different error than either above — Gemini's `enum` appears to require string-typed values regardless of the field's declared `type` | replaced entirely: `similarity: { type: 'number', minimum: 0, maximum: 0 }` |
| `type: 'array'` with no `items` | 400 | explicit `items` added (e.g. `{ type: 'array', items: { type: 'string' }, maxItems: 0 }`) |

All four confirmed fixed via live Gemini calls, not inferred from
documentation. Commit: `eb76fc9` (`fix(workflow): make PROJECT_SCHEMA_JSON_SCHEMA
compatible with Gemini's response_schema`).

## 2. Fixed-value fields Gemini does not reliably echo

Every field in the request schema that could only ever have one correct
value — because nothing in this generator does comparison or resolution work
against a bare prompt — turned out to be a field Gemini would sometimes get
wrong, regardless of which mechanism (`const`, `enum`, or an
otherwise-constrained type) was used to ask for it:

- `status`, `origin` — failed 3/3 live attempts.
- `target`, `reason` — started failing on the very next attempt once
  `status`/`origin` stopped being requested. Confirmed not a one-off: an
  earlier `reason: null` response had been logged as "weaker, ambiguous
  evidence" at the time, since two other generations in between had a valid
  `reason`; a later live call resolved the ambiguity, and target/reason fail
  on what looks like a different subset of calls than status/origin did —
  the unreliability is broader than the first three fields fixed, not
  narrower.
- `similarity`, `alternatives` — an early scoping guess held that
  `alternatives` carried real content and only needed schema fixes to
  request it correctly. That guess was wrong: at generation time there is no
  comparison logic that could ever produce a non-empty `alternatives` or a
  non-zero `similarity` for a bare-prompt generation, so both are the same
  class of always-one-value field as `status`/`origin`, not genuine model
  output. (`similarity` did keep reaching its fixed value correctly via
  `minimum`/`maximum` — see §1 — but was still moved off the live path,
  since a value that can only ever be one thing has no reason to be
  requested at all.)
- `via.phrase`/`via.similarity`/`via.alternatives` — Gemini reliably omitted
  these on `via` specifically (`subject`/`object` were unaffected) on any
  constraint-bearing generation: 4 of 6 real attempts failed validation on
  this exact shape before the fix, and a follow-up diagnostic run confirmed
  the same failure twice in a row on the exact same prompt with the cache
  cleared each time — a consistent behavior for this request shape, not
  sampling noise.
- `provenance` (on both `Constraint` and the top-level `ProjectSchema`) —
  same class: only one code path can ever produce `'STATED'`.

**Resolution, applied uniformly**: stop requesting any of these from the
model. `fillResolvedSubjectFixedFields` sets `status`/`target`/`origin`/
`reason`/`similarity`/`alternatives` on `subject`, `object`, and `via`
programmatically after parsing; `fillOneConstraintFixedFields` sets
`provenance` (and `source.line`/`source.timestamp`, the same class of
problem for a different reason — no real value exists to ask for from a
bare-prompt generation). `via` additionally gets a null-fallback if `phrase`
still isn't a usable string after filling — `via` is optional and `null` is
its documented "no via" state, so this is a safe degrade, not fabricated
content. `subject`/`object` have no equivalent fallback and still correctly
fail validation if `phrase` is missing, since both are required.

Found across multiple live calls over two commits, not a single run:
`eb76fc9` (status/origin/target/reason/provenance/line/timestamp) and
`b808167` (similarity/alternatives, and the `via` omission fix).

## 3. Determinism across separate calls: measured, and it's bimodal, not random

Superseded by a real 10-call measurement (below) what was earlier only two
data points. The two original observations are kept as historical context,
since they're what motivated running the real measurement:

- **Divergent**: re-running the same prompt ("carpool coordinator") produced
  a completely different constraint set on a fresh call than an earlier
  generation for that same prompt — different `dependsOn`, different
  constraint content. (The original output that would let this be diffed
  byte-for-byte was lost to an overwrite in the diagnostic script's earlier,
  single-file output format, before it became an append-only JSONL log —
  the divergence was observed directly at the time, but isn't independently
  re-inspectable now.)
- **Stable**: two consecutive fresh calls on the same prompt ("A carpool
  coordinator app for organizing shared rides") produced output identical
  in every field except `source.timestamp` and the log's own top-level
  `timestamp` — both expected to differ, since `generatedAt` is stamped
  fresh per real generation by design. Recorded in
  `scratch-pipe-schema-to-compiler-log.jsonl`, entries 0 and 1
  (`2026-08-29T18:38:50.307Z` and `2026-08-29T18:38:56.224Z`). A planned
  third call in the same test was blocked by the daily quota (see §4,
  entry 2, `18:38:56.573Z`) before it could confirm or contradict either
  reading.

### The real measurement: 10 fresh calls, same prompt, cache cleared before each

Same prompt as above, against `gemini-3.5-flash` (the pipeline's actual
default), `.vibe/` deleted before every one of the 10 calls so every call
was a genuine live generation, never a cache hit. All 10 succeeded.

**Result: exactly two clusters of 5, each byte-identical within itself
(excluding `timestamp`/`sessionId`), 0 of 10 matching all 9 others.** Not
noisy variation around one answer — two distinct, individually stable
outputs, split 50/50:

| Field | Cluster A (5 calls) | Cluster B (5 calls) |
|---|---|---|
| `dependsOn` topology (all 4 domains) | identical to Cluster B | identical to Cluster A |
| `backend` component 2 | "User and Profile Service" (profile management) | "Carpool Matching Engine" (ride-matching algorithm) — a different feature, not a paraphrase |
| every component's `purpose` text | differs in wording from Cluster B even where names match | differs in wording from Cluster A even where names match |
| `constraints.length` | 1 (`must-not-import`) | 2 (`must-not-import`, `must-be-layer-above`) |

**Plain determinism rate: 50% (5/10) match any given call exactly; the
other 50% form a second, equally stable alternative.** Framed the way a
caching or Layer-3 routing decision needs it: asking the same question
twice is close to a coin flip between two specific, real, reproducible
answers — not a rare edge case, and not unbounded noise either.

**A secondary, smaller data point on a different model** (`gemini-3.5-flash-lite`,
tried only because `flash`'s daily quota was exhausted mid-session):
10 attempted, 6 failed on transient `HTTP 503` (server overload, not
quota — a real but separate instability), 4 succeeded, and **all 4 differed
from each other** — including one case where `security` depended on
`backend`, a dependency edge absent from the other 3 and reversed from
that pair's usual direction. Not folded into the 50% figure above since
it's a different model and a much smaller sample (n=4), but worth
recording: whatever `flash`'s bimodal stability is, `flash-lite` is
visibly less stable, not more.

**Conclusion**: not "uncharacterised" any more. On the pipeline's actual
default model, repeated generation from the same prompt is bimodal —
two stable outputs, not one, appearing with roughly equal frequency. The
module's own determinism guarantee (`createProjectSchemaGenerator`'s cache)
still covers only the cache path — a cache hit replays a stored answer
byte-for-byte — and that remains a completely different guarantee from
"ask Gemini the same thing twice and get the same answer," which this
measurement shows holds only about half the time, for one prompt tested.
A caching or routing strategy that assumes "the same prompt always
produces the same schema" should assume instead: on a fresh call, expect
one of a small number of stable variants, not a single canonical answer.

## 4. Free-tier daily quota is a real planning constraint

The Gemini free tier's daily request cap
(`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) was hit mid-session and
blocked a planned diagnostic run outright — not a slowdown, a hard stop.
Sequence recorded in `scratch-pipe-schema-to-compiler-log.jsonl`:

- Entries 0–1: two successful calls (§3's "stable" pair).
- Entry 2 (`18:38:56.573Z`): the next call, same prompt, failed —
  `daily free-tier quota exhausted (GenerateRequestsPerDayPerProjectPerModel-FreeTier).
  This resets at midnight Pacific; retrying now cannot help.`
- Entries 3–8: a separately planned sweep of six varied prompts, run
  immediately after, all failed with the identical quota-exhausted message.

Anyone scheduling live-call work against Gemini in a single session should
plan around this as a hard daily ceiling, not a rate limit that can be waited
out within the session — the message itself states retrying will not help
until the reset.

## 5. Comparison: Gemini vs. the local checkpoint (2026-08-31)

Two desktop sessions ran the real `scripts/generate-project-schema.mjs --local`
pipeline (baseline checkpoint `run_20260822_130636`, Qwen2.5-7B-Instruct +
LoRA) against held-out and in-distribution prompts, using the same
`validateProjectSchema` gate and the same `fillFixedConstraintFields`/
`componentId()` post-processing this file's §1-§2 fixes already put in
place for Gemini. This section is that comparison, not a new pipeline.

| Failure category | Gemini | Local (Qwen2.5-7B + LoRA, run_20260822_130636) |
|---|---|---|
| Schema-shape rejection | 4 distinct incompatibilities found | N/A — no structured-output enforcement at all |
| Fixed-field echo reliability | Unreliable (confirmed, fixed via post-processing) | Never observed — 5/5 real generations (2 sessions, including a verbatim training prompt) returned constraints: [], so fillFixedConstraintFields/fillResolvedSubjectFixedFields have never actually run on local output |
| Component id correctness | componentId() recomputation fixes it | Confirmed fixed — 3/5 raw ids were degenerate repeated-digit strings, recomputation corrected all 5, independently re-verified |
| sessionId | Clean, prompt-derived | Confirmed broken — memorized training ids (session-gold-021, session-gold-031) on 5/5 calls, uncaught by validateProjectSchema, fix proposed but not yet applied |
| Constraint generation itself | Reliable — every successful call produced real constraint content | Confirmed unreliable — 5/5 calls including a verbatim training example produced zero constraints; root cause undetermined (request/schema artifact vs genuine model limitation) |
| Cross-call determinism | Not guaranteed, sometimes stable | Confirmed stable under greedy decoding, but only tested on empty-constraint output — determinism on real constraint content has never been observable |
| Per-request latency (clean GPU) | 3-16s (network + generation) | 10.7-22.5s, no network component; degrades toward 20-27s under GPU contention; server has no concurrency handling — one request at a time |

**Gemini is the safer default right now, unambiguously.** The table has
exactly one row that determines this: constraint generation itself.
Everything downstream of a `ProjectSchema` — the constraint compiler this
project's next candidate step is meant to build — exists to consume
constraint content. Gemini produces it reliably, on every successful call.
The local checkpoint has produced it on **zero** of five real generations
across two sessions, including a verbatim training example that its own
training target says should have produced one. A provider that cannot be
trusted to emit the one field the rest of the system is built around is
not a fallback candidate yet, regardless of how well its other problems
(ids, sessionId, latency) are understood or fixed.

**Not all of local's problems sit at the same layer, and that distinction
matters for what "fixed" would even mean here.** Component-id correctness
and sessionId both fit the existing fix pattern exactly — a post-processing
override or recomputation applied after parsing, the same shape as every
Gemini fix in §1-§2. Empty constraint generation does not: post-processing
can only correct or replace *fields on a constraint object that already
exists*. It has no way to produce a constraint that the model never emitted
in the first place. That puts this problem at a different layer entirely —
either how the request is constructed (schema complexity, prompt framing,
`effort` setting — the same category of problem §1's schema-dialect
incompatibilities and §2's `via`-omission turned out to be for Gemini) or a
genuine capability gap in what this specific checkpoint learned to produce.
Nothing run so far distinguishes between those two, and the existing
fix-via-post-processing pattern cannot resolve either one — it can only
paper over field-level noise on output that already exists.

**Before the local provider could be a real fallback and not just a
research artifact:** the root cause of empty constraint generation needs
isolating — at minimum, testing whether a simplified request (a smaller
constraint sub-schema, or no schema constraint on the model call at all,
mirroring how §1's fixes worked by removing complexity rather than adding
retries) changes the outcome, which would point at request construction;
if it doesn't, that points at the checkpoint's own training and would mean
revisiting the training data or hyperparameters rather than the pipeline
code. Only once at least one real constraint-bearing generation exists
from this checkpoint do the still-untested questions — field-override
reliability, the via null-fallback, and determinism on actual constraint
content, none of which any run to date has been able to observe — become
answerable at all.
