# Findings

The paper's evidence index. Every numbered finding, deferred item, and hard
limitation this project has produced, consolidated from `INTENT.md`,
`DRIFT.md`, `PROVIDERS.md`, `CLUSTERING.md`, `LABELLING.md`, `VIOLATIONS.md`
and `MCP.md`, with its measurement, its caveats, and a pointer to the raw
data. Written so a reader — or a paper draft — can cite this file instead of
re-deriving each result from six documents.

**This file summarises; it does not re-measure.** Every number here was
measured in the source document named beside it. If this file and its source
ever disagree, the source is correct and this file is stale — fix this file,
not the claim.

---

## Finding 1 — Documentation describes architecture roughly 20× more often than it constrains it

**Measurement:** across 31 real documents from four projects (blueprint,
requests, zod, pyright), intent extraction returned architectural statements
that split as:

| | First run | Re-run (cleared cache) |
|---|---|---|
| Checkable against an import graph | 3 | 3 |
| Architectural but not checkable | **61** | **76** |
| Rejected by validation | 2 | 7 |

Ratio roughly **20:1** uncheckable-to-checkable, both times.

**Caveat — quote the range, not the point.** Identical inputs, identical
model, identical prompt, temperature 0, and the uncheckable count moved from
61 to 76 — a 25% swing — while the ratio held at ~20:1. **Report this as
"roughly 20:1, observed at 61:3 and 76:3 across two runs"**, never as a bare
61. Two runs is not a distribution; establishing a real interval needs
several more runs before the number is published as more precise than that.
The stable parts — precision, recall, the checkable-constraint count, and the
order of magnitude — are safe to build on. The exact uncheckable figure is
not.

