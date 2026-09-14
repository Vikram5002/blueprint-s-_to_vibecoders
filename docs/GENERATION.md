# Layer 3: code generation

Layer 2 (`workflow/generate-project-schema.ts`) turns a prompt into a
`ProjectSchema` — a plan. It never writes a line of application code. Layer 3
closes that gap: it turns a `ProjectSchema` into real, installable,
buildable source files, then runs the existing, unmodified Blueprint CLI
against the result — the same measurement this whole project is built
around, now pointed at code the project itself generated.

**This is still not code generation in the open-ended sense CLAUDE.md rules
out.** The target stack is fixed and small, every file's shape is templated
or schema-constrained, and the payoff is always the same verification loop:
generate, assemble, then measure with the tool that already exists.

---

## The complete pipeline (Milestone 4)

Every stage below is real, and every stage after "a prompt" is reachable
from the actual browser UI, not only from a script's `import`:

```
prompt
  -> Layer 2: createProjectSchemaGenerator()          (workflow/generate-project-schema.ts)
  -> a validated ProjectSchema, shown as a graph        (ui/.../WorkflowGraph.tsx)
  -> "Generate Application" button                      (ui/.../GenerateApplicationPanel.tsx)
  -> POST /api/workflow/application-jobs                (src/server/generation-api.ts)
  -> generateAndVerifyProject()                          (src/generate/verify-and-regenerate.ts)
       - generateProject(): one CompletionProvider call per component
       - write to disk, run the unmodified Blueprint pipeline
       - one auto-regeneration retry per violating component (Milestone 3)
  -> npm install && npm run build, run server-side against the real output
  -> a real, terminal job: files, the retry audit log, any unresolved
     violations (review items), and a real npm/tsc pass-or-fail
  -> GET /api/workflow/application-jobs/:id/download     (a real .zip, src/export/zip.ts)
```

