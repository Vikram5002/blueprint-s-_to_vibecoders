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

**Two authoring modes are built; one is deliberately not:**

1. **Constraint-based** (`--blueprint=<file>`) — built first, per the
   priority order. This is the whole of Part A today.
2. **Start-from-current** — not yet built. Loading the derived architecture
   as a starting point to edit is more useful than a blank canvas, but it
   needs a visual or semi-visual surface to be worth having; see below.
3. **Visual node editing** — explicitly deferred. Most work, least essential,
   built last per the spec's own ordering. Nothing here blocks it: it would
   ultimately still emit DSL text or `Constraint[]` through the same
   `compileBlueprint`/store path.

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

## Worked example

```
$ cat blueprint.txt
api must not import db

$ node dist/cli.js . --blueprint=blueprint.txt
  ...
  Conformance         1 of 1 constraint(s) checked
    satisfied         0
    violated          1
  Violations          1  (1 high, 0 medium, 0 low)  across 1 edge(s)
    [high] api imports db in 1 file(s) ... The documentation says it must not.
           rule: "api must not import db"

$ node dist/cli.js . --mcp
```

An agent's `check_import({ from: "api/a.ts", to: "db/b.ts" })` over that MCP
session returns `"verdict": "forbidden"`, citing the authored rule and its
`blueprint.txt:1` location — before the import line exists, from a rule the
user wrote, through the exact same conformance engine as everything else in
this document.

---

## Acceptance, verified

- **Same path, no parallel system.** `src/blueprint/acceptance.test.ts`
  compiles one rule by hand (`compileBlueprint`) and the same rule through
  the extraction path (`compileCandidates`), runs both through the single
  `detectViolations` call, and asserts the same violation shape — evidence,
  relation, edge — for both.
- **Full loop, for real.** `src/cli/run.test.ts`'s `--blueprint` suite
  authors a rule against a two-file fixture repo with a real violating
  import, confirms the violation appears in the CLI's own JSON output on the
  authoring run, confirms it is still there on a *later* run that omits
  `--blueprint` (persistence), and confirms a malformed line is reported
  rather than crashing the run. A live MCP session was also driven by hand
  over stdio during development: `get_constraints` returned the authored
  rule, and `check_import` returned `"forbidden"` citing it.
- **Provenance holds.** `Constraint.provenance` is the literal type
  `'STATED'` — there is no assignment anywhere that could produce
  `'DERIVED'` for an authored constraint, and `architecture.test.ts`'s rule-2
  suite was not touched because nothing about it needed to be.
- **Determinism holds.** `dsl.test.ts` compiles the same blueprint text twice
  and asserts byte-identical output, including constraint ids and their
  order (sorted by id, same convention as `compile.ts`).

## What is explicitly out of scope, still

- No code generation by this tool, ever, blueprint or not.
- No syncing derived changes back into an authored blueprint — a blueprint is
  never re-written by a run, only read and compared against.
- The visual editor (Part A.3) and start-from-current (Part A.2) remain
  unbuilt. Both are additive on top of the same `Constraint[]`/store path
  built here, not a redesign of it.
