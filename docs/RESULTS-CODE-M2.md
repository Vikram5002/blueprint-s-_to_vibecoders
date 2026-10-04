# Results - local code model, larger evaluation and round 2

**Date:** 2026-10-04 · **Follows:** `RESULTS-CODE-M1.md` · **Harness:** `scripts/eval-code-model.mjs` (unchanged)

Three things were added after round 1:

1. **Independent references.** Round 1's main caveat was that 23 of its 26 reference projects were
   built by the same Qwen2.5-Coder-32B teacher that wrote the training data. A second reference set
   was built from the same 47 gold plans by a model that wrote no training data,
   Qwen3-Coder-30B-A3B (4-bit AWQ, `training/code/modal_reference.py`): **23 of 47 passed every
   check** and are used below as "new refs".
2. **The Gemini baseline (A3)** on the original references, on the free daily quota.
3. **Round 2** of the code adapter, aimed at the measured weak spot (below).

Every candidate regenerates one component inside a reference project; A = first attempt passes
build + Blueprint + locator + runtime route check, B = the same after the normal repair rounds,
C = the candidate writes every backend/security component of the project. 95% Wilson intervals in
brackets; paired comparisons use the exact McNemar test on the same components.

## Backend + security

| | n | A first attempt | B after repair | C whole project |
|---|---|---|---|---|
| **Original references** | | | | |
| Plain Qwen2.5-Coder-7B | 46 | 41.3% [28-56] | 58.7% [44-72] | 28.0% |
| Round 1 adapter | 46 | 87.0% [74-94] | 87.0% [74-94] | 80.0% |
| Round 2 adapter | 46 | 80.4% [67-89] | 91.3% [80-97] | 68.0% |
| Gemini (gemini-3.5-flash) | 46 | **100%** [92-100] | **100%** [92-100] | **100%** |
| **Independent references** | | | | |
| Plain Qwen2.5-Coder-7B | 43 | 48.8% [35-63] | 62.8% [48-76] | 22.7% |
| Round 1 adapter | 43 | 79.1% [65-89] | 90.7% [78-96] | 68.2% |
| Round 2 adapter | 43 | 81.4% [67-90] | **95.3%** [85-99] | 68.2% |

## Frontend + database (route check D does not apply; C skipped)

| | n | A | B |
|---|---|---|---|
| **Original references (all components, round 1 had only the first 20)** | | | |
| Plain | 84 | 15.5% [9-25] | 42.9% [33-54] |
| Round 1 adapter | 84 | 57.1% [46-67] | 90.5% [82-95] |
| **Independent references** | | | |
| Plain | 73 | 21.9% [14-33] | 45.2% [34-57] |
| Round 1 adapter | 73 | 47.9% [37-59] | 89.0% [80-94] |
| Round 2 adapter | 73 | 49.3% [38-61] | 90.4% [82-95] |

## What the numbers say

- **The training effect holds on references the teacher never wrote.** Plain vs round 1 on the
  independent set: A 48.8% -> 79.1% (13 components fixed, 0 broken; McNemar p = 0.0002), B 62.8% ->
  90.7% (p = 0.0005). On all 84 original frontend/database components: A 15.5% -> 57.1% (37 vs 2,
  p < 1e-8), B 42.9% -> 90.5% (p < 1e-8). Round 1's caveat that the gain might be a teacher-style
  artefact is not supported.
- **The independent references are harder for everyone** at first attempt (round 1 A: 87.0% ->
  79.1% backend/security; 57.1% -> 47.9% frontend/database), so absolute numbers depend on who
  built the reference. Repair (B) closes most of that gap.
- **Round 2 vs round 1: no significant difference anywhere.** Paired tests: p = 0.51 and 0.73
  (original A and B), 1.0 and 0.63 (independent A and B), 1.0 and 1.0 (frontend/database). n = 43-73
  cannot separate effects of a few points.
- **Round 2 did what it was aimed at, in direction.** Invented-import failures (TS2305) at first
  attempt fell from 3 to 1 on each reference set. B is higher on both sets (91.3% vs 87.0%; 95.3%
  vs 90.7%), but A and C on the original references are lower (80.4% vs 87.0%; 68.0% vs 80.0%).
- **Gemini is ahead.** 100% on all 46 original-reference components and 25 projects.

## Ship bar (`GPU-COMPUTE-PROPOSAL.md` §6), against the Gemini baseline

| Criterion | Round 1 | Round 2 |
|---|---|---|
| D passes on every accepted component | Met | Met (D equals A) |
| A >= 15 points over plain | Met (+45.7) | Met (+39.1) |
| A >= 0.8 x Gemini (>= 80%) | **Met** (87.0%) | **Met, barely** (80.4%) |
| B within 10 points of Gemini (>= 90%) | **Not met** (87.0%) | **Met** (91.3%) |
| Plan adapter untouched | Met | Met |

Round 2 is the only adapter that meets all five, but by margins well inside the confidence
intervals, and it is worse than round 1 on whole-project C. **Recommendation:** keep round 1 as
the served default for whole-project generation; round 2 is a candidate for repair-heavy use.
Neither result justifies claiming round 2 is better.

## Round 2 - what was trained

- Run `code_modal_20261003_225820` (Modal L40S, 0.21 h, final train loss 0.069), same base,
  hyperparameters and seed as round 1. Adapter kept locally (`training/runs/`, not committed).
- Data `training/code/formatted-r2/`: round 1's 403 rows + 112 synthetic corrections from
  `training/code/make-import-corrections.py` - each accepted first attempt that imports a local
  module, with one imported value renamed to a plausible non-export, the exact CORRECTION prompt
  the pipeline sends for that TS2305, and the original accepted file as the answer. No teacher
  calls; gold plans never read.

## Caveats

- **Sample size.** 43-84 components per cell; differences under about 10 points are noise here.
- **Gemini baseline is on the original references only**, three of which Gemini itself built;
  it was not re-run on the independent set (daily quota).
- **One run per adapter**, seed 42; no variance across training seeds.
- **Operational:** the round-2 independent frontend/database pass was interrupted and re-run once
  from scratch after concurrent sessions overwrote its progress file; the reported numbers are
  from the single clean run (`eval-code2-indepref-fd.log`).

## Cost

About $8-10 of Modal credit for this phase: reference build ~1 h L40S, evaluation servers
~3-4 h L40S, training 0.21 h. Gemini baseline on the free quota.

Result files: `training/eval/code/` (`*-indepref*`, `*-frontend-database-full`, `*code2*`, `gemini.json`).
