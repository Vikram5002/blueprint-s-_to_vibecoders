# Vibe-Code Blueprint

A local-first CLI tool that reads a codebase, derives its actual architecture, and measures
that against the architecture the developer (or their AI agent) *said* they were building.

**Core principle: this tool measures. It never generates code.**

---

## Current status

**Phase 1 (Weeks 1-4): complete.** `npx vibe-blueprint .` produces a real dependency
graph of any TS/JS/Python repo, rendered in a browser. Resolution 99.3-99.7% on the
three reference repositories.

**Phase 2 (Weeks 5-7): complete.** Clustering, LLM labelling with user corrections,
and intent extraction — the STATED half of the data model.

**Weeks 8-11: complete.** Violation detection, versioning and drift, the violation UI,
and the agent-facing surfaces — a read-only MCP server (`--mcp`) whose `check_import`
answers "am I allowed to import this?" *before* the line is written, plus regenerated
`AGENTS.md` and a self-contained HTML report (`--export`).

**Type-1 (Blueprint-first authoring): complete, all three authoring modes.**
`--blueprint=<file>` compiles a small DSL ("domain must not import infra") into
the same `Constraint` shape extraction produces, persists it, and merges it into
every run — CLI, JSON, MCP — so `check_import` can answer against a rule a
person wrote before any code violating it exists (Part A.1). Start-from-current
(Part A.2) proposes candidate rules from the module boundaries that already
hold, requiring explicit accept before any candidate is checked. The visual
editor (Part A.3) is a "Blueprint" tab in the UI — drag-and-drop nodes and
edges that compile through the identical DSL compiler, live preview, provenance
kept visually distinct on the shared canvas. Buildable scope for Type-1 is now
complete per its own brief; see `docs/BLUEPRINT.md`. PHP joined TS/JS/Python as
a supported language after both reference corpora were collected.

See `docs/PHASE-1-SPEC.md` for the full tracker, week by week.
See `docs/ARCHITECTURE.md` for the data model and full pipeline.
Per-stage detail: `CLUSTERING.md`, `LABELLING.md`, `CORRECTIONS.md`, `PROVIDERS.md`,
`INTENT.md`, `VIOLATIONS.md`, `DRIFT.md`, `MCP.md`, `BLUEPRINT.md`.
See `docs/PAPER-OUTLINE.md` for the section structure, which numbers are citable
as-is, and what remains unmeasured.
See `docs/FINDINGS.md` for the consolidated, numbered evidence index — the
paper's discussion-section material in one place.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 20+, TypeScript (strict) | Single distribution via `npx` |
| Parsing | `web-tree-sitter` + TS/JS/Python grammars | Error-tolerant; must handle broken code |
| Graph | `graphology` + `graphology-communities-louvain` | Clustering and traversal |
| Storage | `better-sqlite3` | Local file at `.vibe/blueprint.db` |
| Server | `hono` (or `express`) | Local only, binds to 127.0.0.1 |
| UI | React 18 + Vite + React Flow | Separate `ui/` package |
| LLM | Provider-agnostic adapter, user's own API key | Gemini (default), Bluesminds, Anthropic. Never bundled |
| Testing | `vitest` | Unit tests on parser and graph logic are mandatory |

---

## Repository structure

```
src/
  cli/          Command entry, argument parsing, terminal output
  ingest/       Repo walking, .gitignore handling, language detection
  parser/       tree-sitter wrappers, AST -> symbol extraction
  graph/        Dependency resolution, graph building, clustering
  pipeline/     Stage orchestration: runs the deterministic half, then the LLM
  llm/          Provider adapters, prompt templates (labelling + intent)
  conformance/  Constraint model, intent extraction, violation detection
  blueprint/    Type-1 blueprint-first authoring: DSL compiler, seeding, visual-editor support
  workflow/     Layer 2: prompt -> ProjectSchema generation, domain-dependency constraint compiler
  store/        SQLite schema, snapshots, migrations
  server/       Local HTTP + JSON API for the UI
  mcp/          Read-only MCP server (check_import, get_architecture, get_violations, get_constraints)
  export/       AGENTS.md and self-contained blueprint.html export
  types/        Shared type definitions
ui/             React app (separate package, built into src/server/static)
docs/           ARCHITECTURE.md, PHASE-1-SPEC.md, and topic-specific docs per stage — see the index above
```

---

## Architectural rules (non-negotiable)

These are the constraints this project would enforce on itself. Do not violate them.

