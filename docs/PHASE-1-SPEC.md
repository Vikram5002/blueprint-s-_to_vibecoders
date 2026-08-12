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

Measured on the three reference repositories (requests, zod, pyright) on
2026-08-09.

- [x] **1. Works on TypeScript, JavaScript and Python repositories**
      — all three parse and resolve; pyright is TS, requests is Python, zod is TS.
- [x] **2. Handles a 5,000-file repo in under 60 seconds**
      — **measured, not extrapolated.** `angular/angular` at depth 1: **6,976
      analysed files, 22,480 imports, 201 modules, in 39.3 s** (second run;
      42.9 s cold). That is 40% more files than the target, in two thirds of the
      budget. Full deterministic pipeline — walk, parse, resolve, graph, cluster
      — plus the no-key label and intent paths, measured as wall clock including
      process startup. Resolution 97.3%, so it also clears criterion 5 on a
      fourth repository.
- [x] **3. Survives broken and unparseable files without crashing**
      — 36 files with syntax errors in pyright and 4 in zod, all recovered with
      partial symbols; no run aborted.
- [x] **4. Every edge is traceable to a real file and line number**
      — enforced by test, not convention: `architectural rules > gives every edge
      non-empty evidence pointing at a real line (rule 3)`.
- [x] **5. Import resolution rate above 95% on real-world repositories**
      — requests 99.7%, zod 99.6%, pyright 99.3%.
- [x] **6. Unit tests pass for walker, parser and resolver**
      — 538 tests across 35 files.
- [x] **7. A single command takes a user from nothing to a rendered graph**
      — `npx vibe-blueprint .` walks, parses, clusters, labels, reads intent and
      serves the UI.

---

## Phase 2 progress

Phase 2 was not specified in this document when it was written. Recorded here so
there is one tracker rather than three.

### Week 5 — clustering — **complete**
- [x] Louvain community detection over import coupling, seeded and deterministic
- [x] Content-derived cluster ids, stable across runs
- [x] Directory prior for files with no imports either way
- [x] Small-cluster merging
- [x] Stability measurement: adjusted Rand index and Jaccard overlap
- [x] Modularity reported as a diagnostic, explicitly not a quality score

See `docs/CLUSTERING.md`.

### Week 6 — LLM labelling and user corrections — **complete**
- [x] Provider-agnostic adapter, response cache, cost reporting
- [x] Three label provenance states: mechanical, model, user — visually distinct
- [x] SQLite corrections store: rename, merge, split
- [x] Jaccard matching with three honest outcomes: applied, drifted, orphaned
- [x] Determinism: labelling on or off produces byte-identical structure
- [ ] Haiku/Sonnet label comparison — **pending**, needs `ANTHROPIC_API_KEY`

See `docs/LABELLING.md` and `docs/CORRECTIONS.md`.

### Week 6a — Gemini provider — **complete**
- [x] Gemini adapter, quota-aware retry, key never logged
- [x] Gemini the default (free); Anthropic wired and one variable away
- [x] Measured on all three repos: 6/6, 19/19, 46/46 modules labelled at $0

See `docs/PROVIDERS.md`.

### Week 7 — intent extraction — **complete**
- [x] Four-relation constraint model, STATED provenance, never mixed with DERIVED
- [x] Source discovery: AGENTS.md, CLAUDE.md, README, ADRs, commits, chat logs
- [x] Deterministic subject resolution with reasoned refusals
- [x] Confidence computed outside the model's influence
- [x] Hand-labelled evaluation set: 31 real documents
- [x] Precision 100%, recall 75% (n=4), F1 85.7%
- [x] 61 uncheckable statements counted and classified
- [x] Injection tests in both directions, including one that asserts the attack succeeds
- [x] Resumable evaluation harness surviving a mid-run 429

See `docs/INTENT.md`.

