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

**Investigated, 2026-09-14 — conclusion: not tractable as a Blueprint
feature; tractable only as a narrow, opt-in Layer-3 check, and not
implemented.** Re-read the actual offending code quoted above in full and
checked what Blueprint's own extraction layer (`src/parser/extract-ts.ts`)
already captures, to answer concretely rather than guess.

`extractTypeScriptSymbols` already walks every `call_expression` node in a
file (`collectCallExpression`), but only ever turns one into an
`ImportRecord` when the callee is exactly `require` or a dynamic `import()`
— i.e. a call whose argument is a *module specifier*, something Blueprint's
whole edge model exists to resolve to a real file. `req.app.get('findUserById')`
is structurally nothing like that: the callee is a member expression
(`req.app.get`), and the string argument (`'findUserById'`) is not a module
path — it never gets near the resolver, the graph, or an `Edge`, so there is
no existing hook this pattern could attach to. Detecting it would mean
teaching Blueprint's core extraction layer to recognize one specific
runtime API convention (Express's `app.get(key)`/`app.set(key, value)`
locator idiom) and treat a plain string literal as if it named a forbidden
export — a fundamentally different kind of check than "does a real import
edge exist," grafted onto a tool whose entire value proposition is that it
never guesses at meaning it cannot trace to a real import statement.

**As a general, always-on Blueprint capability, this is not tractable —
concretely, not just in principle.** `app.get(<string>)`/`app.set(<string>,
...)` is one of the most common idioms in real, hand-written Express code
for entirely legitimate purposes with no relationship to import forbidding
at all: `app.set('trust proxy', 1)` / `app.get('trust proxy')`,
`app.set('view engine', 'ejs')`, `app.get('port')` are all standard
production Express configuration calls. A blanket "flag any `app.get`/
`app.set` call with a non-path-shaped string" rule would false-positive
constantly against ordinary Express code that has nothing to do with this
project's generation pipeline — the same reasoning that already rules out
treating "any dynamic/runtime dependency-injection pattern" as suspicious
by default: `Map.get(key)`, DI containers, and config lookups are all
extremely common, entirely legitimate uses of the identical call shape.
General-purpose static import-graph analysis has no way to distinguish
"this is evading a stated constraint" from "this is a config getter" from
the call shape alone, and a tool whose entire value is precision (rule 3:
never create an edge you cannot point at a real import line for) should not
start guessing here.

**A narrower, precise version IS concretely tractable, but only inside this
project's own Layer 3 generation pipeline, never in Blueprint's core
conformance engine — proposed here, not implemented:**

- **What to detect:** in `verify-and-regenerate.ts`, after a component
  passes the real Blueprint check, scan its generated source text (a plain
  string scan, the same regex-based posture `extractNamedExports` already
  takes for extracting identifiers, not a graph edge) for a call shaped
  like `<anything>.get('<name>')` or `<anything>.set('<name>'` where
  `<name>` is a string-literal argument. Cross-reference every such
  `<name>` against the real, already-known named exports (via the same
  `extractNamedExports` infrastructure item 1 just built) of every file in
  a domain the current component's constraints forbid it from importing.
  A match — the literal string equals a real, forbidden export's actual
  name — is a strong, precise signal: not "any locator call," only one
  whose argument happens to spell out the exact identifier a stated rule
  just forbade importing.
- **Where it would run:** as a new check inside `generateAndVerifyProject`,
  after the existing Blueprint verify step and independent of it — its own
  finding type (e.g. `SuspectedServiceLocatorEvasion`), never folded into
  `Violation`, since it is not a real import-edge finding and must never be
  presented as one. Whether a match should trigger the existing
  one-retry-per-component mechanism (feeding "you referenced this forbidden
  identifier via a runtime lookup instead of removing the dependency" as
  corrective context) or only ever surface as a mandatory manual-review
  flag is itself a decision for whoever approves implementing this, not
  assumed here.
