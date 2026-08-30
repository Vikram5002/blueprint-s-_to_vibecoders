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

## 3. Determinism across separate calls: not guaranteed, uncharacterised

Two directly contradicting observations, both from real live calls on the
same day:

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

**Conclusion**: unstable-but-sometimes-stable, uncharacterised. Both
observations are true, from different points on the same underlying
non-deterministic process — temperature 0 does not guarantee identical
output across separate network calls for this generator. The module's own
determinism guarantee (`createProjectSchemaGenerator`'s cache) covers only
the cache path — a cache hit replays a stored answer byte-for-byte. It says
nothing about, and does not make true, "ask Gemini the same thing twice and
get the same answer" — that path has not been made deterministic and, per
the above, is not naturally deterministic either.

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