### Week 8 — violation detection — **complete**
- [x] Four detectors: forbidden import, bypassed route, cycle, upward dependency
- [x] may-only-import-via semantics decided and documented (direct-edge only)
- [x] Severity formula, explainable in one sentence, with its exclusions stated
- [x] Every violation carries the evidence from every edge that breaks it
- [x] checked / satisfied / unchecked reported separately
- [x] Violation precision 100%, recall 100% against injected known positives
- [x] Deterministic: same graph and constraints give byte-identical violations
- [x] Exposed on the CLI, in --json, and as an overlay on /api/graph

See `docs/VIOLATIONS.md`.

### Week 9 — versioning and drift — **complete**
- [x] One deterministic snapshot per commit, stored in SQLite (schema v2)
- [x] Active corrections recorded per snapshot; Week 6 wiring confirmed, not assumed
- [x] Semantic diff over modules, edges, constraints and violations
- [x] Rename vs restructure decided by file overlap; threshold 0.6, documented
- [x] Drift score implemented per ARCHITECTURE.md and charted across history
- [x] Every score movement reports the diff entries that caused it
- [x] Week 5 stability re-checked first: adjacent ARI 1.000, false-restructure rate 0/25
- [x] GET /api/diff and GET /api/drift-history, plus a minimal timeline UI
- [x] Snapshot determinism verified on all three reference repositories

See `docs/DRIFT.md`.

### Week 10 — the conformance UI — **complete**
- [x] Violation panel: ranked by severity, evidence attached, plain language
- [x] Clicking a violation highlights the implicated files on the graph
- [x] Zero-violations-because-satisfied told apart from zero-because-none-stated
- [x] Week 7's uncheckable count surfaced beside the constraint ledger
- [x] Drift timeline annotates every point with the diff entries that moved it
- [x] Flat-but-changed commits explain themselves rather than looking broken
- [x] Clicking a commit shows its diff and the violations as they stood then
- [x] Rule 2 held: STATED and DERIVED visually distinct in every panel
- [x] Read-only throughout; no new detection or diff logic
- [x] Browser QA on all three reference repos plus blueprint and a breached copy

See the Week 10 section of `docs/VIOLATIONS.md`.

### Post-Week-10 correctness fixes — **complete**
- [x] Drift chart: current run's constraints now reach every historical snapshot
- [x] Verified on blueprint's real history — 0 constraints/snapshot before, 3 after
- [x] Truncation given its own failure kind in both adapters (Anthropic never detected it at all)
- [x] Incomplete extraction reported above the counts, never folded into a zero
- [x] Eval harness excludes truncated documents from scoring rather than counting them as misses
- [x] All 31 eval documents re-extracted with a cleared cache: no hidden truncations
- [x] Precision/recall confirmed stable across two independent runs (100% / 75%)
- [x] Uncheckable count found unstable (61 -> 76) and requalified as a range

### Week 11 — MCP server and static export — **complete**

See `docs/MCP.md`.

- [x] **MCP server, read-only, over stdio.** Hand-rolled JSON-RPC 2.0 rather than
      `@modelcontextprotocol/sdk`, per CLAUDE.md's dependency rule and the
      precedent of the hand-rolled Gemini adapter and `.env` reader.
- [x] **`check_import(from, to)`** — the tool the week hangs on. Re-expresses the
      four detectors against a *hypothetical* edge, because `detectViolations`
      answers "what does this repo already break" and for an unwritten import
      that is always none. Pinned to the detector by agreement tests.
- [x] **`get_architecture(level)`, `get_violations(severity?)`, `get_constraints()`.**
- [x] **Provenance on every response** (rule 2) and evidence on every edge
      (rule 3), both across the tool boundary.
- [x] **"Cannot determine" rather than a guess** — on an unresolved path, an
      unevaluable rule, or any document that went unread.
- [x] **No new network exposure.** stdio opens no port at all. Enforced by
      `architecture.test.ts`, which also asserts no store or filesystem writer is
      reachable from `src/mcp` — so write access requires deleting a test.
- [x] **`AGENTS.md` export**, human-readable and machine-parseable from one file
      (prose document, tagged JSON block inside it), spliced between markers so
      hand-written notes survive regeneration.
- [x] **Self-contained `blueprint.html`**, opens from `file://` with no server,
      no external requests of any kind, visible timestamp and commit hash.
