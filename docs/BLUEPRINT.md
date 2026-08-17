# Type-1: Blueprint-first authoring

Every prior week (Week 7's extraction, Week 8's conformance, the MCP surface)
answers "what does this repository's prose already say about its own
architecture?" Type-1 answers a different question: "what should the
architecture be, stated directly, before the code that would violate it
exists?"

**The blueprint is a proposal, never a source of truth. Code remains
authoritative at all times.** This project does not build round-trip
synchronisation between an authored diagram and the codebase — that is the
failure mode that killed UML and MDA, and reproducing it here would be the
same mistake with a nicer UI. The flow is one direction, closed by
measurement rather than by sync:

```
author intent -> compile to constraints -> hand to an agent as context -> verify with Type-2
```

The last step is not a separate feature. It is `node dist/cli.js .` running
again, and it is the whole architecture.

---

## Part A — authoring

A blueprint is written as a small DSL, one rule per line, deliberately
mirroring the prose Week 7's extractor already reads:

```
# comment
domain must not import infra
ui may only import shared via api
domain must not cycle
api must be layer above domain
```

Each line compiles through `src/blueprint/dsl.ts`'s `compileBlueprint` into
the **same `Constraint` shape** `conformance/compile.ts` produces from an
LLM extraction — same four relations, same `resolveSubject` phrase resolver,
same `scoreConfidence`, same content-derived id, same `provenance: 'STATED'`.
The one step that does not apply is compile.ts's "does this quote appear in
the source document" check: that check exists to catch a model fabricating
both a sentence and its presence in a README. A line a person typed by hand
has no document to have drifted from — they are the source — so
`quoteVerified` is always true and every other step is identical.

`ConstraintSource.type = 'user-authored'` is what actually distinguishes an
authored constraint from an extracted one downstream — never a parallel type,
never a second evaluator. `Constraint.provenance` is typed as the literal
`'STATED'`, so there is no code path, authored or extracted, that could ever
produce `'DERIVED'` here — rule 2 holds by construction, not convention.

**All three authoring modes are built, in priority order:**

1. **Constraint-based** (`--blueprint=<file>`) — built first. The DSL above.
2. **Start-from-current** (Part A.2) — `src/blueprint/seed.ts`.
3. **Visual node editing** (Part A.3) — the "Blueprint" tab in the UI.

### Part A.2 — start from current

`seedConstraintsFromDerived(clustering)` reads the module-edge graph clustering
already produced and proposes one `must-be-layer-above` candidate per module
pair whose coupling is currently one-directional — A imports B, B never
imports A. That direction already holds, so the candidate is "codify what is
true today," not a guess; pairs coupled in both directions are skipped, since
that is existing mutual coupling, not a clean boundary to propose.

**A seed is not a constraint until a person says so.** This is the sharpest
version of the unmeasured-zero risk Type-1 can produce: silently promoting
observed structure to stated intent would make conformance trivially true —
of course the graph satisfies a rule that was copied from the graph. Two
things hold this open, deliberately redundant with each other:

- Every seed's `source.type` is `'seeded-from-derived'`, a distinct value from
  `'user-authored'` — never a parallel `Constraint` shape, just a different
  source tag, checked by `src/blueprint/seed.test.ts`.
- `seed.ts` never writes to the store. `GET /api/blueprint/seeds` computes
  seeds fresh on every call and persists nothing. The only way a seed reaches
  the store — and therefore conformance, and therefore `check_import` — is
  `POST /api/blueprint/accept-seeds` naming its id explicitly, which appends
  through `BlueprintStore.append()` (id-keyed, never overwrites). An id that
  names nothing (typo, stale candidate, a bare empty list) is a no-op, not an
  error and not a promotion.

Confidence is weighted below every prose source (`SOURCE_WEIGHT['seeded-from-derived'] = 0.5`
in `conformance/confidence.ts`) — low enough that an unreviewed seed sits near
`CONFIDENCE_THRESHOLD` rather than sailing over it, the same "recorded, but
weak" signal a hedged sentence produces.

The UI surfaces this as `BlueprintSeedsPanel` — a checkbox list of candidate
rules with their confidence, an explicit "add to blueprint" action, and
nothing rendered as already-true.

### Part A.3 — the visual editor

