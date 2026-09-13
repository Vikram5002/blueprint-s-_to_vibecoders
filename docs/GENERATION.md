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