- **False-positive risk:** low, specifically *because* it is scoped to
  this pipeline's own fixed, small, predictable `EXPORT_CONTRACT`
  convention — identifiers like `router`, `middleware`, and a handful of
  per-database query function names a real person chose for their purpose
  text, not arbitrary hand-written code where a coincidentally-matching
  config key (`app.get('port')` if some database file happened to export a
  function literally named `port`) could still false-positive. Not zero
  risk, but meaningfully lower than the general, unscoped version above,
  and only ever applied to this pipeline's own generated output — never to
  a user's real repository, where Blueprint's core engine already
  correctly stays silent on this.

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

**Attempted again, 2026-09-14, against the scale-test fixture specifically —
still not reproduced, and this is itself real, useful data, not a dead
end.** `SCALE_TEST_SCHEMA` was added to `workflow-mocks.ts` (mirroring
`buildScaleTestSchema` verbatim) and wired into `WorkflowDemo.tsx` as a new
"Scale-test fixture (Milestone 3, TaskRouter hard-fail)" scenario button, and
a new live e2e spec (`ui/e2e/scale-test-hard-fail.e2e.spec.ts`) drove it
through a real browser against a freshly-confirmed-live provider (a new API
key, verified with one cheap test call before committing to the full run,
after the previous key's daily free-tier quota had been exhausted). The run
was genuinely live — 13 fresh cache entries were written with real
timestamps, including exactly the 3 backend routers (TaskRouter, UserRouter,
CommentRouter) whose purpose text explicitly asked them to import the
database layer directly, each producing a real first-attempt violation and
each self-correcting on Milestone 3's one allowed retry. Outcome: **`fixed`,
0 unresolved violations** — the same fixture that reliably hard-failed in
Milestone 3's original script-based run did not hard-fail this time, on the
currently-available model (`gemini-3.5-flash`).

This is the second distinct fixture, now, that reliably self-corrects
instead of hard-failing under live, current conditions — plausibly because
Blueprint's real corrective evidence (the exact rule, file, and line) is
simply easier for the current model to act on correctly than it was for
whatever model produced the original hard-fail evidence, not because
anything in this pipeline changed to make hard-failing less likely. The
hard-fail *rendering* path remains verified only by
`verify-and-regenerate.test.ts`'s unit test (using the real data shapes) and
by Milestone 3's original script-based run's own report — never yet by a
live browser observation. `ui/e2e/scale-test-hard-fail.e2e.spec.ts` is kept
as a permanent regression asset regardless: it is still real, live coverage
of a code path no other live test exercises (three components needing a
retry simultaneously in one run, not one), and it honestly logs and asserts
against whichever real outcome occurs rather than assuming one. A future
attempt with a different or future model version may yet reproduce a live
hard-fail through this exact spec with no changes needed — this item stays
open, not because nothing was tried, but because two genuine, good-faith
attempts against two different documented "should hard-fail" fixtures have
not produced one.

**An open question this raises, recorded precisely rather than left
implicit — not concluded either way:** both fixtures on record as having
reliably hard-failed were designed against whatever model was live at the
time of their original run (an earlier Gemini version for the known-tension
fixture's Milestone 1 origin; a possibly-different one for the scale-test
fixture's Milestone 3 script run). Both have now self-corrected on every
live attempt made against them under the currently-available model
(`gemini-3.5-flash`). That is consistent with two different explanations,
and this project has not gathered enough evidence to distinguish them:

1. **The underlying model has genuinely become more reliable** at exactly
   this class of violation — reading Blueprint's real corrective evidence
   (rule, file, line) and correctly removing a forbidden import while still
   satisfying the stated purpose — since these fixtures were designed
   against an earlier model. If true, the auto-regeneration retry's
   practical hard-fail rate may be lower now than it was when Milestone 3
   measured it, which would itself be worth knowing and re-measuring at
   scale, not just for these two hand-picked fixtures.
2. **This is coincidence at `n=2`.** Two non-deterministic live attempts
   against two fixtures is a very small sample; a fixture "reliably"
   hard-failing in one earlier script-based run and self-correcting in one
   or two live attempts since is not yet a statistically meaningful
   reversal, and could just as easily flip back on the next attempt.

**Why this matters for whoever picks this item up next:** the honest
next step is not "run these same two fixtures a third time and hope for a
different result" — if explanation 1 holds, repeating the same fixtures
will keep self-correcting regardless of how many more attempts are made,
and the real next step would be designing a NEW fixture calibrated against
the CURRENT model's actual failure modes (which requires first
characterizing what those are, e.g. by running many small variations and
observing the retry's real success rate, not assuming today's model fails
the same way an earlier one did). If explanation 2 holds, a handful more
attempts against the existing fixtures might still eventually reproduce a
hard-fail, and no new fixture design is needed. This document does not
decide between the two - that decision, and the work it implies, is left
for a future session with a clear head start on what to investigate rather
than an instinct to just try again.

**Investigated further, 2026-09-14 — a real, non-hypothetical mechanical
cause was found; it does not fully resolve the question above, but it
does mean "try again" was never going to be a clean test.** Checked
concretely rather than assuming: `git log` shows `DEFAULT_GEMINI_MODEL`
(`src/llm/gemini.ts`) has been the single string literal `'gemini-3.5-flash'`
since the constant was first introduced — it has never changed in this
project's code, across both the original known-tension hard-fail, the
original scale-test hard-fail, and every recent self-correcting run. So
in-code, the model identifier is not the variable.

But the actual generation and retry-context construction code IS
different now. `component-codegen.ts` has exactly four commits in its
history; the CORRECTION REQUIRED retry-context block itself
(`buildUserPrompt`'s `priorViolation` branch) is byte-for-byte identical
between Milestone 3's original retry logic (`a9b9d81`) and today
(confirmed with `git diff a9b9d81 e09e64b -- src/generate/component-codegen.ts`
showing zero lines changed in that block) — so the specific text a
component sees when told "you violated this rule, here is the evidence"
has not changed at all. What HAS changed, entirely from Item 1's
export-convention fix (`e09e64b`):

1. `COMPONENT_CODE_SYSTEM_PROMPT` gained a new, emphatic paragraph
   ("Always use named exports. Never use a default export, under any
   circumstances...") — a more directive, repetition-heavy instruction
   style than the rest of the prompt used before.
2. `EXPORT_CONTRACT`'s wording changed from open-ended ("export default an
   Express Router") to a fixed, explicit named identifier ("Export ... as
   a named export literally called `router`").
3. Most relevant to the scale-test fixture specifically: every backend
   router in that schema has `backend.dependsOn = ['database']`, which
   means `allowedDependenciesForDomain` already permitted it to import the
   database file (the domain-level dependency is legitimate; only the
   finer-grained, real-path constraint forbids it — see
   `buildScaleTestSchema`'s own comment). Before Item 1's fix, that
   component's context carried only the import PATH. After the fix, it
   ALSO carries `dependencyExports` — the real named functions
   (`insertTask`, `listTasks`, `setTaskStatus`, etc.) that file actually
   exports — on both the first attempt AND the retry, since
   `verify-and-regenerate.ts`'s retry call site now passes `generatedSoFar`
   too.

None of these three changes touch the CORRECTION REQUIRED text a
component sees on retry. But (1) and (2) are a real, measurable shift in
how directive and explicit the overall system prompt is, and (3) is a
real, new piece of information present in exactly the prompts these two
fixtures' retries depend on. Either is a plausible mechanism for a model
following instructions (including "remove this import") more reliably
than before, without requiring any change in the model itself.

**This does not fully answer the open question above — it narrows it.**
It rules out "the model ID changed in our own code" as an explanation. It
does NOT rule out explanation 1 (Google silently updating what
`gemini-3.5-flash` serves under a stable alias, a common industry
practice this project has no way to detect or control) or explanation 2
(coincidence at `n=2`) — both remain live possibilities. What it adds is
a third, concrete, non-mutually-exclusive candidate: **explanation 3, a
real prompt/context change in Item 1's own fix plausibly made the
retry (and possibly the first attempt too) more reliable at this specific
class of violation, independent of anything about the model itself.**
No new fixture was constructed for this pass, since a genuine mechanical
cause was found in the exact code path in question (Step 3's branch, not
Step 4's) — spending a live API call on a third attempt at the SAME two
fixtures would not have distinguished any of the three explanations from
each other, since none of the three predict a specific run failing or
succeeding; a controlled comparison (the same fixture, with and without
Item 1's prompt changes, run enough times to see a real rate difference)
is the only way to isolate explanation 3 from 1 and 2, and is exactly
the kind of "characterize the current failure modes at scale" work the
paragraph above already flagged as the real next step - not attempted
here, left for a future session with this narrower, three-way question
instead of the original two-way one.

### Cross-file export-convention mismatches cause an unretried build failure (found live, post-Milestone-4)

**What happened:** a genuinely new live prompt ("a simple recipe box app for
saving favorite recipes with ingredients and steps") ran the full pipeline
end to end — schema generated, 8 component files generated, `npm install`
passed, Blueprint verification passed with all constraints satisfied — and
then `npm run build` failed with real `tsc` errors:

```
backend/src/routes/recipe-api-service.ts(2,10): error TS2305: Module
'../db/recipe-database' has no exported member 'recipeDatabase'.
backend/src/routes/recipe-api-service.ts(3,10): error TS2614: Module
'../middleware/input-validation-and-auth' has no exported member
'validateRecipe'. Did you mean to use 'import validateRecipe from
"../middleware/input-validation-and-auth"' instead?
```

Reproduced directly from the on-disk output of that exact run (no
regeneration needed): `input-validation-and-auth.ts` uses a single
`export default function`, but `recipe-api-service.ts` imports it as named
`{ validateRecipe, authenticate }`. Separately, `recipe-database.ts` never
exports a `recipeDatabase` object at all — it exports individual named
functions (`createRecipe`, `getRecipe`, `listRecipes`, `deleteRecipe`) — but
the router imports and calls a `recipeDatabase.getAll()` that was never
generated anywhere. The compiler's own suggested fix (`Did you mean to use
'import validateRecipe from ...' instead`) names the exact problem.

**Why this happens — confirmed from the actual code, not assumed:** each
component in `src/generate/generate-project.ts` is generated by an
independent `CompletionProvider.complete()` call
(`src/generate/component-codegen.ts`). The only shared context a component
receives about a file it is allowed to import from is `allowedImportPaths`
— a list of file *paths* — plus, for its own file, one fixed,
domain-level `EXPORT_CONTRACT` string describing how *that* domain's files
should export (e.g. `security: 'export default an Express middleware
function'`, `database: 'named export db ... No default export'`). Nothing
in `ComponentGenerationContext` ever tells a *consuming* component the
actual, already-decided export shape or identifier names of a specific
already-generated dependency file. `EXPORT_CONTRACT.database`'s "named
export `db`" guidance covers the database handle itself but not the
per-query named functions a router needs to call, and there is no
equivalent contract at all for what identifiers a generated middleware or
router file exports for other files to consume. This is a structural gap in
`COMPONENT_CODE_SYSTEM_PROMPT`/`buildUserPrompt`, not a one-off model
inconsistency: nothing currently prevents it from recurring on any schema
where one component's generated code needs to call into another's, since
each side guesses the interface independently.

**Confirmed from the actual code: this currently causes a full,
unretried build failure.** `runApplicationJob`
(`src/server/generation-api.ts`) calls `generateAndVerifyProject()` —
Milestone 3's entire generate → Blueprint-verify → auto-regeneration-retry
loop — to full completion first, and only *after* that returns does it run
`npm install` and (if install succeeded) `npm run build`. A `tsc` failure at
that point only sets `buildOutcome.buildOk = false` with the raw compiler
output attached as `failureOutput`; there is no code path from a build
failure back into `generateAndVerifyProject` or into any component
regeneration. Milestone 3's retry is triggered exclusively by a Blueprint
`Violation` found by `runApplicationJob`'s call into the verification
pipeline — never by a `tsc` diagnostic, which the retry loop never sees at
all.

**Update, 2026-09-14 — option (a) implemented, and confirmed by the same
live prompt to narrow, not eliminate, this limitation.** Two fixes landed:
every domain now mandates a single, enforced named-export convention
(`COMPONENT_CODE_SYSTEM_PROMPT` states it unconditionally; `EXPORT_CONTRACT`
fixes the exact identifier per domain — `router`, `middleware`, a sanitized
per-component identifier for frontend, database's existing named-function
convention), and — the actual structural fix — a consuming component's
generation context now carries `dependencyExports`: the real, already-
generated dependency file's actual exported names, extracted from its real
on-disk content (`extractNamedExports` in `component-codegen.ts`), never a
guess. Re-running the *exact same* live prompt ("a simple recipe box app for
saving favorite recipes with ingredients and steps") through the real
pipeline twice, post-fix, produced **zero** `TS2305`/`TS2614`
export-mismatch errors either time — the specific bug reproduced above is
confirmed closed.

**Both live re-runs still failed `npm run build`, on different, unrelated
errors** — exactly the outcome the "Concrete next step" below anticipated
when it proposed (a) and (b) as non-exclusive: narrowing the failure
surface, not guaranteeing a clean build, since a model can still write
incorrect code even when given correct interface information. Concrete
evidence from the same live run, both instances confirmed unrelated to
export/import shape:

```
backend/src/routes/recipe-api-service.ts(26,36): error TS2345: Argument of
type 'string' is not assignable to parameter of type 'number'.
frontend/src/main.tsx(17,8): error TS2741: Property 'recipeId' is missing
in type '{}' but required in type 'RecipeDetailViewProps'.
```

The first is an ordinary type-correctness bug inside one component's own
logic (a route handler passing a `string` where its own database function
declared a `number` parameter) — nothing to do with cross-file export
shape. The second is a different structural gap entirely: a frontend page
component declared a required prop (`recipeId`), but the templated entry
point (`frontendEntryPointFile` in `assemble.ts`) mounts every frontend
component with no props at all, an assumption the export-convention fix
does not touch and was never asked to. Neither was fixed in this pass —
doing so would be a different, unscoped change — but both are exactly the
class of failure a build-triggered retry (option (b) below) would attempt
to correct, and neither would have been caught before `npm run build` ran,
since Blueprint's import-graph check has no way to see either kind of
error.

**Concrete next step:** with (a) implemented, the one remaining option from
the original two, still not implemented — a decision for later, same
discipline as every other limitation on this page:

- **(b) Extend the retry mechanism to also fire on a build failure.** The
  same pattern Milestone 3 already proved for Blueprint violations — feed
  the actual `tsc` diagnostic (file, line, message) back to the specific
  component(s) it names as corrective context, regenerate once, re-run
  `npm run build`, hard-fail as a review item if it still fails — rather
  than treating `npm run build` as an unretried terminal check as it is
  today. The two errors above are direct, live evidence of what (b) would
  need to handle: a same-file type error (straightforward attribution, the
  diagnostic already names the one offending file) and a cross-file
  prop-contract mismatch between a generated component and a templated,
  non-LLM entry point (a kind of attribution this pipeline has not needed
  to solve yet, since every prior retry case involved two independently
  *generated* files, never a generated file against a templated one).

This fix touches code this project has deliberately not modified
mid-demo; this section exists to make the gap precise and discoverable,
not to resolve it.