- [x] **Acceptance: a real client exchange**, on this repository and on a
      constructed breach repository — reported in `docs/MCP.md`, including the
      two bugs it found.
- [x] **Reference-repo QA on `zod`** (407 files, 724 edges, 19 modules). Checked
      against Week 9's independently-authored ground truth — zod's own
      circular-import fix commit — and reproduced it exactly: `iso.ts` imports
      `schemas.ts` through 2 statements, `schemas.ts -> iso.ts` absent. 0 of 724
      edges lacked evidence. Static export: zero console errors, no external
      references.
- [x] **A real MCP host attached** — the official MCP Inspector v2.1.0, not the
      scripted client. Discovery plus a real `check_import` returning `forbidden`
      with the sentence and its location, on zod and a constructed breach repo.
      Claude Code's CLI is not on PATH in this environment, so the Inspector
      stood in as the independent host.
- [ ] **`requests`/`pyright` through the Inspector specifically.** Retried Week
      12: the Inspector's `--cli` mode hung indefinitely against both, no
      diagnosable output — a technical obstacle, not just quota. Re-checked at
      the scripted-client tier instead (`scripts/mcp-check.mjs`): `check_import`
      on both correctly returned `cannot-determine`, not a false `allowed`,
      under today's real quota-exhausted state. See `docs/MCP.md` → "Still not
      verified". Left unticked because the Inspector-host and successful-
      extraction cases are still open, not because nothing was tried.

**A third bug, found by the real host:** the server analysed the whole repository
before answering `initialize`, and a real host times the connection out at 15s.
The scripted client had no timeout and never showed it. The handshake is now
served from static data while the pipeline runs alongside — ~195ms to
`initialize` regardless of repository size.

**Also confirmed empirically:** re-running extraction over a zod `AGENTS.md` that
our own export had grown by 284 lines produced 5 cache hits and 0 misses, which
is only possible if the generated block is stripped before reading. The export
does not read itself back in.

**Two correctness bugs found by acceptance, both fixed:**

1. **An unread document read as an absent rule.** With the model quota
   exhausted, `check_import` answered *allowed* for `parser/ -> llm/` — a rule
   this project states in capital letters — because the document stating it was
   never read. Third instance of the unmeasured-zero family, after the
   truncation bug and the drift bug, and the most dangerous: this answer is
   acted on before code is written. Also fixed one layer down in
   `buildIntentResponse`, which the Week 10 UI reads.
2. **A systematic false positive.** Path-pattern rules were compared at module
   granularity, so on a repository small enough to cluster into one module every
   rule forbade every import. The detector never had this because it crosses
   file sets; the agreement tests missed it because their fixtures had one file
   per module.

---

## PHP support (added 2026-08-12, after both reference corpora)

**Deliverable:** PHP joins TypeScript, JavaScript and Python as a supported language,
following the same three-stage discipline as Week 2/3: grammar → extractor → resolver,
tests before the resolver.

This lands after corpus A and corpus B were both collected and measured (see
`docs/FINDINGS.md`); neither corpus was re-run, so no finding in that document changes.
It is a straightforward scope expansion, not a revision of prior measurements.

- [x] **Grammar.** `@vscode/tree-sitter-wasm` does not ship PHP, so
      `tree-sitter-php.wasm` is vendored from `@repomix/tree-sitter-wasms` 0.1.17
      instead — a maintained fork of `tree-sitter-wasms`. The direct `tree-sitter-wasms`
      package was tried first and, per the existing note in `grammars/README.md`, fails
      to load against `web-tree-sitter` 0.26 for every grammar tried, PHP included. The
      `@repomix` fork was verified independently before being trusted: `Language.load`
      succeeds and reports **ABI version 15** (matching the other four grammars), and a
      real `<?php … ?>` parse was inspected by hand to confirm the expected node shapes
      (`namespace_use_declaration`, `require_once_expression`, etc.) before any extractor
      code was written against them. `src/parser/grammars.test.ts` now loads all five
      grammars on every test run.
