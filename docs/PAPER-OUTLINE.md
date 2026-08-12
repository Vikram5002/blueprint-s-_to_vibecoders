# Paper outline

Empirical work is complete: two corpora, both halves of the data model
measured. This maps the evidence onto a paper structure and — more usefully —
separates what can be cited as it stands from what needs a caveat attached
every time it appears.

Companion to `docs/FINDINGS.md`, which holds the findings themselves and the
raw-data pointers. Nothing here introduces a number that is not already there.

---

## The thesis, in one sentence

Developers state architectural intent in prose far more often than in any form
a tool can check, and the small fraction that *is* checkable is already
enforced — so the gap between stated and actual architecture lives precisely
where no existing tool can see it.

Everything below either supports that, qualifies it, or marks where it is
unsupported.

---

## Section structure

### 1. Introduction

The problem: AI-assisted development produces code faster than architectural
review can keep up with, and the architecture a project *claims* drifts from
the one it *has*. Existing tooling checks either structure (dependency
linters) or prose (nothing), never the correspondence between them.

**Claim:** the correspondence is checkable, and measuring it reveals that the
checkable portion is small and already handled.

### 2. Approach

The DERIVED / STATED split, and the three rules that hold it apart: every node
and edge carries provenance; every edge carries file-and-line evidence; a
constraint never becomes an edge. The four relations (`must-not-import`,
`may-only-import-via`, `must-not-cycle`, `must-be-layer-above`) and the
deliberate decision to keep the schema narrow and *count* what falls outside it.

**Supported by:** the architecture itself, and `src/architecture.test.ts`,
which enforces the rules statically rather than by review.

### 3. Deriving the architecture

Parsing, resolution, clustering, determinism.

**Citable as-is:**

| Claim | Number | Source |
|---|---|---|
| Import resolution rate | 99.3–99.7% across three reference repositories | Week 3 acceptance |
| Every unresolved import inspected, none a resolver defect | 4 / 1 / 28 unresolved, all non-source or build artefacts | Week 3 |
| Clustering determinism | adjacent-commit ARI **1.000** across 25 consecutive steps | Week 9 stability re-check |
| Performance | 6,976 files in **39.3s** (target: 5,000 in 60s) | Week 9, measured not extrapolated |

The last one carries a methodological note worth including: two earlier clones
silently lost ~10,000 files to Windows path limits, and the number was nearly
recorded against a two-thirds-empty repository. That is Finding 5, and it
belongs in the paper as a measurement-hygiene point, not a footnote.

### 4. Extracting stated intent

Prose → constraints. Precision over recall, subject resolution, and the
uncheckable count as a first-class output rather than a discard.

**This is where Finding 1 lands**, and it is the paper's central number.

### 5. Checking conformance

The four detectors, the severity model, and `check_import` as the
before-the-fact form of the same question.

### 6. Results

Two corpora, in this order, because the second answers the question the first
raises.

- **Corpus A** — 25 repositories pre-screened for agent files (`AGENTS.md` /
  `CLAUDE.md`). What developers state in prose.
- **Corpus B** — 5 repositories shipping enforced machine-checkable configs
  (dependency-cruiser, import-linter). What developers state formally.

### 7. Discussion

The pincer: rules are checkable only where they are already enforced;
violations are findable only where they are not. Findings 6 and 7.

### 8. Threats to validity

Section 9 below, promoted into the paper.

### 9. Conclusion and future work

---

## Which finding supports which claim

| Finding | Claim it supports | Section |
|---|---|---|
| **1** — prose describes ~20× more than it constrains | The checkable fraction of stated intent is small. The paper's central claim. | 4, 6 |
| **2** — the unmeasured-zero family | A conformance tool's failure mode is reporting "clean" when it means "unmeasured". Methodological, and it recurs four times. | 2, 8 |
| **3** — provider-dependence | Results that depend on one model provider are not results. Justifies the provider-agnostic interface. | 8 |
| **4** — zod circular-import reproduced blind | External validity: the derived graph matches ground truth authored by someone who had never heard of the tool. The strongest single piece of evidence. | 3, 6 |
| **5** — partial artifacts produce confident wrong numbers | Measurement hygiene; twice produced a wrong number that favoured the argument. | 3, 8 |
| **6** — machine-checkable configs are rare and already respected | The other half of the pincer. Explains the zero-violation result rather than excusing it. | 6, 7 |
| **7** — evidence completeness ≠ evidence correctness | A tool that checks stated intent can misread the intent it checks. Directly on-thesis. | 5, 7, 8 |