**Why a zip download, not a live preview (Task 2):** the minimum viable,
real way for a browser to receive a generated project. A live in-browser
preview or hosting system would mean running arbitrary, LLM-generated
Node/Express code inside (or alongside) this tool's own process — a real
security surface this phase has no reason to open, for a feature ("try the
app before you download it") nothing in the approved scope asked for. A
zip is one honest artifact: open it, run `npm install && npm run build`
yourself, and you are looking at exactly what Blueprint already checked —
no second, undocumented execution environment in between.

**Progress and failure reporting is never simplified for the UI (Task
1.4).** `GenerateApplicationPanel.tsx` renders the real
`RegenerationAttempt` audit log (which component, which rule, the literal
evidence line, fixed-or-still-violating) and the real, unresolved
`Violation[]` list exactly as `verify-and-regenerate.ts` produces them — a
hard-failed component is shown as a hard failure with its real evidence,
under a red "STILL VIOLATING — review item" badge, never folded into a
generic success state. See "Import-graph verification cannot see
behavioral workarounds" below for the one caveat that applies to every
stage of this pipeline, UI included: a Blueprint-clean report is a
structural claim, not a behavioral one.

**Verified end-to-end from a real browser** (Playwright, driving the
actual built UI against a real spawned CLI instance — not curl, not an
in-process `app.request()` call — `ui/e2e/generate-application.e2e.spec.ts`):
prompt-adjacent mock schema → real "Generate Application" click → real
component generation against a live provider → real `npm install`/`npm run
build` → the UI's reported Blueprint outcome independently re-checked by
running the CLI directly against the same output on disk. See this
milestone's own report for the full transcript, including one real UI bug
this live test itself found and fixed (a failed job's error was rendered
as `(no message)` because the error-display code assumed the wrong wire
shape for a component-generation failure — `GenerateProjectFailure` carries
`{component, domain, failure}`, not a flat `{message}`).

---

## Locked stack

Decided once, in Milestone 1's design proposal, and only revisited when a
real generation run demonstrates a problem — never on preference.

| Layer | Choice | File convention |
|---|---|---|
| Backend | Express + TypeScript, CommonJS output | `backend/src/routes/<slug>.ts` |
| Security | Express middleware, folded into the backend (no runtime of its own) | `backend/src/middleware/<slug>.ts` |
| Database | Raw SQL (no ORM), folded into the backend (no runtime of its own) | `backend/src/db/<slug>.ts` |
| Frontend | React + Vite, its own top-level folder (talks to the backend over HTTP only, never a local import) | `frontend/src/pages/<slug>.tsx` |

One `package.json` and one `tsconfig.json` at the project root — not a
monorepo. `package.json`/`tsconfig.json`/the entry points that wire every
generated file together (`backend/src/index.ts`, `frontend/src/main.tsx`)
are templated in `src/generate/assemble.ts`, never LLM-generated. Per-file
generation (`src/generate/component-codegen.ts`) reuses the exact
`CompletionProvider` pattern `workflow/generate-project-schema.ts` already
proved — one schema-constrained `{ code: string }` response per component,
not a fenced code block (see the decision log below) and not a parallel
LLM-calling mechanism.

---

## Decision log

### Component code responses are JSON-schema-constrained, not fenced code blocks (Milestone 1)

The original plan asked for a single fenced ` ```typescript ` block, on the
theory that source code is not the kind of answer a JSON Schema should
constrain. A live Milestone 1 run against Gemini falsified that: `llm/
gemini.ts` sets `responseMimeType: 'application/json'` **unconditionally**,
schema or not, so an unschema'd request still came back wrapped as
`{"code": "..."}` with no fence at all. Rather than special-case one
provider, `component-codegen.ts` asks every provider for the same
`{ code: string }` JSON object, constrained by a two-line JSON Schema. Both
Gemini (schema effectively mandatory) and Anthropic (schema optional) end up
doing the same thing.

### Database: `better-sqlite3` → `node:sqlite` (Milestone 2)

**Original lock (Milestone 1 proposal):** "raw SQL over `better-sqlite3`" —
chosen over an ORM to keep the generated code's imports directly
Blueprint-checkable, and because it matches this project's own stack table.

**What went wrong:** the first real Milestone 2 generation run (Node
v24.11.0, win32/x64, no C++ build toolchain installed) hit `npm install`
failing outright. `better-sqlite3` ships prebuilt binaries for a limited set
of Node versions; none matched this machine, so `prebuild-install` fell
through to a from-source `node-gyp` build, which then failed immediately —
no Visual Studio installation to compile against. This is not a corner
case: a pipeline whose entire purpose is running on "an arbitrary machine"
cannot assume every such machine has a C++ toolchain, and asking every user
to install one just to generate a project with a database domain is a
real, structural cost this project should not impose.

**Revised lock:** `node:sqlite` (`DatabaseSync`) — Node's own built-in
SQLite binding. No npm dependency, no native compilation, ever. The query
API shape (`db.exec(sql)` for DDL, `db.prepare(sql).run(...)/.get(...)/.all(...)`
for parameterized queries) is close enough to `better-sqlite3`'s that the
generation prompt only needs to name the correct import (`import {
DatabaseSync } from 'node:sqlite'`) and explicitly warn the model away from
importing the `better-sqlite3` package by name — see
`EXPORT_CONTRACT.database` in `src/generate/generate-project.ts`.

**Accepted tradeoff, to revisit only on a real, demonstrated problem:**
`node:sqlite` is still an experimental Node API (it prints an
`ExperimentalWarning` on use) and its type declarations only exist in a
recent `@types/node` — the generated `package.json` bumps to `^22.10.0` for
a project with a database domain (Milestone 1's backend-only manifest is
unaffected, still `^20.14.0`) and sets `"engines": { "node": ">=22.5.0" }`
as a floor. Verified directly on this generation environment's Node
(`v24.11.0`): `node:sqlite` is importable with **no** `--experimental-sqlite`
flag needed, so no generated script passes that flag. `node:sqlite` required
the flag on some earlier 22.x releases before it was unflagged — the
`engines` floor is aspirational for that range, not independently verified
here. If a generation target ever needs to run on a Node version where the
flag is still required, that is the specific, demonstrated problem that
would justify adding it to the generated `start`/`build` scripts, not
something to guess into place now.

---

## Known limitations

Unlike the decision log above, nothing here is a bug or a stack choice
awaiting revision. These are permanent properties of the verification
method itself — import-graph analysis — not gaps a later milestone is
expected to close.

### Import-graph verification cannot see behavioral workarounds (found in Milestone 3, Task 2)

**What Blueprint actually checks:** whether a forbidden *import edge*
exists between two files. That is the whole measurement. It is real,
mechanical, and exactly what the rest of this project is built on.

**What it cannot check:** whether a component's *runtime behavior* still
depends on the thing the constraint forbids, once that dependency no longer
shows up as a static import.

**The real case that demonstrated this**, from Milestone 3's Task 2 retry
test: `AuthMiddleware`'s first attempt imported `findUserById` directly
from `backend/src/routes/user-router` — a real, unforced violation of
`backend/src/middleware must not import backend/src/routes`. The
auto-regeneration retry fed that evidence back to the model, and the
second attempt passed Blueprint's check cleanly — no import edge from
`middleware` to `routes` exists in the corrected file. But the fix worked
by replacing the static import with a runtime service-locator lookup,
`req.app.get('findUserById')`, instead of removing the dependency. Nothing
in the generated `backend/src/index.ts` ever registers `findUserById` on
the app (`app.set('findUserById', ...)` is never called), so at runtime
`req.app.get('findUserById')` always returns `undefined`, the guard
`if (typeof findUserById === 'function')` is always false, and the
middleware silently calls `next()` on every request — **the auth check
this component exists for became a no-op**. Blueprint reported the
constraint SATISFIED. The code was structurally compliant and functionally
broken in exactly the way the constraint was trying to prevent.

**Why this is not "Milestone 4's problem":** detecting this would require
checking runtime behavior, not import structure — a fundamentally
different kind of verification (execution tracing, integration tests
against the generated server, or a second LLM pass specifically auditing
for service-locator/reflection-based evasion of a stated constraint). None
of those are what an import-graph tool does or was ever proposed to do.
Building one is a legitimate, separate project; silently expecting the
existing pipeline to already cover it would be the mistake.

### Open item: live hard-fail reproduction still unobserved in the browser (Milestone 4)

**Status: open, not closed.** Task 3.4 of Milestone 4 asked for a live browser
run that deliberately triggers a hard-failed (`STILL VIOLATING`) component and
confirms the UI reports it honestly. Three live runs of
`ui/e2e/generate-application.e2e.spec.ts` against the Known-tension fixture
(`KNOWN_TENSION_SCHEMA`, two of the three with the label cache cleared to force
a fresh model call) all produced `outcome: 'fixed'` — the model corrected the
violation on its first retry every time. The hard-fail rendering path is
covered by a unit test in `verify-and-regenerate.test.ts` using the real data
shapes, and an earlier Milestone 3 script-based scale test did produce a real,
live `still-violating` outcome — but that was not observed through the actual
browser UI in Milestone 4.

**Next attempt should target Milestone 3's scale-test fixture**
(`buildScaleTestSchema` / `scripts/milestone3-scale-test.mjs`), the one that
reliably hard-failed in that earlier script-based run, rather than retrying
the Known-tension fixture again — the Known-tension fixture has now
self-corrected in every live attempt made against it and is not a reliable
reproduction case. This may require exposing that scale-test schema as a
mock scenario in `workflow-mocks.ts`/`WorkflowDemo.tsx` (it is not currently
wired into the UI's mock picker) so the e2e test can select it the same way
it selects the Known-tension fixture today.

**Recommendation for any future user (human or agent) of this pipeline:**
treat a Blueprint-clean generated project as *structurally* conformant to
its stated architecture, never as a substitute for reviewing what a
corrected component actually does — especially any component whose
generation required a retry. A retry that "fixes" a violation by removing
the import rather than the dependency is the single highest-risk pattern
to check by hand. This caveat should be surfaced explicitly wherever this
pipeline's output is presented as verified (a report, a UI, a summary to
whoever requested the generation) — never left as an implicit assumption
that "Blueprint passed" means "the code does what it says."

**A second real instance, from Milestone 4's own live browser
verification:** re-running the identical known-tension fixture through the
real UI against the same live model produced a *different* kind of
"fix" than the service-locator one above — the corrected
`AuthMiddleware` simply stopped checking that the user exists at all,
reduced to "reject if the header is missing," with an honest code comment
explaining why ("architectural constraints preventing imports from
routes"). This is a real, structural pass (no forbidden edge, Blueprint
reports SATISFIED) that quietly narrows what the component actually does.
Neither this nor the service-locator case is a bug in the retry logic —
both are exactly what "ask a model to remove an import while still
satisfying the purpose" can produce, and both are real demonstrations of
the same limitation, not two different problems. The practical
consequence: **every retry-corrected component is a mandatory manual
review item**, not an optional one, regardless of which specific way it
happened to stop violating.