- [x] **Extractor** (`src/parser/extract-php.ts`): `use` declarations (plain, aliased,
      `use function`, `use const`, grouped `use A\{B, C as D}`), and
      `require`/`require_once`/`include`/`include_once`. A require/include is only
      extracted when it resolves to a literal string — `__DIR__ . '/x.php'` and
      `dirname(__FILE__) . '/x.php'` have their non-literal prefix stripped, leaving the
      literal suffix as the specifier; a wholly dynamic target (`require $path`, string
      interpolation) has no evidence to build a DERIVED edge from and is skipped, same
      reasoning as Python's requirement of a real dotted name. `namespace` declarations
      are walked over without producing a record — PSR-4 resolution needs only the FQCN
      being imported plus composer.json's prefix map, never the importing file's own
      declared namespace. 19 extractor tests.
- [x] **Resolver** (`src/graph/resolve-php.ts`): two independent paths, matching the two
      import kinds.
  - `php-use` (a FQCN) resolves through composer.json's `autoload["psr-4"]` and
    `autoload-dev["psr-4"]` prefix maps — a pure string/path computation, not a directory
    scan, since PSR-4 is a convention rather than something to discover. A FQCN matching
    no registered prefix is EXTERNAL (`php-composer-package`) — a vendor package or a PHP
    core class. A FQCN matching a prefix but pointing at no file is UNRESOLVED
    (`php-namespace-target-missing`), never EXTERNAL, same anti-pattern-avoidance as
    Python's `looksInternal` check.
  - `php-require` (a literal path) resolves relative to the importing file's own
    directory, same as a TS relative import. Anything under `vendor/` is EXTERNAL
    (`php-composer-package`) regardless of whether the file is present, since vendor
    dependency internals are out of scope the same way `node_modules/` internals are.
  - **A real defect surfaced during acceptance measurement, not during fixture testing:**
    `nikic/PHP-Parser`'s own `composer.json` registers the *same* PSR-4 prefix
    (`PhpParser\`) under both `autoload` (`lib/PhpParser`) and `autoload-dev`
    (`test/PhpParser/`). The first implementation kept these as two independent
    candidate entries and gave up after the first one failed, so every test-namespace
    class resolved to UNRESOLVED. Fixed by merging entries that share a prefix into one,
    trying every registered directory before giving up — regression-tested by
    `php-psr4-split-prefix` in `resolve-php.test.ts`, which reproduces the shape without
    depending on the real repo being present. This is the PHP equivalent of the zod
    `alias-target-missing` story in Week 3: the acceptance run against a real repo, not
    the fixtures, is what found it.
  - 4 fixture repos (`php-psr4`, `php-psr4-split-prefix`, `php-relative-require`,
    `php-vendor`), 15 resolver tests.

**Acceptance:** resolution rate above 95% on at least two real PHP repos, same threshold
as Week 3.

**Acceptance met.**

| Repo | Files | Nodes / edges | Imports | Unresolved | Rate |
|---|---|---|---|---|---|
| `Seldaek/monolog` | 217 | 217 / 401 | 588 | 0 | **100.0%** |
| `nikic/PHP-Parser` | 341 | 341 / 752 | 779 | 3 | **99.6%** |

The 3 remaining unresolved imports were inspected. None is a resolver defect: all three
are in `tools/fuzzing/generateCorpus.php`, `require $testDir . '/…'` where `$testDir` is
a runtime variable with no statically-knowable value. The extractor correctly extracts
only the literal `/…` suffix (there is no other literal information available), the
resolver correctly cannot find a file at that guessed path relative to the importing
file, and the import is honestly reported UNRESOLVED rather than silently guessed at —
exactly the behaviour the Week 3 EXTERNAL/UNRESOLVED discipline exists to produce.

---

## Suggested build order within each week

Build the deterministic core first and the UI last. The UI is the most tempting thing to
start with and the least useful early — a correct graph with no UI is valuable, while a
beautiful UI over a wrong graph is worse than nothing.

Write the resolver tests *before* the resolver. It is the component most likely to be subtly
wrong, and subtle resolver bugs will silently corrupt every downstream result in Phases 2
and 3.