The "Blueprint" tab replaces the graph canvas with a draggable one: derived
modules render as read-only, non-draggable boxes (`DERIVED`, blue-grey);
authored boxes are added, renamed in place, and removed freely (`STATED`,
violet) — the same colour Week 6's `IntentPanel` uses for a claim, on purpose,
since an authored node is exactly that. A drag from one box's handle to
another draws an edge; clicking the edge opens a small inspector to choose its
relation (`must not import` / `may only import … via` / `must be layer
above`) and, for the `via` relation, which node satisfies it. A checkbox per
node adds `must not cycle`.

**Every edit is sent to the server as a `BlueprintGraph` — plain nodes and
edges, no meaning of its own — and `src/blueprint/graph-to-dsl.ts`'s
`graphToDsl` is the only place that turns it into text.** That text is handed
to the exact same `compileBlueprint` a typed file goes through
(`POST /api/blueprint/compile`, `src/server/blueprint-api.ts`). The DSL panel
below the canvas shows whatever the server returned, verbatim — the component
never computes DSL text or a `Constraint` client-side, so there is no
graph-shaped compiler living beside `dsl.ts`'s to drift out of sync with it.
`graph-to-dsl.test.ts`'s acceptance tests assert this literally: build a
graph, serialise it, compile it; type the equivalent line, compile it;
`JSON.stringify` the two `Constraint[]` results and assert they are equal,
including the id. Dragging and typing are two ways to produce the same input
to one function, never two functions.

`Save` calls `POST /api/blueprint/save`, which compiles and then
`blueprintStore.replace()`s the whole store — same semantics as
`--blueprint=<file>`: the editor session is the file. A "Saved blueprint"
list, read back from the store, shows what the next run will actually check,
so editing the canvas is visibly distinct from having saved it.

**Derived edges are not drawn on this canvas.** They are facts, not
proposals — `ModuleCanvas` and `GraphCanvas` already show them — and since
they can never be edited, drawing them read-only here would add clutter
without adding capability. A derived *node* becomes visible only once an
authored edge touches it, and stays undraggable and unrenamable for the same
"derived facts are read-only, always" reason.

## Part B — compiling to an agent-consumable spec

`node dist/cli.js . --blueprint=blueprint.txt` writes two files into
`.vibe/`, regenerated on every authoring run rather than committed:

- **`.vibe/blueprint-spec.md`** — human-readable, one bullet per constraint,
  flags any role that failed to resolve, lists any line that failed to
  compile with its reason.
- **`.vibe/blueprint-constraints.json`** — machine-readable, and
  deliberately **just `Constraint[]`, serialised with no envelope specific to
  "blueprint"**. It is the same shape `IntentResult.constraints` carries.
  Nothing downstream can tell an authored constraint from an extracted one by
  its JSON shape — only by `source.type`.

## Part C — agent delivery (still read-only)

Authoring is a side effect of an ordinary run: `--blueprint=<file>` compiles
and **persists** the result (`src/store/blueprint-store.ts`, table
`blueprint_constraints`, whole-set replace — a line deleted from the file
must disappear from what an agent sees next, not linger). Every subsequent
run, `--blueprint` or not, MCP or not, merges the last-persisted set into
`intent.constraints` before anything downstream runs
(`src/blueprint/merge.ts`'s `mergeAuthoredConstraints`, called from
`pipeline/run.ts`). That single merge point is what makes the rest of the
system — `checkConformance`, `get_constraints`, `check_import` — unaware that
Type-1 exists; they already took `Constraint[]` and still do.

`src/mcp/*` was never touched to make this work, which is the point:

- `get_constraints` returns authored constraints alongside extracted ones,
  distinguished by `source.type`, because it already just serialises
  `context.intent.constraints`.
- `check_import` answers against authored constraints too, because it already
  just reads the same field.
- **No write path was added.** `src/architecture.test.ts` still asserts
  `src/mcp` reaches no socket and no store — those tests were not modified,
  because nothing under `src/mcp` needed to change. An agent calling
  `check_import` cannot author, edit, or delete a blueprint constraint; it
  can only ask whether one forbids the import it is about to write.

The writable surface Parts A.2 and A.3 need lives entirely in
`src/server/blueprint-api.ts`, reached only through the local HTTP server a
human's browser talks to — never through MCP:

