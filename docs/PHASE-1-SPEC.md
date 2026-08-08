# Phase 1 Specification (Weeks 1-4)

**Milestone:** `npx vibe-blueprint .` opens a browser showing a real, correct dependency
graph of any TypeScript, JavaScript or Python repository.

**Not in Phase 1:** no LLM calls, no clustering, no conformance checking, no intent
extraction, no drift scoring. Phase 1 is purely deterministic. If it is not in the list
below, do not build it yet.

---

## Week 1 — CLI scaffold and repository ingest

**Deliverable:** the command runs and correctly lists the files it would analyse.

- [x] Project setup: TypeScript strict, vitest, ESLint, build to `dist/`
- [x] `bin` entry so `npx vibe-blueprint .` works
- [x] Argument parsing: target path, `--json`, `--verbose`, `--no-open`
- [x] Repository walker
  - [x] Respect `.gitignore` (use the `ignore` package; do not hand-roll this)
  - [x] Always skip `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `.venv`
  - [x] Language detection by extension: `.ts .tsx .js .jsx .mjs .cjs .py`
  - [x] Handle symlinks safely (do not follow outside the repo root)
- [x] Terminal output with progress lines and a file-count summary
- [x] Tests: walker respects gitignore; walker handles an empty repo; walker handles a repo
      with no supported files

**Acceptance:** run against three real open-source repos (one TS, one Python, one mixed) and
confirm the file list matches expectation.

**Acceptance met.** Verified by diffing the walker's output against `git ls-files`, filtered
to the supported extensions and minus the always-skipped directories:

| Repo | Kind | Files | Walker vs `git ls-files` | Walk time |
|---|---|---|---|---|
| `colinhacks/zod` | TypeScript | 406 | exact match | 91 ms |
| `psf/requests` | Python | 37 | exact match | 38 ms |
| `microsoft/pyright` | mixed TS + Python | 1,917 | exact match | 930 ms |

Zero missed files, zero spurious files, zero read errors. Gitignore decisions were separately
cross-checked against `git check-ignore` on a real repo.

---

## Week 2 — tree-sitter parsing for TypeScript and JavaScript

**Deliverable:** every TS/JS file produces a symbol table.

- [x] Integrate `web-tree-sitter` and load the TS/JS grammars
- [x] Per-file parse producing:
  - [x] Imports: specifier, imported names, line number, raw text
  - [x] Exports: exported symbol names
  - [x] Handle `import`, `export ... from`, `require()`, dynamic `import()`
- [x] **Error tolerance:** a file that fails to parse is logged and skipped, never fatal.
      Track the failure count and surface it in the summary.
- [ ] ~~Parse in parallel across a worker pool; cap concurrency at CPU count~~ — **not needed,
      see measurement below.** Deliberately skipped rather than forgotten.
- [x] Tests: fixture files covering each import form, plus one deliberately broken file

**Acceptance:** parse a mid-sized TS repo (~500 files) in under 10 seconds with zero crashes.

**Acceptance met, single-threaded.**

| Repo | TS/JS files parsed | Parse time | Budget | Crashes |
|---|---|---|---|---|
| `colinhacks/zod` | 406 | **1.06 s** | 10 s | 0 |
| `microsoft/pyright` | 591 | **2.93 s** | 10 s | 0 |

zod comes in **9.4× under budget** on one thread, on a 16-core machine. A worker pool
would add process management, serialisation of the symbol table across the boundary, and a
much harder failure mode — to save a second we do not need. Revisit only if a real repo
misses the target.

Grammars are vendored in `grammars/` (3.6 MB, four files) rather than pulled from a package
shipping 17–44 MB of languages this project forbids. Provenance, licences and two known
grammar gaps are recorded in `grammars/README.md`.

Beyond the spec: type-only imports (`import type`, inline `{ type A }`) and
`import x = require()` are extracted and distinguished, since Week 3 needs to tell an
erased type dependency from a runtime one.

---

## Week 3 — Python grammar and import resolution

**Deliverable:** a complete file-level dependency graph with evidence on every edge.

- [ ] Add the Python grammar; extract `import x`, `from x import y`, relative imports
- [ ] **Resolver** (this is the hard part of Phase 1):
  - [ ] TS/JS: relative paths, `tsconfig.json` path aliases, extension inference
        (`./foo` → `foo.ts`, `foo/index.ts`), bare specifiers → mark external
  - [ ] Python: package root detection via `__init__.py`, relative import levels,
        stdlib and site-packages → mark external
  - [ ] Record unresolved imports with a reason; do not silently drop them
- [ ] Build the graph in `graphology`: file nodes, import edges
- [ ] **Every edge carries `evidence[]`** with file, line and snippet
- [ ] Report resolution rate in the summary (e.g. "3,902 edges, 97.2% resolved")
- [ ] Tests: resolver fixtures for each case above, including path aliases and relative
      Python imports

**Acceptance:** resolution rate above 95% on three real repos. Investigate anything lower —
it usually indicates a resolver bug, not a messy repo.

---

## Week 4 — Local server and graph rendering

**Deliverable:** Milestone 1. The browser shows the real graph.

- [ ] Local HTTP server bound to `127.0.0.1` on a free port
- [ ] JSON API: `GET /api/graph` returns nodes and edges; `GET /api/node/:id` returns detail
      including evidence
- [ ] React + Vite app in `ui/`, built into `src/server/static`
- [ ] React Flow rendering with:
  - [ ] Directory-based initial layout (full clustering comes in Phase 2)
  - [ ] Click a node → side panel with file list and its edges
  - [ ] Click an edge → show the evidence lines that produced it
  - [ ] Zoom, pan, fit-to-view
- [ ] Auto-open browser on start unless `--no-open`
- [ ] Graceful shutdown on Ctrl+C

**Acceptance:** run on an unfamiliar repository and be able to answer "what depends on what?"
purely from the visualisation, with every edge traceable to a source line.

---

## Phase 1 definition of done

1. Works on TypeScript, JavaScript and Python repositories
2. Handles a 5,000-file repo in under 60 seconds
3. Survives broken and unparseable files without crashing
4. Every edge is traceable to a real file and line number
5. Import resolution rate above 95% on real-world repositories
6. Unit tests pass for walker, parser and resolver
7. A single command takes a user from nothing to a rendered graph

---

## Suggested build order within each week

Build the deterministic core first and the UI last. The UI is the most tempting thing to
start with and the least useful early — a correct graph with no UI is valuable, while a
beautiful UI over a wrong graph is worse than nothing.

Write the resolver tests *before* the resolver. It is the component most likely to be subtly
wrong, and subtle resolver bugs will silently corrupt every downstream result in Phases 2
and 3.