**Why it matters:** it bounds what any import-graph conformance tool can
ever check (most architectural intent isn't expressed as a dependency rule),
and it makes a bare violation rate misleading — a repository that made 64
claims and is measured against 3 can report "100% conformant" while ignoring
95% of what it said about itself. The honest headline is coverage, not
compliance.

**Raw data:** `docs/INTENT.md` → "Numbered findings" (§Finding 1) and
"Re-run after the truncation fix: what held and what did not".

---

## Finding 2 — The unmeasured-zero family

One failure class, three separate instances, found in three different
subsystems by three different people running the tool for real rather than
by any test passing. The shape is always the same: **a zero produced because
nothing was read is indistinguishable from a zero produced because nothing
is there, unless something insists on telling them apart.**

| # | Where | What a zero meant | Fixed by |
|---|---|---|---|
| 1 | Intent extraction (Week 10) | A document that states 3 constraints reported 0, because it silently truncated at the token limit. | Explicit truncation detection; a truncated document is now excluded from scoring rather than counted as stating nothing. |
| 2 | Drift history (Week 9→10) | Every historical snapshot showed drift score 0.0 — indistinguishable from "this repository never breaks its own rules" — because `snapshotHistory` passed `constraints: []` to every historical conformance check. The chart was **structurally incapable of moving, on any repository, forever.** | `snapshotHistory` now checks the current run's real constraints against every historical graph. |
| 3 | `check_import` (Week 11) | With the Gemini daily quota exhausted, `CLAUDE.md` was never read, and `check_import('parser/', 'llm/')` answered **allowed** — "no stated rule applies to it" — against a document that forbids exactly that import in capital letters as rule one. | `check_import` now takes the extraction's health and downgrades to `cannot-determine`; `buildIntentResponse` gained an `extraction-failed` reason instead of reporting "read, and nothing was stated" about a document it had failed to read. |

**#3 is the most severe of the three, and deliberately ranked first in
practice** (see `check_import`'s verdict precedence in `docs/MCP.md`): #1 and
#2 corrupt a number in a report, which a careful reader might catch by
cross-checking. #3 is the answer an *agent acts on before a line of code is
written* — there is no downstream chance to catch it. An agent that asked
"can I import this?" and was told "yes" had no way to know the real answer
was "we don't know, we couldn't read the rule."

**Caveat:** none of the three was found by a test. All three were found by
driving the tool against real input under real failure conditions (a dense
document, a repository with real history, a quota-exhausted client). This is
itself evidence for keeping "run it for real" in the acceptance process
rather than trusting unit coverage alone.

**Raw data:** `docs/INTENT.md` → "Re-run after the truncation fix"; `docs/DRIFT.md`
→ "The chart could not move (fixed)"; `docs/MCP.md` → "An unread document is
not an absent rule".

---

## Finding 3 — The provider-dependence lesson: a bug invisible on Gemini alone

**Measurement:** the Anthropic adapter (`src/llm/anthropic.ts`) did not
originally check `stop_reason === 'max_tokens'`. A response cut off at the
output token limit came back as `ok: true` carrying partial JSON, which then
failed to parse and produced an empty result — a fourth, unrecorded instance
of the Finding 2 family, and the most dangerous kind: **it was live on the
Anthropic code path for as long as that path existed, and would never have
shown up in any count taken on Gemini alone**, because the Gemini adapter
handled truncation correctly from the start (`src/llm/gemini.ts`, `kind:
'incomplete'`).

Fixed in commit `6757998` — *"fix(llm): give truncation its own failure
kind, so it can never read as zero"* — by giving the Anthropic adapter the
same explicit `{ kind: 'incomplete' }` failure path Gemini already had.

**Why it matters, beyond the fix itself:** every provider-comparability
argument in this project (Finding 1's ratio, the Haiku/Sonnet projections in
`docs/LABELLING.md`) implicitly assumes the adapters fail the same way when
they fail at all. This bug is a concrete case where they didn't, silently,
until someone read the Anthropic code path specifically. A single-provider
measurement campaign — which is what Gemini-only corpus collection is —
cannot detect this class of bug by construction; it can only be caught by
code review or by running the same input through a second provider and
comparing failure modes, not just successes.

**Caveat:** this bug was never triggered in production, because
`ANTHROPIC_API_KEY` has not been available in this environment for any real
run (the Haiku/Sonnet comparison remains unrun as of this writing — see
Limitations). It was found by reading the code, not by an observed bad
number. That is a weaker discovery mode than Finding 2's three instances,
each of which was caught by a real symptom, and it should be described that
way: a latent bug caught by review, not a measured incident.

**Raw data:** `src/llm/anthropic.ts` lines ~121–139 (the fix and its comment);
git commit `6757998`.

---

## Finding 4 — Independent validation: zod's own circular-import fix, reproduced blind

**Measurement:** zod's real commit `fix(v4): break circular import between
classic schemas and iso (#5275)` (`fbe8ad1` → `dfd8766`), diffed by this
project's own drift/diff machinery with no knowledge of the commit message:

```
fbe8ad1 -> dfd8766   8 entries
  [edge-removed]        packages/zod/src/v4/classic/schemas.ts no longer imports
                        packages/zod/src/v4/classic/iso.ts.
  [edge-weight-changed] packages/zod/src/v4/classic/iso.ts imports schemas.ts through
                        2 statement(s), more than the 1 before.
```

Independently reproduced via the MCP server too (`docs/MCP.md` → "zod (407
files, 724 edges, 19 modules)"): `schemas.ts no longer imports iso.ts`
(absent, as claimed) and `iso.ts imports schemas.ts through 2 statements`
(present, count 2, as claimed) — matched on both counts.

**Why it matters, and why it outranks the synthetic tests:** every other
piece of violation-detection evidence in this project (the injected-breach
repo, the hand-built module fixtures) is constructed by the same person who
wrote the detector, so it can only confirm the code does what its author
intended. This one is ground truth written by a zod maintainer who had never
heard of this tool, describing the change in their own words in a commit
message. The tool's independent report — the cycle broken in one direction,
the surviving dependency strengthening in the other — matches that
description exactly, without having read it.

**Caveat — still an open item, not yet done, as of Week 12.** The terminal
output has not been captured verbatim into a named "Real-world validation"
section, and the commit shas are not pinned to a re-runnable script. It
currently exists split across the verification section of `docs/DRIFT.md`
and the zod QA section of `docs/MCP.md`. See `docs/DRIFT.md` → "Deferred
items" → item 1.

**Raw data:** `docs/DRIFT.md` → "A commit that did change the architecture";
`docs/MCP.md` → "zod (407 files, 724 edges, 19 modules)".

---

## Limitations

Stated plainly, because a findings index that only lists successes is not
credible.

### No real violation has ever been observed

Measured across all four reference repositories (`docs/VIOLATIONS.md` →
"Measured on all four repositories"):

| Repo | Constraints | Checked | Satisfied | Violations |
|---|---|---|---|---|
| blueprint | 3 | 3 | 3 | **0** |
| requests | 0 | 0 | 0 | **0** |
| zod | 0 | 0 | 0 | **0** |
| pyright | 0 | 0 | 0 | **0** |

Every violation this project has ever demonstrated — the injected breach in
its own copy, the constructed breach repository in `docs/MCP.md` — was
manufactured for the purpose. Three of the four real repositories state zero
constraints expressible in the four checkable relations at all (Finding 1
again, from the supply side); the fourth (blueprint) states three and
satisfies all three. **The violation detector's precision and recall on real
architectural breaches remain unmeasured**, because no real architectural
breach matching a stated, checkable rule has yet been found in the wild to
measure against. This is the single largest open evidence gap in the
project.

### Small-repo clustering granularity widens rules to everything

Found by acceptance testing, not by a unit test (`docs/MCP.md` → "A
systematic false positive"): rules written about a directory resolve as
`PATH_PATTERN`, narrower than the module the directory's files land in. On a
repository small enough that clustering produces a single module,
comparing endpoints at module granularity silently widens every path-pattern
rule to match *everything* — `check_import` reported every import as
forbidden, including one its own `AGENTS.md` explicitly permitted. Fixed by
comparing path-pattern rules against files, not modules. The underlying
constraint remains: **conformance checking is only as precise as the
clustering it runs on top of, and clustering degrades predictably on small
repositories** (few files → few or one cluster → coarse granularity). No
repository below a certain size has a lower bound established for how small
is too small.

### Corpus results carry mechanical labels, not model labels

**Methodology note for the corpus (from 2026-08-12).**

Corpus collection runs with labelling **off** and intent extraction **on**
(`mechanicalLabels: true`). Every module in a corpus result is named by its
shared path prefix, not by a model.

**Why.** Measured across the first ten corpus repositories, before any quota
was spent: **4,896 of 4,925 model calls (99.4%) were labelling**, one per
module, against **29 for documents**. `denoland/deno` alone is 2,433 modules.
At the measured free-tier ceiling of roughly 60 calls a day, labelling the
25-repository corpus projected to about **205 days**; the documents alone come
to about **1.2 days**. The study measures constraints, violations and drift.
None of those is a name.

**What this does not affect.** Clustering, module identity, edges, evidence,
violation detection and drift are all untouched — module ids are content-derived
and nothing downstream keys off a label. Week 5 pins that, and
`label.test.ts` asserts the clustering is byte-identical with labelling on and
off.

**What it could affect, stated honestly.** Labels are *not* inert everywhere.
`conformance/resolve-subject.ts` tokenises a module's label when scoring a
prose phrase against a module, and `pipeline/intent.ts` feeds it the model
label when one exists. So mechanical labelling can in principle change which
constraints resolve, and therefore which are checked.

**Why it is expected not to, and how that is checked.** Subject resolution has
two paths: a phrase can match a module by *name* (`MODULE`) or by *path*
(`PATH_PATTERN`). Every constraint role resolved so far took the path route:

| Source | Roles resolved | via `MODULE` | via `PATH_PATTERN` |
|---|---:|---:|---:|
| blueprint's own `CLAUDE.md` | 3 | 0 | 3 |
| constructed breach repository | 6 | 0 | 6 |
| **total** | **9** | **0** | **9** |

Path matching uses a module's *directories*, which mechanical labelling does
not change — and the mechanical label **is** the shared path prefix, so the
directory-shaped phrases that real documents use ("`src/parser/` must not
import `src/llm/`") still match. What is lost is matching a phrase against a
semantic name a model invented, and nothing observed has needed that.

**This is n=9 across two repositories, which is not proof.** The corpus records
the `MODULE`/`PATH_PATTERN` split per repository, so the assumption is
falsifiable by the corpus itself: **any corpus repository that resolves a role
via `MODULE` is evidence that mechanical labelling cost a constraint**, and the
fix is to re-run that repository — a handful of documents, not a day of quota —
with labelling on and diff the resolved set. If the corpus reports zero `MODULE`
resolutions across 25 repositories, the assumption is confirmed at n≈25 rather
than assumed.

**Finding 1 is unaffected either way.** Its ratio counts *statements returned
by extraction* — checkable constraints against architectural-but-uncheckable
ones — and that classification happens inside the extractor, before any subject
is resolved against any module. Labels enter afterwards, when a resolved
constraint is matched to the graph. A statement counted as uncheckable is
counted there whether the module it might have referred to is called
`Validation Framework` or `packages/zod/src/`.

### Repositories with no documents are skipped, not counted as zero

A repository with no README, AGENTS.md, CLAUDE.md or ADR has nothing for
extraction to read, so it cannot produce a constraint however much quota it is
given. These are checkpointed as `skipped-no-documents` with their module count
and are **excluded from the corpus denominator**.

`rollup/rollup` is the case that forced this: 1,219 modules and **zero**
documents. Under the previous design it would have spent roughly twenty days of
quota to arrive at a guaranteed zero.

Folding these into "analysed, no constraints found" would be the
unmeasured-zero mistake of Finding 2 in a new place — "nothing was stated" and
"there was nothing to read" are different claims, and only the first is a
finding about how developers document architecture.

### Gateway-routed requests cannot be attributed to a specific model version

(`docs/PROVIDERS.md` → "Provenance: what a gateway result can and cannot
support".) Bluesminds is a third-party OpenAI-compatible gateway; a model
string is sent and an answer is received, but which weights, quantisation,
or serving stack actually produced it is not observable from the client
side, and a silently substituted fallback would look identical to the
requested model succeeding. This is why Bluesminds is a documented fallback
and never the source of a number the paper depends on, and why the
Haiku/Sonnet provider comparison is specified to run direct against
Anthropic rather than through any gateway. It is also why Finding 3 could
only be found by reading code: a gateway would have made the two providers'
failure modes even harder to tell apart than they already were.

---

## Where each finding's raw data lives

| Finding | Primary source | Supporting |
|---|---|---|
| 1 — 20:1 ratio | `docs/INTENT.md` §"Numbered findings" | `docs/PROVIDERS.md` §3 (why extraction must stay on one provider) |
| 2 — unmeasured-zero family | `docs/INTENT.md`, `docs/DRIFT.md`, `docs/MCP.md` | `docs/PHASE-1-SPEC.md` Week 11 entry |
| 3 — provider-dependence (Anthropic truncation) | `src/llm/anthropic.ts` (commit `6757998`) | `src/llm/gemini.ts` (the pattern it should have matched from the start) |
| 4 — zod circular-import validation | `docs/DRIFT.md` §"A commit that did change the architecture" | `docs/MCP.md` §"zod (407 files, 724 edges, 19 modules)" |
| Limitation — no real violation observed | `docs/VIOLATIONS.md` §"Measured on all four repositories" | — |
| Limitation — small-repo granularity | `docs/MCP.md` §"A systematic false positive" | — |
| Limitation — gateway provenance | `docs/PROVIDERS.md` §"Provenance" | — |