| Route | Effect |
|---|---|
| `GET /api/blueprint` | Reads the persisted blueprint. No write. |
| `GET /api/blueprint/seeds` | Computes candidates fresh from `clustering`. No write. |
| `POST /api/blueprint/compile` | Compiles `{ dsl }` or `{ graph }` — preview only, no write. |
| `POST /api/blueprint/accept-seeds` | The only route that can turn a seed into a stored constraint. |
| `POST /api/blueprint/save` | Compiles and `replace()`s the whole store — same as `--blueprint=<file>`. |

Two of five routes write, and both write only to `blueprintStore` — never to
`intent`, `conformance`, or the graph, which all still reflect the run that
already finished. `context.blueprintStore` exists on `AnalysisContext` (see
`src/server/context.ts`) precisely so this stays true: the MCP context is
built from the same type and could in principle reach the store, but
`src/mcp/tools.ts` never imports `blueprint-api.ts` and never calls it — the
read-only guarantee is what `architecture.test.ts` checks, not what this
paragraph asserts.

## Part D — the verification loop

There is no separate "verify" command, on purpose. After an agent generates
code against a blueprint:

```
node dist/cli.js .
```

Re-runs the deterministic Type-2 pipeline, merges the persisted blueprint
back in, and reports conformance — which authored constraints held, which
were violated, with `file:line` evidence, exactly like any Week 8 violation.
This is the only honest claim available: the tool does not control what an
agent writes, so it does not claim compliance from the blueprint alone — the
spec markdown says as much in its own header. It measures what was actually
written, the same way it always has.

---

## Named validation case: `check_import` against a hand-authored rule

The clearest single expression of this project's thesis, kept from living
only in a session log the way DRIFT.md's deferred item 1 asked of the zod
reproduction. Pinned as `src/blueprint/check-import-demo.test.ts` against a
checked-in fixture (`src/blueprint/fixtures/check-import-demo/`), so it is
re-runnable rather than a one-time transcript: `npx vitest run
src/blueprint/check-import-demo.test.ts`.

The fixture is two one-file directories:

```
api/a.ts    import { b } from '../db/b';
db/b.ts     export const b = 1;
blueprint.txt   api must not import db
```

Authoring it against the real pipeline, exactly as `--blueprint=<file>` does:

```
$ node dist/cli.js . --blueprint=blueprint.txt
  ...
  Conformance         1 of 1 constraint(s) checked
    satisfied         0
    violated          1
  Violations          1  (1 high, 0 medium, 0 low)  across 1 edge(s)
    [high] api imports db in 1 file(s), across 1 import statement(s). The documentation says it must not.
           rule: "api must not import db"
           from: .../blueprint.txt:1
           api/a.ts:1  import { b } from '../db/b';
```

Then, over a live `node dist/cli.js . --mcp` stdio session, before any code
that would satisfy the rule was ever generated:

```json
// tools/call get_constraints
{
  "constraints": [{
    "id": "f54c130eca4fa702",
    "relation": "must-not-import",
    "subject": { "phrase": "api", "status": "MODULE", "target": "module-000" },
    "object": { "phrase": "db", "status": "MODULE", "target": "module-000" },
    "rawText": "api must not import db",
    "source": { "type": "user-authored", "location": ".../blueprint.txt", "line": 1 },
    "provenance": "STATED"
  }]
}

// tools/call check_import { from: "api/a.ts", to: "db/b.ts" }
{
  "verdict": "forbidden",
  "findings": [{
    "constraintId": "f54c130eca4fa702",
    "relation": "must-not-import",
    "explanation": "Importing db/b.ts from api/a.ts would create exactly the dependency this rule forbids.",
    "rawText": "api must not import db",
    "source": { "location": ".../blueprint.txt", "line": 1 },
    "provenance": "STATED"
  }],
  "explanation": "Forbidden. Importing db/b.ts from api/a.ts would create exactly the dependency this rule forbids. The documentation says: \"api must not import db\" (.../blueprint.txt:1).",
  "provenance": "COMPARISON"
}
```

`src/blueprint/check-import-demo.test.ts` pins both halves of this — the
`"forbidden"` verdict for the direction the rule forbids, and `"allowed"` for
the direction it does not (`db/b.ts -> api/a.ts`), which the manual stdio
session above did not separately exercise and the test now covers.

