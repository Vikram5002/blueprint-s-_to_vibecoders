# Local code model: capture and evaluation scripts

Companion to `docs/LOCAL-CODE-MODEL-PLAN.md` (§5 data, §6 format, §7 test).
Two scripts, both importing the compiled pipeline from `dist/`, so build first:

```bash
npx tsc -p .
```

Both scripts run the **real** generation pipeline - `generateAndVerifyProject`
-> `installBuildAndRepair` (`src/generate/build-and-repair.ts`, the same
function the server's job runs) -> `runRuntimeCheck`
(`src/generate/runtime-check.ts`). Nothing is re-implemented in the scripts.

> Gating: collection with Gemini as the teacher is on hold until the Gemini
> terms question in the plan's §10 is cleared. The scripts are ready; running
> them against Gemini is a separate decision.

## The acceptance rule, in words

A component example is **accepted** when, for the project it came from, as it
finally stands on disk after every repair round:

1. `npm install` and `npm run build` (tsc, strict) both pass;
2. Blueprint reports **no** unresolved violation anywhere in the project;
3. the service-locator (auth-bypass) detector finds **nothing** in the project;
4. the built server starts, and the component's own runtime check passes -
   for a backend component, `GET /api/<slug>` and `GET /api/<slug>/` both
   answer with a status below 500; for a security component (global
   middleware) **every** backend route in the project answers below 500.

Rules 1-3 are project-wide: one broken file rejects every component of that
project, because the prompt of every other component describes that file's
exports as context. Rule 4 is per component. Any status below 500 - including
401 and 404 - counts as "answered": this is a liveness check for the
`orderGuard` failure mode (compiles, passes Blueprint, rejects every request
or crashes), not a functional test.

Each record carries `accepted: boolean` and `reasons: string[]`; a rejected
record is written too, never dropped, so the reasons histogram is real.
Reasons: `install-failed`, `build-failed`, `blueprint-violation`,
`service-locator-finding`, `runtime-not-started`, `runtime-route-failed`.

## 1. Capture: `scripts/capture-code-batch.mjs`

```bash
node scripts/capture-code-batch.mjs --local=http://127.0.0.1:8712 --model=<served name> \
  --out=capture/code/teacher-batch-1.jsonl \
  [--sources=training/data/real-project,training/data/synthetic] [--limit=N] [--domains=backend,security]
```

- `--local=<url> --model=<name>`: the teacher is a local inference server;
  `model` is sent in every request body so a multi-model server picks the
  right checkpoint. Without `--local` the provider is chosen exactly like the
  CLI does (`VIBE_LLM_PROVIDER`, `.env`; Gemini by default), and `--model`
  overrides its model name.
- `--sources`: JSONL files or directories of them, `{"prompt", "schema"}`
  records. **`training/data/gold` is refused** - it is the held-out test set
  (`training/data/METHODOLOGY.md`). Default: real-project + synthetic.
- `--domains`: which components to write records for. Default all four;
  frontend and database rows are stored for later rounds either way.
- `--work`: where generated projects are written (default
  `capture/code/work/<sessionId>`, git-ignored, node_modules included).

Per plan: `validateProjectSchema` -> generate + Blueprint verify (cache off) ->
install/build/repair -> re-verify if a repair rewrote anything -> runtime
check. Then, for every component file in the final files, the exact request
is rebuilt by calling the real `generateComponentFile` with a **recording
stub provider** that answers with the final file; the stub sees the final
files as `generatedSoFar`, so the prompt's dependency `exports:` and
declarations describe the code the example is paired with.

Outputs (all append-only, fsync'd per line):

| File | One line per | Content |
|---|---|---|
| `--out` | component example | the record below; `kind:'first'` for each component file, `kind:'correction'` for each retry the pipeline made (Blueprint, locator, or build-failure), with the recorded `CORRECTION REQUIRED` prompt paired with the final file |
| `<out>.raw.jsonl` | teacher call | request, raw response text, usage, latency, or the error - success and failure alike |
| `<out>.projects.jsonl` | plan | outcome (`captured`, `generation-failed`, `repair-failed`), build result, counts, route statuses |

Record contract (exact keys; correction records add `correctionOrigin`
and `correctionOutcome` as provenance):

```json
{ "recordId", "sourceFile", "sessionId", "kind": "first|correction", "domain",
  "component": { "id", "name", "purpose" }, "targetPath",
  "request": { "system", "user", "schema" }, "code", "accepted", "reasons": [],
  "teacher": "<provider name, e.g. gemini:gemini-3.5-flash>", "capturedAt" }
```

Training rows are built from `request.system`, `request.user`, and
`JSON.stringify({ code })` - see the plan's §6.

**Resuming:** re-running with the same `--out` skips every `sessionId`
already present in `--out` or in `<out>.projects.jsonl`. Delete a project's
lines from both to redo it.

## 2. Evaluation: `scripts/eval-code-model.mjs`

Step one, once per reference provider (Gemini by default):

```bash
node scripts/eval-code-model.mjs --build-reference [--reference-provider=gemini] [--reference=capture/code/gold-reference] [--limit=N]
```

Every gold plan is generated in full, installed, built, repaired and checked
with all four rules above. `capture/code/gold-reference/<sessionId>/` gets
`schema.json`, `manifest.json` (`passed`, `reasons`, file list, build and
route results) and, for a passing project, the files and `node_modules`. A
failing project keeps its manifest so a re-run skips it; only passing projects
enter the evaluation. Resumable the same way as capture.

Step two, once per candidate:

```bash
node scripts/eval-code-model.mjs --candidate=http://127.0.0.1:8712,model=<served name> --out=training/eval/code/<name>.json
node scripts/eval-code-model.mjs --candidate=gemini --out=training/eval/code/gemini.json
   [--domains=backend,security] [--limit=N] [--skip-c] [--work=<scratch dir>]
```

For each backend/security component of each passing reference project, the
reference project is copied to `capture/code/work/eval-<name>/<sessionId>/<file>/`
and **only that component** is regenerated by the candidate, with the
reference's files as context. The reference's `node_modules` is linked into
the copy (junction on Windows, symlink elsewhere, recursive copy as a last
resort - `nodeModulesSharing` in the output says which) so ~94 swaps do not
mean ~94 installs.

| Metric | Meaning |
|---|---|
| **A** | first attempt: `npm run build` passes, Blueprint clean, locator clean, and D passes for that component |
| **B** | the same after `installBuildAndRepair`'s normal repair rounds, repairs written by the candidate |
| **C** | whole project: the candidate writes every backend+security component in generation order, then one full build and the same checks over every route |
| **D** | the per-component runtime verdict on its own, in the A state (`D_A`) and the B state (`D_B`) |

Output JSON: `rates` (A, B, C, D_A, D_B with `n`), `byDomain`, `rows` (one per
component: reasons for A and B, the candidate's code, build output on
failure, repair round count) and `projects` (one per C run). The table printed
at the end is the same numbers.

Ship bar (plan §7): D passes on every accepted component, A ≥ 0.8 × Gemini's
A, B within 10 points of Gemini's B, A ≥ plain Coder's A + 15 points. Run
`--candidate=gemini` first to get the reference numbers.
