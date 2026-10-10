# Code-generation evaluation and assigned-task status

This document records what can be verified in the `semi` checkout. It does not
import model scores or training outcomes from another branch.

## Evaluation statistics

`scripts/code-evaluation-statistics.mjs` provides:

- Wilson score intervals for a pass rate. The default is a two-sided 95% interval.
- The two-sided exact McNemar test for candidate and baseline pass/fail outcomes
  on the same component IDs. Concordant pairs are ignored by the test; discordant
  wins and losses are reported separately.

The input to McNemar must contain one unique ID and two boolean outcomes for each
paired component. Missing results, duplicate IDs, and empty input are rejected.
The included test cases are synthetic software checks, not model observations.
Run them with `npm run test:code-eval-stats` or directly with
`node scripts/code-evaluation-statistics.test.mjs`.

`scripts/compare-code-evaluations.mjs` validates and compares two completed
`eval-code-model.mjs` JSON reports. It requires the same reference label and an
exact match of all component IDs before computing Wilson intervals and paired
McNemar results. A historical reanalysis of completed `origin/main` reports is
documented in `CODE-EVALUATION-REANALYSIS.md`; those values are not new
experiments performed on `semi`.

## Experiment status in this branch

- **Gemini code-generation baseline:** historical result and artifact were
  inspected on `origin/main`; the paired comparison utility validates it against
  another completed report. `semi` has no generator, gold component dataset,
  reference-project harness, or `scripts/eval-code-model.mjs`, so the assigned
  command has not been run here and no API request was made.
- **Expanded/reference evaluation:** historical reports have been reanalyzed
  with exact pairing and Wilson/McNemar calculations. New evaluation runs remain
  blocked because the dataset, generator, independent reference project trees,
  and scoring pipeline are absent from `semi`. The independent project files are
  not tracked in the available Git tree.
- **Second training round:** the local preparation workflow is integrated:
  the captured teacher/correction inputs, formatter, exact round-two dataset
  and manifest, trainer, and inference/render helper are present. A tokenizer
  free formatter run reproduced all 515 rows and the manifest SHA-256 exactly;
  the trainer's data-only preflight also passed and rejects Gemini teacher
  labels. No training job was launched. The historical run summary still
  conflicts with its commit label and round-two manifest, and the adapter
  weights are absent, so there is no verified second-round training result.
- **Responsive Page Builder:** blocked. This branch has no Page Builder, saved
  page-layout model, or generated-app pipeline. The graph canvas is a different
  feature and was not reworked as a substitute.
- **Accessibility:** partial for the UI present on this branch. The architecture
  graph UI has a skip link, named graph/details landmarks, pressed state on
  view toggles, an alert/status announcement, a contextual expand name, and
  visible keyboard focus. Correction controls use explicit labels and grouped
  fieldsets. Playwright/axe now check the graph's empty state for WCAG A/AA and
  exercise the skip link and keyboard grouping controls. The Page Builder and
  its E2E workflows remain unavailable on this branch.

## Provenance and leakage controls

No reference projects or evaluation outputs were added. Before a real experiment
is possible, its reference-project source, license, and independence from the
training teacher must be recorded. Training and evaluation inputs must remain
separate, and comparisons must pair results by stable component ID.