---

## Citable as-is

These need no hedging beyond naming the measurement.

- **Resolution rate 99.3–99.7%** on zod, requests, pyright. Every exception
  individually inspected.
- **Adjacent-commit ARI 1.000 across 25 steps.** Clustering is stable enough
  that a drift chart built from consecutive commits measures drift, not noise.
- **6,976 files in 39.3s.** Direct measurement.
- **zod's circular-import fix, reproduced blind.** `iso.ts` imports
  `schemas.ts` through **2** statements; `schemas.ts → iso.ts` absent —
  matching the maintainer's own commit message. **0 of 724 edges lacked
  evidence.**
- **Corpus A totals:** 25 repositories, **84 documents**, **1** checkable
  constraint, **204** architectural-but-uncheckable statements, **0**
  documents truncated.
- **Corpus B discovery:** **5 of 211** candidate repositories (2.4%) ship a
  root-level machine-checkable config. *(Lower bound — see caveats.)*
- **Corpus B binding:** **1,282 of 1,289** constraints checked after the regex
  resolver; regex-sourced roles resolve at **99.9%** (2,564/2,566).
- **Corpus B violations:** **0**, after hand-verifying and eliminating six
  candidates.
- **Finding 7's six false positives.** The narrative is exact and every claim
  in it was verified against the original config and source.

---

## Needs a caveat, every time

### Finding 1's ratio — cite the range, never the point

**Never write "61 uncheckable statements".** Two identical runs on the same 31
documents, same model, temperature 0, produced **61** and **76** — a 25% swing
— while the checkable count held at 3 both times.

> Correct form: *"roughly 20:1, observed at 61:3 and 76:3 across two runs."*

Two runs is not a distribution. If the paper needs an interval rather than a
range, more runs are required, and that is measurement work that has not been
done. The *direction* and *order of magnitude* are robust across both runs and
independently corroborated by corpus A's 204:1 at 25-repository scale — cite
corpus A when a stable number is needed, and Finding 1's range when the
document-level ratio is the point.

### Anything routed through the Bluesminds gateway — unattributable

A gateway result **cannot be attributed to a specific model version**. All 137
catalogue entries report `owned_by: "openai"` including `meta/*` and
`nvidia/*`; response headers reveal NVIDIA Cloud Functions upstream; four
catalogue models were end-of-life and refused requests.

- **Do not cite any gateway-derived number as a property of a named model.**
- The label-quality comparison (Gemini 100% distinct vs Bluesminds 89.5%,
  4 domain-aware vs 0) is citable **as a comparison of two configurations we
  ran**, not as a claim about `llama-3.3-70b` versus `gemini-3.5-flash-lite`.
- No corpus result depends on this: Bluesminds was reverted before collection,
  and both corpora ran on Gemini direct.

### Extraction precision/recall — n=4 denominator

Precision **100%**, recall **75%** — but recall is **3 of 4**, on a gold set
where only one document of 31 contained any checkable constraint.

- Always give the denominator inline: *"75% (3 of 4)"*. A bare "75% recall"
  overstates the evidence by a wide margin.
- One additional miss would move it to 50%. The figure is nearly
  uninformative on its own and should be presented as *consistent with* the
  precision-over-recall design choice rather than as a measurement of it.
- Fixing this needs 15–20 documents that actually contain checkable
  constraints. Corpus A found 1 in 84 documents, which is itself the reason
  the denominator is small — the scarcity being measured is the same scarcity
  that prevents measuring it precisely.

### Corpus B's rule-mapping coverage — two numbers, state which

