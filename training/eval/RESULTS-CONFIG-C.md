# Held-out generalization eval — Config C vs baseline

Compares the baseline run (`run_20260822_130636`, results in
[`RESULTS.md`](./RESULTS.md)) against Config C
(`run_20260824_150823`, `label: configC-epochs5`), same 10 held-out
prompts, same real compiled `validateProjectSchema`. This document is a
delta on top of `RESULTS.md` — read that first for the baseline's full
per-output analysis, the fake-hash-id root cause, and the sessionId
finding; this file doesn't repeat that background, only what's different.

**Scoping honesty note before anything else:** Config C's training summary
records `r=16, lora_alpha=16, learning_rate=0.0002, epochs=5`. The
baseline's `summary.json` never recorded LoRA hyperparameters at all —
only `rows`, `epochs`, `elapsed_seconds`, `final_loss`, `peak_vram_gb`. So
the only difference between the two runs I can *confirm* is epoch count
(3 → 5); I cannot rule out that `r`/`alpha`/learning rate also changed,
since baseline's record of them doesn't exist. Everything below is framed
as "what changed between these two specific runs," not "what more epochs
alone does" — that stronger claim isn't supported by the data available.

| | Baseline | Config C |
|---|---|---|
| Epochs | 3 | 5 |
| Final training loss | 0.90 | 0.74 |
| Peak VRAM | 8.69 GB | 7.78 GB |
| Held-out pass count | 8/10 | 8/10 |

## 1. Pass count: identical raw number, different examples

