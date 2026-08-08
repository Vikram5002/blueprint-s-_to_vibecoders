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

- [x] Add the Python grammar; extract `import x`, `from x import y`, relative imports
- [x] **Resolver** (this is the hard part of Phase 1):
  - [x] TS/JS: relative paths, `tsconfig.json` path aliases, extension inference
        (`./foo` → `foo.ts`, `foo/index.ts`), bare specifiers → mark external
  - [x] Python: package root detection via `__init__.py`, relative import levels,
        stdlib and site-packages → mark external
  - [x] Record unresolved imports with a reason; do not silently drop them
- [x] Build the graph in `graphology`: file nodes, import edges
- [x] **Every edge carries `evidence[]`** with file, line and snippet
- [x] Report resolution rate in the summary (e.g. "3,902 edges, 97.2% resolved")
- [x] Tests: resolver fixtures for each case above, including path aliases and relative
      Python imports

**Acceptance:** resolution rate above 95% on three real repos. Investigate anything lower —
it usually indicates a resolver bug, not a messy repo.

**Acceptance met.**

| Repo | Kind | Files | Nodes / edges | Imports | Unresolved | Rate |
|---|---|---|---|---|---|---|
| `colinhacks/zod` | TypeScript | 406 | 406 / 721 | 1,088 | 4 | **99.63%** |
| `psf/requests` | Python | 37 | 37 / 105 | 311 | 1 | **99.68%** |
| `microsoft/pyright` | mixed | 1,917 | 1,917 / 2,429 | 4,284 | 28 | **99.35%** |

Every remaining unresolved import was inspected. None is a resolver defect:

- **zod (4):** a stylesheet, a build-generated module, two PNGs — non-source assets.
- **requests (1):** `requests.packages.urllib3.poolmanager`, a runtime module-aliasing
  shim that has no static target by construction.
- **pyright (28):** 18 non-source or build-output paths (`package.json`,
  `.nls.*.json` locale files, `build/lib/webpack`), 8 references to build artefacts absent
  from a fresh clone, and 2 Python test *samples* that deliberately import nothing real.

**The spec's advice was right — a low rate was a resolver bug.** zod first measured
**82.08%**, and the unresolved-by-reason grouping pointed straight at the cause: 194 of 195
failures were `alias-target-missing` on `zod/v4`, `zod/v3`, `zod/mini`. Those are workspace
subpaths declared through package.json `exports`, which the resolver did not follow.
Fixing it took internal imports from 559 to **750** — 191 cross-package edges had been
missing from the graph. The rate alone looked like a messy repo; the reason grouping made it
a ten-minute diagnosis, which is exactly what that grouping is for.

Three states are enforced, not blurred. EXTERNAL requires positively identifying an npm
package, Node builtin, Python stdlib or site-packages module. Anything that merely failed to
resolve stays UNRESOLVED, including a Python module whose top-level name exists in the repo
and a tsconfig alias whose target is missing — both would otherwise inflate the rate while
hiding the bug that caused them. `target-not-in-repo` marks a real file the walker does not
index (JSON, CSS, assets); it is kept out of the rate rather than counted as a success.

Beyond the spec: PEP 420 namespace packages resolve without `__init__.py` (the spec's
`__init__.py`-only rule would have failed every modern namespace package), pnpm and npm
workspaces resolve to real files, and `exports` maps are followed to source rather than to
`dist/`.

---

## Week 4 — Local server and graph rendering

**Deliverable:** Milestone 1. The browser shows the real graph.

- [x] Local HTTP server bound to `127.0.0.1` on a free port
- [x] JSON API: `GET /api/graph` returns nodes and edges; `GET /api/node/:id` returns detail
      including evidence
- [x] React + Vite app in `ui/`, built into `src/server/static`
- [x] React Flow rendering with:
  - [x] Directory-based initial layout (full clustering comes in Phase 2)
  - [x] Click a node → side panel with file list and its edges
  - [x] Click an edge → show the evidence lines that produced it
  - [x] Zoom, pan, fit-to-view
- [x] Auto-open browser on start unless `--no-open`
- [x] Graceful shutdown on Ctrl+C

**Acceptance:** run on an unfamiliar repository and be able to answer "what depends on what?"
purely from the visualisation, with every edge traceable to a source line.

**Acceptance met.** Measured by driving a real browser against each repository — launch,
click an edge, click a node, zoom, pan, fit, expand a directory.

| Repo | Files | Default view | First paint | Fully rendered | Edge → evidence | Node → panel | Expand | Zoom | Pan | Fit |
|---|---|---|---|---|---|---|---|---|---|---|
| requests | 37 | 6 nodes, 3 edges | 465 ms | 722 ms | 38 ms | 19 ms | 36 ms | 32 ms | 88 ms | 26 ms |
| zod | 406 | 45 nodes, 74 edges | 338 ms | 601 ms | 42 ms | 38 ms | 53 ms | 40 ms | 87 ms | 28 ms |
| pyright | 1,917 | 61 nodes, 98 edges | 369 ms | 627 ms | 62 ms | 65 ms | 78 ms | 42 ms | 94 ms | 30 ms |

Every interaction is under 100 ms on all three, including pyright. Full sessions produce
zero non-OK responses and zero console errors.

**The scale constraint decided the architecture, and it held.** Directory aggregation takes
pyright from 1,917 nodes to 61 — a 31× reduction with nothing lost, since every aggregate
edge keeps the file-level edges beneath it. Layout is computed once on the server; the
browser only draws. Render time is effectively flat across a 52× range of repository size.

One gap the benchmark caught: the default view was safe but a single click was not.
Expanding pyright's 1,279-file test-samples directory produced 1,339 nodes. Directories over
300 files are no longer offered for expansion, capping the worst case at about 323 nodes.

**Four defects were only findable by running it.** Nodes were unselectable on pyright,
because React Flow's fixed-size connection handles cover a node shrunk to 34×12px at
fit-to-view. The evidence panel — the point of the product — rendered import statements one
character wide. Clicking the repository-root directory always 404'd, because a `.` path
segment is normalised out of a URL before it is sent. And missing assets returned the HTML
shell with a 200. The test suite was green throughout; none of these are visible without a
browser.

The evidence trail is the deliverable, and it is checkable end to end: clicking the heaviest
pyright edge lists 62 import statements across 62 file pairs, each quoted with its file and
line, e.g. `packages/pyright-internal/src/typeServer/enums.ts:16` →
`import { VariableDeclaration } from '../analyzer/declaration';`.

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
