# Reanalysis of existing code-evaluation artifacts

This is a reproducible statistical reanalysis of completed JSON reports from the
locally cached `origin/main` revision `2d43b049e0f1321c9f4e03ca32afc9abdc5448e5`.
It is not an evaluation run on `semi`, and it does not add or alter the source
reports. The raw artifacts were read with `git show`, checked for matching
reference labels and exact `(sessionId, targetPath)` pairing, then passed to
`scripts/compare-code-evaluations.mjs`. Temporary copies used during comparison
were deleted after the commands completed.

The raw reports are committed in the history: the first adapter/base comparison
is recorded by `72dd684`; the independent-reference results by `c463aeb`; the
Gemini baseline by `b069597`; and the expanded base/round-two results by
`3fbe111`. `origin/main` also contains the report `docs/RESULTS-CODE-M2.md`; that
file was read for provenance but not edited.

## Paired outcomes

The interval column gives each model's separate 95% Wilson score interval. The
paired column gives candidate-only wins / baseline-only wins and the two-sided
exact McNemar p-value. P-values are pointwise and are not adjusted for multiple
comparisons. A is the first attempt; B is after the evaluation harness's repair
rounds. This reanalysis does not cover whole-project C.

| Reference set and comparison | Metric | Baseline | Candidate | Paired wins / losses; p |
|---|---:|---:|---:|---:|
| Original, Qwen base → round 1 (n=46) | A | 19/46, 41.3% [28.3, 55.7] | 40/46, 87.0% [74.3, 93.9] | 22 / 1; 0.00000572 |
| Original, Qwen base → round 1 (n=46) | B | 27/46, 58.7% [44.3, 71.7] | 40/46, 87.0% [74.3, 93.9] | 14 / 1; 0.0009766 |
| Independent, Qwen base → round 1 (n=43) | A | 21/43, 48.8% [34.6, 63.2] | 34/43, 79.1% [64.8, 88.6] | 13 / 0; 0.0002441 |
| Independent, Qwen base → round 1 (n=43) | B | 27/43, 62.8% [47.9, 75.6] | 39/43, 90.7% [78.4, 96.3] | 12 / 0; 0.0004883 |
| Original frontend/database, Qwen base → round 1 (n=84) | A | 13/84, 15.5% [9.3, 24.7] | 48/84, 57.1% [46.5, 67.2] | 37 / 2; 2.84e-9 |
| Original frontend/database, Qwen base → round 1 (n=84) | B | 36/84, 42.9% [32.8, 53.5] | 76/84, 90.5% [82.3, 95.1] | 44 / 4; 1.51e-9 |
| Independent frontend/database, Qwen base → round 1 (n=73) | A | 16/73, 21.9% [14.0, 32.7] | 35/73, 47.9% [36.9, 59.2] | 24 / 5; 0.0005461 |
| Independent frontend/database, Qwen base → round 1 (n=73) | B | 33/73, 45.2% [34.3, 56.6] | 65/73, 89.0% [79.8, 94.3] | 36 / 4; 1.86e-7 |
| Independent backend/security, round 1 → `code2` (n=43) | A | 34/43, 79.1% [64.8, 88.6] | 35/43, 81.4% [67.4, 90.3] | 5 / 4; 1.0 |
| Independent backend/security, round 1 → `code2` (n=43) | B | 39/43, 90.7% [78.4, 96.3] | 41/43, 95.3% [84.5, 98.7] | 3 / 1; 0.625 |
| Original backend/security, round 1 → `code2` (n=46) | A | 40/46, 87.0% [74.3, 93.9] | 37/46, 80.4% [66.8, 89.3] | 3 / 6; 0.5078125 |
| Original backend/security, round 1 → `code2` (n=46) | B | 40/46, 87.0% [74.3, 93.9] | 42/46, 91.3% [79.7, 96.6] | 5 / 3; 0.7265625 |
| Independent frontend/database, round 1 → `code2` (n=73) | A | 35/73, 47.9% [36.9, 59.2] | 36/73, 49.3% [38.2, 60.5] | 3 / 2; 1.0 |
| Independent frontend/database, round 1 → `code2` (n=73) | B | 65/73, 89.0% [79.8, 94.3] | 66/73, 90.4% [81.5, 95.3] | 5 / 4; 1.0 |
| Original, round 1 → Gemini (n=46) | A | 40/46, 87.0% [74.3, 93.9] | 46/46, 100% [92.3, 100] | 6 / 0; 0.03125 |
| Original, round 1 → Gemini (n=46) | B | 40/46, 87.0% [74.3, 93.9] | 46/46, 100% [92.3, 100] | 6 / 0; 0.03125 |

These comparisons show sizeable round-one gains over the Qwen base on the
reported component sets. On the independent sets, the `code2` rows have small
point differences from round 1 and the paired tests do not distinguish them.
The Gemini comparison is only on the original references, which include three
projects Gemini itself built according to the existing M2 report; it is not an
independent-reference Gemini comparison.

## Provenance limitations

- The independent-reference reports identify the set as
  `capture/code/gold-reference-qwen3`; the M2 documentation says 23 of 47 plans
  passed with Qwen3-Coder-30B-A3B, which did not write the training data. The
  project directories themselves are not tracked in the available Git tree, so
  this reanalysis verifies report pairing and provenance metadata, not the
  contents or licenses of those projects.
- `training/runs/code_modal_20261003_225820/summary.json` says `round 1` and
  points at `training/code/formatted/dataset.jsonl`, while its commit describes
  a round-two summary and the round-two manifest points at
  `training/code/formatted-r2/dataset.jsonl`. It also records `git_commit: null`.
  The adapter weights are not tracked. Therefore these `code2` evaluation
  reports cannot, from the available artifacts alone, be tied conclusively to a
  verified round-two training run. They are reported here under their artifact
  label without claiming the training provenance is settled.
- The Gemini JSON is a completed historical result, but it is only present on
  `origin/main`. The assigned Gemini command has not been run on `semi`; this
  branch still lacks its generator, evaluator, references, and candidate setup.