**Both 8/10 — but not the same 8.** Church-scheduling and business-directory
(baseline's two failures) now **pass** under Config C. Journaling and the
whistleblower-portal (both passing under baseline — whistleblower was
baseline's *best* example) now **fail** under Config C. The raw count
alone would suggest "no change." It hides the actual result.

## 2. Config C's failures — exact violations

**Journaling app** (1 violation):
```
$.domains.database.components[0].id: duplicate-component-id
```
Same fake-hash-id collision pattern as baseline's failures — `id`
`"1234567890abcdef"` reused between "Trend View" (frontend) and "entries
table" (database). Nothing new here; see `RESULTS.md`'s root-cause section.

**Whistleblower portal** (3 violations, a different error shape entirely):
```
$.domains.security.components: missing-or-wrong-type
$.domains.security.dependsOn: missing-or-wrong-type
$.constraints: missing-or-wrong-type
```
This is structurally more interesting than a collision. Instead of a plain
`security` component (what baseline produced — a component named
"No-Identifying-Data Guard" with descriptive purpose text), Config C tried
to express the prompt's rule as an actual `Constraint` object — and got
most of the real `Constraint` shape right: `id`, `relation`, `subject`
(with `phrase`/`status`/`target`/`origin`/`reason`/`similarity`/
`alternatives`), `object` (same sub-shape), `via`, `source`
(`type`/`location`/`line`/`timestamp`), `confidence`, `lowConfidence`,
`rawText`, `provenance` — nearly every field of a real `Constraint` is
present and correctly typed. But it invented a relation that doesn't
exist (`"must-not-store"` — the real four are `must-not-import`,
`may-only-import-via`, `must-not-cycle`, `must-be-layer-above`), and
placed the whole thing **nested inside `security`'s `DomainSpec`**
(replacing the required `components`/`dependsOn` keys) instead of at the
schema's top-level `$.constraints` array, which is why that array is
reported missing too.

Read charitably, this is the model attempting something *more* ambitious
than baseline's answer — modeling the prompt's rule as a proper constraint
rather than descriptive component text — and getting the placement wrong.
Read less charitably, reproducing nearly every field of `Constraint`'s
shape (which appears in most training pairs, including many outside this
specific whistleblower-style prompt) while getting the schema's top-level
structure wrong is consistent with pattern-matching a memorized
substructure rather than composing a full schema from first principles.
Both readings are plausible from this one example; this document isn't
picking one, and neither should stronger conclusions be drawn from it
alone.

## 3. Spot-check on Config C's passing outputs

**Offline notes app — a real content regression, not just a different id.**
Baseline correctly left `backend`, `database`, and `security` **all empty**
for this prompt, recognizing "no server or account at all... sync only by
manually exporting and importing a file" as ruling those domains out
entirely (see `RESULTS.md` — this was one of baseline's two standout
examples). **Config C invents a backend component** ("Sync Service...
handles manual file-based sync between the user's own devices") and a
database component ("notes table"), directly contradicting the prompt's
explicit "no server... manually exporting and importing a file" statement.
This passes structural validation — it's a well-formed schema — but it's
a **worse answer** than baseline's for the exact prompt this eval uses to
test whether the model avoids over-populating domains it shouldn't. This
is the single clearest piece of evidence in this comparison, and it's not
ambiguous: the higher-epoch run got this specific prompt more wrong, not
less.

**Church scheduling — passes, but with a repetition artifact.** The
content is reasonable (RSVPs, shifts, reminder emails, role-based login,
an email-reminder guard) and this time the ids don't collide. But the
phrase "shows/tells" appears **three times verbatim** across different
component purposes ("shows/tells for a single event", "Tracks RSVPS,
shifts, and shows/tells", "Stores event details, RSVPS, volunteer shifts,
and shows/tells") and doesn't mean anything in context — nothing in the
prompt mentions "shows" or "tells." Verbatim repetition of a meaningless
templated phrase across unrelated fields is a recognizable degradation
symptom in language models, often associated with overtraining reducing
output diversity. It doesn't fail validation (purpose is just a non-empty
string), but a human reading it notices immediately that something's off.

**Citizen science app — a genuine, reasonable elaboration.** Config C adds
a "Verification Service" backend component alongside the storage API,
separating "store a sighting" from "mark it verified/rejected" — a
sensible decomposition baseline didn't make. This one reads as an
improvement, not a regression, and is the strongest counter-evidence
against a blanket "Config C is worse" reading.

## 4. Does the fake-id / memorized-sessionId pattern persist?

**Fake-hash-ids: unchanged in kind, and in raw frequency.** Config C's
"passing" outputs still contain obviously-fake ids —
`"2222222222222222"`, `"8888888888888888"`, `"0000000000000001"`,
`"0000000000000002"`, `"0000000000000003"` — sequential or
repeated-digit strings, not real hashes, exactly like baseline's
`"7777777777777777"` and `"1234567890abcdef"`. Total duplicate-id
violations: baseline had 5 across 2 outputs (4 + 1); Config C had 1 across
1 output (the journaling failure) plus whatever near-misses exist in
passing outputs that happened not to collide. More epochs did not teach
the model to compute real hashes — it still can't, for the same structural
reason `RESULTS.md` explains (this requires running SHA-256, not
predicting tokens). If anything Config C collided *less* this round, but
with only 10 examples that's not enough to call a trend either way, and
the underlying mechanism (fabricated hex, not computed hashes) is
identical in both runs.

**Memorized `sessionId`: same core issue, wider variety of memorized
values.** Baseline always copied one of exactly two real training
sessionIds (`session-gold-021`, `session-gold-031`). Config C draws from
at least four: `session-gold-012` (5 of 10 outputs), `session-gold-021`,
`session-gold-015`, `session-real-012` — all genuine training sessionIds,
none newly derived from the actual held-out prompt. The pattern is
unchanged in kind (still copying, never generating) and if anything more
outputs now share the single value `session-gold-012` (5/10) than either
memorized value did in baseline (2/10 each) — mild evidence of *less*
variety in what gets copied, consistent with the repetition-artifact
observation above, not independent of it.

## Overall read

**Raw pass count says "no change." The content says something did.**
Config C's lower training loss (0.74 vs 0.90) did not translate into
better held-out behavior — it came with a clear content regression on the
one prompt in this set specifically designed to test "does the model
avoid over-populating domains it shouldn't" (offline notes app), a
verbatim-repetition artifact on another passing output, and a more
structurally broken (if arguably more ambitious) failure on the prompt
that was baseline's single best example of genuine generalization. The
one clear improvement (citizen science's sensible elaboration) doesn't
outweigh those three pieces of evidence pointing the same direction.

This is consistent with early overfitting from the additional epochs,
though with only 10 held-out prompts and an unconfirmed set of other
hyperparameter differences (see the scoping note above), it is evidence
toward that conclusion, not proof of it. The concrete, actionable
takeaway: **don't treat "config C's training loss is lower" as "config C
is the better checkpoint" without running this same held-out check** — on
this evidence, more epochs traded away exactly the kind of
prompt-specific correctness (recognizing when a domain should stay empty)
that `RESULTS.md` identified as the real positive signal from the first
run.