1. **`parser/` and `graph/` must NEVER import from `llm/`.**
   This is the determinism boundary. Stages 1-2 of the pipeline are fully deterministic.
   The LLM only names clusters and reads intent from prose. It never creates or modifies
   graph structure. A single hallucinated dependency edge destroys user trust permanently.

2. **Every `Node` and `Edge` must carry a `provenance` field**, set to `DERIVED` (traced to a
   real import statement in a real file) or `STATED` (claimed in prose). Never mix them.

3. **Every `Edge` must carry `evidence[]`** — the file path and line number that produced it.
   If you cannot point at the source line, do not create the edge.

4. **`ui/` must not import from `src/` directly.** All access goes through the JSON API in
   `server/`. The UI is a client, not a coupled module.

5. **`cli/` must not contain business logic.** It parses arguments, calls into the pipeline,
   and formats output. Nothing else.

6. **No network calls outside `llm/`.** Everything else is local.

---

## Conventions

- TypeScript strict mode. No `any` — use `unknown` and narrow.
- Named exports only. No default exports.
- Errors: return `Result<T, E>` style unions in the pipeline. Throw only at the CLI boundary.
- Every pipeline stage takes typed input and returns typed output. No hidden mutation.
- File names: kebab-case. Types and classes: PascalCase. Functions and variables: camelCase.
- Keep functions under ~50 lines. If longer, it is doing two things.
- Tests live next to the code as `*.test.ts`.

---

## Commands

**Setup requires TWO install commands, not one.** This is a single-package repo, not an
npm workspace — `ui/` has its own `package.json` and lockfile, entirely separate from the
root. `npm install` at the repo root only installs `src/`'s dependencies; it does **not**
touch `ui/node_modules`.

```bash
npm install                 # root - installs src/ dependencies
npm --prefix ui install     # ui/ - installs the UI's own dependencies (or: cd ui && npm install)
```

Skipping the second command fails silently — no error at install time. The failure shows
up the first time you run `npm run dev` inside `ui/`, which crashes immediately with:

```
Failed to load PostCSS config: ... Cannot find module 'tailwindcss'
```

If you hit that exact error, this is the cause: run `npm --prefix ui install` and retry.

```bash
npm run dev          # Watch mode
npm run build        # Compile TS + build UI
npm test             # Run vitest
npm run lint         # ESLint + tsc --noEmit
node dist/cli.js .   # Run against current directory
```

---

## What NOT to do

- **Do not add code generation.** Not now, not later. This tool reads and measures only.
- **Language support is TypeScript, JavaScript, Python, and PHP.** PHP was added after both
  reference corpora were collected (see docs/FINDINGS.md). Adding further languages beyond
  these four remains out of scope — language sprawl is the main way a solo project fails to
  ship.
- **Do not send file contents to the LLM in bulk.** Send the *graph*. A 100k-file repo has
  ~200 modules; send 200 labelled nodes. Code snippets go only for the single cluster being
  labelled.
- **Do not add authentication, cloud sync, or multi-user features.** This is local-first.
- **Do not add a visual drag-and-drop editor.** Out of scope for the MVP.
- **Do not install heavy dependencies** without asking. Startup time matters for a CLI.
- **Do not let the LLM infer structure** when static analysis can determine it. Always prefer
  the deterministic path.

---

## Design notes worth remembering

- **Clustering will be imperfect, and that is acceptable.** Target "good enough that the user
  wants to argue with it." A wrong-but-close diagram that takes two minutes to correct beats a
  blank canvas. Build the correction UI early and persist corrections.
- **Prefer partial results over failure.** If one file fails to parse, log it and continue.
  Vibe-coded repos contain broken code by definition; the tool must survive it.
- **Performance target:** under 60 seconds for a 5,000-file repository on a laptop.

## Git commit policy

Commit at every meaningful step. Do not batch a week's work into one commit.

**A meaningful step is a unit that could be reviewed or reverted on its own:**
- A grammar or dependency vendored and loading
- A single extractor or resolver rule working
- A set of test fixtures added
- A bug fixed
- A refactor completed
- A metric or report added

**Rules:**
- Never mix a refactor with a feature in one commit.
- Tests go in the same commit as the code they cover, or the commit before.
- Never commit a state where `npm test` fails.
- Commit before starting anything you might want to undo.
- Push after each commit, not once at the end.

**Format:** Conventional Commits.
`feat(parser): extract dynamic import() specifiers`
`fix(ingest): handle symlinks pointing outside repo root`
`test(resolver): add tsconfig paths alias fixtures`
`chore(grammars): vendor tree-sitter-python 0.23.6`

Expect roughly 6–12 commits per week of work. If a week produced 2 commits,
the granularity was wrong.