**What this case does and does not establish.** It proves the mechanism runs
end to end on a real pipeline execution — walk, parse, cluster, resolve,
compile, MCP — not just in unit fixtures with hand-built `Constraint`
objects. It does **not** carry zod's kind of evidentiary weight: the fixture
is two files this project wrote for the purpose, not ground truth from an
author who had never heard of the tool. See docs/PAPER-OUTLINE.md's Type-1
section for how that distinction should be stated in the paper — a
demonstrated mechanism, not a validated intervention.

---

## Acceptance, verified

- **Same path, no parallel system (Part A.1).** `src/blueprint/acceptance.test.ts`
  compiles one rule by hand (`compileBlueprint`) and the same rule through
  the extraction path (`compileCandidates`), runs both through the single
  `detectViolations` call, and asserts the same violation shape — evidence,
  relation, edge — for both.
- **Same path, no parallel system (Part A.3).** `src/blueprint/graph-to-dsl.test.ts`'s
  acceptance suite builds a `BlueprintGraph`, serialises it with `graphToDsl`,
  and asserts the resulting text is *string-identical* to the equivalent
  typed DSL line — then compiles both and asserts the `Constraint[]` output
  is `JSON.stringify`-identical, including the id. Covers all four relations
  and a multi-line graph. `src/server/blueprint-api.test.ts` repeats the
  check one layer up, through `compileRequest` with a `{ graph }` body versus
  a `{ dsl }` body.
- **Seeds require explicit acceptance, never auto-apply.**
  `src/blueprint/seed.test.ts` asserts every seed carries
  `source.type === 'seeded-from-derived'` and never `'user-authored'`.
  `src/server/blueprint-api.test.ts` and `server.test.ts`'s Type-1 route
  suite both assert the store stays empty after merely listing seeds, stays
  empty after "accepting" an id that names nothing, and gains exactly the
  named constraint — correctly tagged `seeded-from-derived` — after a real
  accept.
- **Full loop, for real (Part A.1).** `src/cli/run.test.ts`'s `--blueprint`
  suite authors a rule against a two-file fixture repo with a real violating
  import, confirms the violation appears in the CLI's own JSON output on the
  authoring run, confirms it is still there on a *later* run that omits
  `--blueprint` (persistence), and confirms a malformed line is reported
  rather than crashing the run.
- **Full loop, for real (Parts A.2/A.3, browser-verified).** Driven live
  against a running server with Playwright: opened the Blueprint tab, added
  two authored nodes, renamed them by typing, drag-connected an edge, watched
  the live DSL panel update to the exact typed-equivalent text, saved, saw
  the confirmation notice, reloaded the page, and confirmed the saved
  constraint was still listed — zero console errors throughout. CLAUDE.md's
  "start the dev server and use the feature in a browser" bar, met before
  this was called done.
- **The MCP payoff, pinned.** `src/blueprint/check-import-demo.test.ts` — the
  named validation case above — calls the exact `checkImport` function the
  MCP server exposes, against a hand-authored rule, run through the real
  pipeline. `"forbidden"` for the direction the rule forbids, `"allowed"` for
  the direction it does not.
- **Provenance holds on the shared canvas.** `Constraint.provenance` is the
  literal type `'STATED'` — there is no assignment anywhere that could
  produce `'DERIVED'` for an authored *or* seeded constraint, and
  `architecture.test.ts`'s rule-2 suite was not touched because nothing about
  it needed to be. On the visual canvas itself, a derived node's `draggable`
  and `connectable`-as-a-rename-target properties are hard-set `false` in
  `BlueprintCanvas.tsx` — there is no interaction path that edits one.
- **Determinism holds.** `dsl.test.ts` compiles the same blueprint text twice
  and asserts byte-identical output, including constraint ids and their
  order (sorted by id, same convention as `compile.ts`); `seed.test.ts` does
  the same for `seedConstraintsFromDerived`; `graph-to-dsl.test.ts` does the
  same for a fixed `BlueprintGraph`.

## What is explicitly out of scope, still

- No code generation by this tool, ever, blueprint or not.
- No syncing derived changes back into an authored blueprint — a blueprint is
  never re-written by a run, only read and compared against.
- **All three authoring modes from the original brief are now built.** Per
  the brief's own closing instruction, this is where Type-1's buildable scope
  ends: the remaining gap — no corpus of real authored blueprints, no user
  study of whether `check_import` changes what an agent writes — cannot be
  closed by more code, and `docs/PAPER-OUTLINE.md` already states it
  correctly as a demonstrated mechanism rather than a validated intervention.