- **57% (28/49)** across hand-written configs.
- **97.7%** including `prisma/prisma`, whose config is *generated* and emits
  1,282 pairwise rules.

The second measures one repository's code generator, not how architecture
rules are written. Cite 57% for "how much of what these tools express is a
dependency rule between two named parts"; cite both when discussing corpus
totals. The per-tool split is more informative than either: **import-linter
100%, dependency-cruiser ~49%**.

### Corpus B's 5-of-211 — a lower bound, and say why

Three limits, all of which push the true number up:

1. **No GitHub code search** (needs a token this project does not have), so
   candidates were hand-assembled and only *verified* by HTTP fetch.
2. **Root-level check only.** Configs nested in monorepo packages — common for
   both tools — are missed.
3. **ArchUnit excluded** entirely, because it is Java and this tool parses only
   TS/JS/Python.

Cite as *"at least 5 of 211 candidates"*, and present the scarcity claim as
directional rather than as a prevalence estimate.

### Corpus results carry mechanical labels

Corpus runs had model labelling **off** (99.4% of the call budget, for a study
that measures constraints). Labels are cosmetic to clustering but *not* to
subject resolution — `resolve-subject.ts` tokenises them.

The exposure is bounded and quantified: across corpus A, **1** role resolved
via `MODULE` and **1** was `UNRESOLVED`. Any paper claim about resolution rates
should note the labelling configuration. This does **not** touch Finding 1,
whose classification happens inside the extractor before any subject meets any
module.

---

## What remains genuinely unmeasured

Stated plainly, because a reviewer will find these anyway and it is better to
name them first.

### 1. Detector precision and recall on real breaches

**The largest gap.** No true-positive violation from the wild has ever been
observed.

- False-positive rate is known only from Finding 7's six candidates — all
  false, all traced to *transcription*, none to the detector itself. The
  detector's own error rate is therefore unmeasured, not zero.
- False-negative rate is entirely unknown.
- The obstacle is structural, not effort: violations are measurable only where
  rules are stated but unenforced, and rules are checkable only where they are
  enforced. Corpus A is the first population and has almost nothing checkable;
  corpus B is the second and has no violations.

Any claim of the form "the tool detects architectural drift" is currently
**unsupported for real drift** and supported only for injected and constructed
breaches.

### 2. Whether mechanical labelling cost any constraint

Bounded but not closed. The falsifier is an `UNRESOLVED` role in a repository
that produced constraints; `BuilderIO/qwik` has exactly one. Resolving it means
re-running that one repository with labelling on (~91 calls) and diffing the
resolved set. Not done.

### 3. Haiku/Sonnet label comparison

Open since Week 5. Never run — no `ANTHROPIC_API_KEY`. The default-model choice
is therefore justified by Gemini-versus-Gemini comparisons and by the
Bluesminds comparison, never by an Anthropic baseline.

### 4. Uncheckable-count variance

Two runs, 61 and 76. No interval. Needs several more runs to characterise, and
until then the range is the honest report.

### 5. Longitudinal drift

Drift is computed and charted, and the machinery is validated against zod's
circular-import fix — but **no repository has been followed over time with the
tool to observe drift accumulating**. Every drift number is retrospective, from
snapshotting history, not from observation.

### 6. Whether developers would act on the output

No user study. Claims about the tool being *useful* — that a wrong-but-close
diagram is worth arguing with, that `check_import` changes what an agent
writes — are design rationale, not findings, and should be labelled as such.

---

## One structural suggestion

The strongest available narrative is not "we built a tool that finds
architectural drift" — the evidence does not support that claim yet. It is:

> **We built the tool, measured what it could check, and found that the
> checkable portion of stated architecture is small and already enforced —
> while the large uncheckable remainder is exactly where drift is free to
> happen and where no tool can currently look.**

That is supported end to end by Findings 1, 6 and 7, it is a genuinely useful
negative result, and it survives the caveats above intact. It also positions
the uncheckable-statement counter — currently a diagnostic — as the paper's
main measuring instrument, which is what the data says it is.
