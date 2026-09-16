# Vibe-Code Blueprint: Guide for Helpers

Thanks for helping. This guide covers everything you need to set up the project and work on it, with most of the detail on the two model backends: **Gemini (cloud)** and **our fine-tuned local model**.

If you only read one section, read [§3 Secrets and safety](#3-secrets-and-safety-read-this-first).

---

## Contents

1. [What this project is](#1-what-this-project-is)
2. [Setup and first run](#2-setup-and-first-run)
3. [Secrets and safety (read this first)](#3-secrets-and-safety-read-this-first)
4. [How model selection works](#4-how-model-selection-works)
5. [Gemini (cloud) in detail](#5-gemini-cloud-in-detail)
6. [The local fine-tuned model in detail](#6-the-local-fine-tuned-model-in-detail)
7. [Running the local model on Google Colab](#7-running-the-local-model-on-google-colab)
8. [The rest of the workspace](#8-the-rest-of-the-workspace)
9. [Codebase map](#9-codebase-map)
10. [Rules we don't break](#10-rules-we-dont-break)
11. [Testing and committing](#11-testing-and-committing)
12. [Known issues and open items](#12-known-issues-and-open-items)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. What this project is

**Vibe-Code Blueprint** is a local-first CLI (`npx vibe-blueprint .`) with two halves.

**The measuring half (the original core).** It reads a TypeScript, JavaScript, Python or PHP codebase, builds a real dependency graph from actual import statements, clusters it into modules, and compares that *derived* architecture against the architecture people *stated* in READMEs, `AGENTS.md`, ADRs and a small blueprint DSL (for example `domain must not import infra`). It reports violations and drift over git history, and serves an MCP server so AI agents can ask "am I allowed to import this?" before writing the line.

**The generating half (the workspace).** A browser workspace at `/workspace.html`:

- **Workflow graph → Generate from prompt**: an LLM turns a prompt into a `ProjectSchema` (frontend, backend, database and security domains, plus architectural constraints).
- **Generate Application**: an LLM writes real code for each component. The code is then checked against the blueprint, built with `npm install` and `npm run build`, and components that fail get one automatic retry.
- **Page builder**: drag-and-drop page design that generates a `.tsx` file deterministically, with no LLM involved.

Every LLM call in the generating half goes through one provider interface. That is what makes it possible to switch between Gemini and our local model, which is the part you'll most likely be helping with.

---

## 2. Setup and first run

### Prerequisites

- **Node.js 20 or newer** (we use 24)
- **Git**
- Access to the GitHub repo: `https://github.com/Vikram5002/blueprint-s-_to_vibecoders`. If it's private, ask to be added as a collaborator.

### Install (two installs, not one)

This is **not** an npm workspace. `ui/` has its own `package.json`:

```bash
git clone https://github.com/Vikram5002/blueprint-s-_to_vibecoders.git
cd blueprint-s-_to_vibecoders
npm install                 # root: the CLI and server
npm --prefix ui install     # the UI (easy to forget)
```

If you skip the second install, nothing fails at install time. The error only appears later: `Failed to load PostCSS config ... Cannot find module 'tailwindcss'`. The fix is `npm --prefix ui install`.

### Build and run

```bash
npm run build                        # compiles the server and builds the UI
node dist/cli.js . --no-open         # analyse this repo and start the server
```

It prints `Blueprint ready at http://127.0.0.1:PORT`. The port is random each run. Open:

- `http://127.0.0.1:PORT/`: the architecture dashboard
- `http://127.0.0.1:PORT/workspace.html`: the workspace (generation, page builder, model picker)

To try it on a small repo instead of the whole project, use `node dist/cli.js src/graph/fixtures/ts-monorepo --no-open`.

### Useful CLI flags

| Flag | What it does |
|---|---|
| `--no-open` | Don't open a browser |
| `--no-serve` | Analyse and exit, no server |
| `--json` | Machine-readable output (implies no server) |
| `--history N` | Record N historical snapshots for drift charts |
| `--mcp` | Run as a read-only MCP server over stdio instead of HTTP |
| `--export` | Write `AGENTS.md` and a self-contained `blueprint.html` |
| `--blueprint <file>` | Compile an authored blueprint DSL file and persist it |

### Everyday commands

```bash
npm test                         # vitest, root package (about 1,170 tests)
npm run lint                     # eslint + tsc --noEmit
npm --prefix ui test             # UI unit tests
npm --prefix ui run build        # UI only
cd ui && npx playwright test     # e2e (see §11 before running these)
```

---

## 3. Secrets and safety (read this first)

**Never commit, paste, screenshot or share API keys.** That includes chat messages, issues, and AI tools.

- Keys live in a `.env` file at the repo root. `.env` is gitignored. Keep it that way.
- **Use your own keys.** Don't ask for or copy someone else's `.env`. A free Gemini key takes about a minute to create at Google AI Studio.
- The server binds to `127.0.0.1` only, never `0.0.0.0`. Don't change this: the tool reads private source code.
- Never give anyone, including AI assistants and browser extensions, your Google or Colab account credentials. Nothing in this project needs them.
- **Don't commit the model files.** `pdsf/adapter.zip` is 145MB, and GitHub rejects files over 100MB, so committing it breaks the next push. The adapter is shared out of band (pendrive or Drive), not through git.
- A Colab tunnel URL (§7) is **public**: anyone with the link can send prompts to the model while the notebook runs. Don't post it anywhere, and stop the notebook when you're done.

### What goes in `.env`

Create it yourself. Variable **names** only; fill in your own values:

```bash
# Gemini: the default provider
GEMINI_API_KEY=your-key
# Optional extra Gemini keys, used when one runs out (see §5)
GEMINI_API_KEY_2=
GEMINI_API_KEY_3=

# Optional other providers
ANTHROPIC_API_KEY=
BLUESMINDS_API_KEY=

# Optional overrides
VIBE_LLM_PROVIDER=gemini          # gemini | local | anthropic | bluesminds
VIBE_LLM_MODEL=                   # override the provider's default model
VIBE_LOCAL_BASE_URL=              # where the local model server is (§6)
```

Only `cli.ts` is allowed to load `.env` (an architecture test enforces this).

---

## 4. How model selection works

### In the workspace (the normal way)

The top-right of `/workspace.html` has a **MODEL** dropdown:

| Option | Meaning |
|---|---|
| Gemini (cloud) | Google's API, the default |
| Local model (this machine) | Our fine-tuned checkpoint, served over HTTP (§6) |
| Anthropic (cloud) | Claude API |
| Bluesminds (cloud) | Bluesminds gateway |

Next to each option it shows **real availability**. For cloud providers that means whether the key is set. For the local model, it probes the server and shows "No server responding at …" if nothing answers.

- Switching takes effect **immediately, with no restart**. Requests already in flight finish on the provider they started with.
- You **can** select an unavailable provider, for example if you're about to start the local server. The picker warns you instead of refusing.
- When **Local model** is selected, a URL box and a **Connect** button appear, so you can point it at a remote server such as a Colab tunnel.
- The choice and the local URL are **saved** in `.vibe/blueprint.db` (the `settings` table) and survive restarts.

### Priority order

1. A choice saved from the picker wins.
2. Otherwise, `VIBE_LLM_PROVIDER` from `.env`.
3. Otherwise, Gemini.

The local URL follows the same order: saved value, then `VIBE_LOCAL_BASE_URL`, then `http://127.0.0.1:8712`.

### Design rules behind this (please keep them)

- **No silent fallback between vendors.** If the selected provider fails, the request fails with a clear error. It never quietly retries on a different model, because that breaks reproducibility and hides problems. Switching only ever happens when a person chooses it.
- **Structure is never decided by an LLM.** The dependency graph comes only from static analysis. The LLM names clusters, reads intent from prose, and generates code. Nothing more.

### Where it lives in code

| File | Role |
|---|---|
| `src/llm/provider.ts` | The `CompletionProvider` interface every backend implements |
| `src/llm/select-provider.ts` | Reads env, picks provider, model and key, constructs the adapter |
| `src/llm/provider-registry.ts` | Runtime switching, availability probing, and the switchable proxy provider |
| `src/server/providers-api.ts` | `GET /api/providers` and `POST /api/providers` |
| `src/store/settings-store.ts` | Persists the choice |
| `ui/src/workspace/ProviderPicker.tsx` | The dropdown and URL box |

`GET /api/providers` returns `{ current, localBaseUrl, providers: [{ id, label, model, available, detail }] }`.
`POST /api/providers` accepts `{ provider?, localBaseUrl? }`, and both can be sent in one request.

---

## 5. Gemini (cloud) in detail

**Adapter:** `src/llm/gemini.ts`, using plain `fetch` with no SDK. The key goes in the `x-goog-api-key` header, never in the URL, and error text is passed through `redact()`.

**Default model:** `gemini-3.5-flash`. It's pinned to a specific version, not `-latest`, so the cache never mixes answers from two different models.

### Retries

Each request gets up to **5 attempts per key**, with exponential backoff (1s, 2s, 4s, 8s, 16s; 60s maximum). If the server sends a `retryDelay`, that is used instead.

| Response | What happens |
|---|---|
| 429, per-minute limit | Retries on the same key |
| 429, **daily** quota exhausted | Fails on this key immediately (waiting won't help until midnight Pacific) |
| 5xx (for example 503 "overloaded") | Retries |
| Network error or timeout (120s) | Retries |
| 400 / 401 / 403 / 404 | **No retry.** A bad key or wrong model fails the same way every time |

### Multiple keys (`GEMINI_API_KEY`, `_2`, `_3`, …)

Keys are read in order and reading **stops at the first gap**: if `_2` is blank, `_3` is ignored.

The provider **moves to the next key** when:

- the current key's **daily quota** is exhausted, or
- the current key used all 5 attempts on a **transient** failure (429, 5xx, network).

It **doesn't** move on for bad-key, wrong-model or malformed-request errors. Those would fail identically on every key, and rotating would hide a configuration mistake.

A key that ran out stays skipped for the rest of the server's life. Server logs show `[gemini] using API key 3/7` and `key 3/7 exhausted (...) - rotating to key 4/7`, with indexes only, never key values.

This rotation used to happen only on daily-quota exhaustion. A run of 503s once failed a whole generation while 3 untried keys were still available, which is why transient failures now rotate too.

### Response cache

LLM answers are cached in `.vibe/label-cache.json`. The cache key is the model, the prompts and the schema.

- Architecture labelling and intent extraction **use** the cache. Re-measuring an unchanged repo should give the same answer.
- **Application generation deliberately skips it** (`skipCache: true` in `src/server/generation-api.ts`). Before this change, clicking "Generate Application" again after a failed build replayed the exact same broken code from the cache, so the retry could never produce anything different.

### Free-tier reality

- A **503 "model overloaded"** error means Google's servers are busy. It isn't a problem with your key. Try again later, or switch provider.
- Heavy e2e runs and repeated generation use up daily quota quickly. Extra keys help with quota errors, but not with a Google-wide outage.

---

## 6. The local fine-tuned model in detail

### What it is

A **Qwen2.5-7B-Instruct** base model with a **LoRA adapter** we trained to turn app descriptions into `ProjectSchema` JSON.

| | |
|---|---|
| Checkpoint we have | `run_20260822_130636` ("baseline", trained on 91 rows) |
| Training base | `unsloth/qwen2.5-7b-instruct-unsloth-bnb-4bit` (trained with Unsloth) |
| LoRA settings | r=16, alpha=16, lr=2e-4, 3 epochs, no dropout |
| Adapter size | ~161MB (`adapter_model.safetensors`) |
| Peak training VRAM | 8.7GB |

There is a newer checkpoint, `run_20260912_154324` (288 rows), which is better at generating constraints, but **we don't have its files right now**. We only have the baseline, so the app labels local answers `local:qwen2.5-7b-instruct+run_20260822_130636`, which is the checkpoint actually served. If you ever serve the newer one, set `VIBE_LLM_MODEL=local:qwen2.5-7b-instruct+run_20260912_154324` so the label (and the response cache key) stays honest. See §12.

Training data, formats and evaluation results are in `training/`:

- `TRAINING-FORMAT.md` covers the `{system, user, assistant}` format and a tokenizer bug to watch for.
- `eval/RESULTS*.md` records measured results for each checkpoint.

### How the app talks to it

The model doesn't run inside Node. A separate Python script, `local_inference_server.py`, loads it with `transformers`, `peft` and `bitsandbytes` (4-bit NF4) and serves HTTP. `src/llm/local.ts` is a thin client for that server.

**Contract:** `POST {baseUrl}/complete`

Request (the `CompletionRequest` type):

```json
{ "system": "...", "user": "...", "maxOutputTokens": 4096, "temperature": 0, "schema": { }, "effort": "medium" }
```

A success reply must look exactly like this:

```json
{ "ok": true, "value": { "text": "...", "model": "...", "usage": { "promptTokens": 0, "completionTokens": 0, "cachedPromptTokens": 0 }, "schemaDowngraded": true } }
```

A failure reply must look like this, with `kind` set to `unavailable`, `refused` or `incomplete`:

```json
{ "ok": false, "error": { "kind": "unavailable", "message": "..." } }
```

The server also adds a `_debug` field (latency, VRAM, constraint stats), which the app ignores. The script applies **JSON punctuation-constrained decoding**, so the output is syntactically valid JSON. It does not check the schema's shape; `validateProjectSchema` on the TypeScript side does that.

The client times out after **300 seconds** (`REQUEST_TIMEOUT_MS` in `local.ts`).

### Why it can't run on the main laptop

The main laptop has a **GTX 1650 Max-Q with 4GB VRAM**. A 7B model in 4-bit needs roughly 5–6GB before activations, so loading it fails with out-of-memory. The LoRA adapter only works on this specific 7B base, so switching to a smaller base model isn't possible.

### Where it can run

| Option | Status | Notes |
|---|---|---|
| **Google Colab free T4 (16GB)** | ✅ Working setup | Runs the script unchanged; see §7 |
| The desktop it was trained on | ✅ | Run everything there, or set `VIBE_LOCAL_BASE_URL=http://DESKTOP-IP:8712` from another machine |
| llama.cpp / Ollama on the laptop | ⚠️ Possible, not built | GGUF Q4_K_M with partial GPU offload, ~6–10 tokens/s. Needs a new adapter (OpenAI-style API) and a higher timeout |
| Laptop with the current script | ❌ | Out of memory, and the script is hard-coded to CUDA |

### Files (not in git; shared separately)

| File | Where |
|---|---|
| `adapter.zip` (all 7 adapter files, at the zip root) | `pdsf/` folder, or ask for a Drive link |
| `local_inference_server.py` (the 23KB version with JSON constraints) | `pdsf/` folder |

The pendrive has several copies of the server script. **Use the 23KB one.** The three 8KB copies are older and lack the JSON constraint logic.

---

## 7. Running the local model on Google Colab

**Notebook:** `docs/colab/vibe-local-model-colab.ipynb`

### Steps

1. Open **Google Colab**, choose **File → Upload notebook**, and select that `.ipynb` file.
2. **Runtime → Change runtime type → T4 GPU → Save.** Then **Connect**.
3. Run the cells **one at a time with Shift+Enter**. **Don't use Run all**, because the upload cell waits for you.

| Cell | Expected output |
|---|---|
| 1. GPU check | `GPU: Tesla T4 (14.6 GB)` (bf16 may say True; that's fine, see below) |
| 2. Install | Ends with `done - torch untouched, no restart needed` |
| 3. Upload | Click **Choose Files**, select **both** `adapter.zip` and `local_inference_server.py`, wait for 100% → `ADAPTER_DIR = /content/adapter_root` |
| 3b. Drive alternative | **Skip** (unless you're loading the zip from Drive) |
| 4. T4 patch | `compute capability 7.5 -> native bf16: False` then `Patched bfloat16 -> float16...` |
| 5. Server + tunnel | 5–15 minutes (downloads ~15GB), then `READY: serving POST /complete` and a box with `https://....trycloudflare.com` |
| 6. Smoke test | `OK - generation works. X.Xs for this request.` |

4. **Copy the `trycloudflare.com` URL.**
5. In the workspace: choose **MODEL → Local model**, paste the URL into the box, and click **Connect**.
   - Grey model name: connected.
   - Amber "No server responding": the tunnel isn't reachable.
   - Red "must be an http(s) URL": the pasted text is wrong.
6. **Keep the Colab tab open.** If you close it, or it sits idle (about 90 minutes), the server stops. A new session gives a **new URL**. Rerun the cells, paste the new URL and click Connect; the app doesn't need a restart.

### Problems we've already hit (and why the notebook looks the way it does)

| Symptom | Cause | What's in place |
|---|---|---|
| `partially initialized module 'torch' ... circular import` in cell 1 | `pip install -U` upgraded torch while the old one was loaded, usually after **Run all** | Cell 2 now pins torch. If it happens anyway: **Runtime → Disconnect and delete runtime**, then start again from cell 1 |
| Cell 1 says `bf16 supported: True` on a T4 | Newer PyTorch counts **software emulation** as bf16 support | Cell 4 checks compute capability (≥8.0 means native bf16), so the T4 still gets the float16 patch |
| `No adapter_config.json found` | A zip made with Windows PowerShell 5.1 `Compress-Archive` on a *folder* stores backslash paths, which Linux doesn't split into folders | The provided zip has the files at its root, and cell 3 handles backslash paths anyway. If you rebuild the zip, compress the folder's **contents**: `Compress-Archive -Path 'E:\run_20260822_130636\*' ...` |
| URL prints `None` | The tunnel was slow to announce its URL | Run cell 5 again |
| `CUDA out of memory` | Leftovers from a previous run | **Disconnect and delete runtime**, start over |
| Workspace shows `network error: TimeoutError` | A T4 is slow and code generation can take more than 300s | The request is working. Raise `REQUEST_TIMEOUT_MS` in `src/llm/local.ts` |

### Using a browser AI agent (such as the Claude Chrome extension)

It's fine to let an agent drive Colab cell by cell, but:

- An extension **can't choose files from your computer**, so it has to stop and let you do the upload.
- Tell it to **stop and report** when an output doesn't match what's expected. It shouldn't improvise fixes.
- Never give it account credentials.

### Expectations

- Speed: often **minutes** per generation, compared with seconds on Gemini. Generating a whole application makes many calls.
- Quality: this is the **baseline** checkpoint. It is weaker than Gemini on constraints; see `training/eval/RESULTS*.md`.
- Model label: the picker shows `…run_20260822_130636`, which matches the `--model-name` the notebook starts the server with. Keep the two in step if you change either.

---

## 8. The rest of the workspace

| Tab / area | What it does |
|---|---|
| **Sessions sidebar** | Lists every schema generation that succeeded, stored in SQLite (`workflow_sessions`). Click one to reopen it. |
| **Workflow graph** | Mock data (hand-built fixtures) or **Generate from prompt** (real LLM). Four domain nodes, rule-labelled edges, click a node to see prohibitions, MiniMap. |
| **Generate Application** | Generates every component, writes to `generated/<jobId>/`, runs a blueprint check and a service-locator evasion check, `npm install` and `npm run build`, retries once, and offers the result as a zip. |
| **Page builder** | 12 elements (heading, text, button, link, image placeholder, input, textarea, checkbox, radio, dropdown, divider, container). The Inspector edits label, one of 8 colours, and one of 8 animations (fade, slide ×4, zoom, pulse, bounce), with duplicate and delete. **Generate** outputs one deterministic `.tsx` file with no LLM. |
| **Page regions / Verification** | Mock-data demo views |
| **Conversation** | Placeholder, not wired up yet |

Bugs fixed recently that are worth knowing about, in case something similar comes back:

- The page builder Inspector used to render off-screen (the 1280px canvas pushed the grid track wide).
- Clicking an element used to deselect it immediately (the click bubbled up to the canvas).
- The MiniMap used to be empty (nodes had no measured dimensions).

---

## 9. Codebase map

```
src/
  cli/          argument parsing and output only; no business logic
  ingest/       repo walking, .gitignore handling, language detection
  parser/       tree-sitter wrappers
  graph/        dependency resolution, graph building, clustering
  pipeline/     stage orchestration
  llm/          ALL LLM code: providers, prompts, cache
                  provider.ts, select-provider.ts, provider-registry.ts,
                  gemini.ts, local.ts, anthropic.ts, bluesminds.ts, cache.ts
  conformance/  constraints, intent, violation detection
  blueprint/    blueprint DSL compiler and visual editor support
  workflow/     prompt -> ProjectSchema generation and constraint compiler
  generate/     Layer 3 code generation:
                  component-codegen.ts (one LLM call per component, skipCache)
                  generate-project.ts, verify-and-regenerate.ts (retries)
                  canvas-layout.ts (page builder, deterministic)
  store/        SQLite (.vibe/blueprint.db): corrections, snapshots,
                  blueprint, workflow_sessions, settings
  server/       Hono HTTP API (127.0.0.1 only)
                  workflow-api.ts, generation-api.ts, providers-api.ts,
                  page-builder-api.ts
  mcp/          read-only MCP server
  export/       AGENTS.md and blueprint.html
ui/             React app; talks to the server only through the JSON API
  src/workspace/  WorkspaceShell, ProviderPicker, Sidebar, WorkflowDemo,
                  WorkflowGraph, GenerateApplicationPanel, PageBuilderCanvas
  e2e/            Playwright tests
docs/           design docs, one per stage; colab/ notebook; this file
training/       fine-tuning data, format, evaluation results
generated/      generated applications (gitignored)
```

Topic docs: `docs/ARCHITECTURE.md`, `docs/PROVIDERS.md`, `docs/GENERATION.md`, `docs/BLUEPRINT.md`, `docs/MCP.md`, plus the `CLAUDE.md` project rules.

---

## 10. Rules we don't break

These come from `CLAUDE.md`, and some are enforced by `src/architecture.test.ts`.

1. `parser/` and `graph/` **never import from `llm/`**. That boundary keeps analysis deterministic.
2. Every graph Node and Edge carries `provenance`: `DERIVED` (traced to a real import) or `STATED` (claimed in prose). The two are never mixed.
3. Every Edge carries `evidence[]` (file and line). If there's no source line, the edge isn't created.
4. `ui/` **never imports from `src/`**. Shared types are duplicated into `ui/` mirror files such as `provider-types.ts` and `page-builder-types.ts`. When you change a type in `src/`, update its mirror.
5. `cli/` contains no business logic.
6. **No network calls outside `llm/`** (and the server's own local routes).
7. Local-first: no authentication, cloud sync or multi-user features.
8. Only TS, JS, Python and PHP are analysed. No new languages.
9. Don't add heavy dependencies without asking.

Conventions: TypeScript strict, no `any` (use `unknown` and narrow it), named exports only, kebab-case file names, `Result<T, E>` return values in the pipeline, functions under about 50 lines, tests next to the code as `*.test.ts`. `exactOptionalPropertyTypes` is on, so "absent" and "`undefined`" are different things.

---

## 11. Testing and committing

### Before every commit

```bash
npm test && npm run lint && npm --prefix ui test && npm --prefix ui run build
```

Never commit a state where tests fail.

### E2E tests

- `ui/e2e/workspace-shell.spec.ts` runs against the Vite dev server, with no backend.
- `page-builder`, `workflow-sessions` and `single-component-build-failure` start the **real CLI**. Some make **real Gemini calls and use up quota**, so run them deliberately, not in a loop.
- They share `src/graph/fixtures/ts-monorepo/.vibe/`, which is gitignored. Leftover sessions or settings from earlier runs can affect results.

### Commits

- **Conventional Commits**: `feat(llm): ...`, `fix(ui): ...`, `test(server): ...`, `docs(...)`.
- One logical change per commit. Don't mix a refactor with a feature.
- Tests go in the same commit as the code they cover.
- **Stage files explicitly** with `git commit -- path1 path2`. Some unrelated files are already staged in the main working copy, and a bare `git commit` would pull them in.
- Don't run `git add -A`, and never commit `.env`, `pdsf/adapter.zip` or `generated/`.
- Confirm before pushing.

---

## 12. Known issues and open items

| Item | Details |
|---|---|
| **Newer checkpoint missing** | `run_20260912_154324` isn't on the pendrive; only the baseline is. It's probably still on the training desktop. If it turns up, also set `VIBE_LLM_MODEL` (§6). |
| **Local model is slow** | 300s client timeout; large code generations may exceed it on a T4. |
| **llama.cpp/Ollama support** | Not built. It would let the laptop run the model (slowly): OpenAI-style API support in `local.ts` plus GGUF conversion of the adapter. |
| **Fake-id defect** | The fine-tuned model invents component IDs; production code recomputes them (`rewriteComponentIds`). Not fixable with more data. |
| **Frontend page props** | `frontendEntryPointFile` mounts pages with no props, so detail pages that need an ID fail `tsc`. |
| **Multi-file build failures** | The automatic build retry only runs when every error is in a single file (by design). |
| **Prettier drift** | About 24 UI files fail `prettier --check`. Leave them alone; this is a separate decision. |
| **Page builder gaps** | No resize, no z-order controls, no undo, no saving or loading of pages. |
| **Conversation tab** | Placeholder, not wired up. |
| **E2E and quota** | Live-model e2e tests use Gemini quota. |

---

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module 'tailwindcss'` | `npm --prefix ui install` |
| Picker shows Gemini "unavailable" | `GEMINI_API_KEY` isn't set in `.env`; restart the server after adding it |
| `/api/workflow/jobs` returns 503 | No usable provider for the current selection |
| `HTTP 503 after 5 attempt(s)` | Gemini is overloaded. Wait, or switch provider. Extra keys help with quota errors only |
| `daily free-tier quota exhausted (all N configured key(s) exhausted)` | Every key is used up until midnight Pacific. Add a key or switch provider |
| Local model amber / unavailable | Server not running, Colab tab closed, or the URL changed. Rerun Colab and paste the new URL |
| Local model `TimeoutError` | Slow, not broken. Raise `REQUEST_TIMEOUT_MS` |
| "Generate Application" fails with the same errors every time | Shouldn't happen any more (cache bypass). If it does, check `skipCache` in `generation-api.ts` |
| Server changes don't show up | Rebuild with `npm run build` and **restart** the CLI. The UI reloads from disk; server code doesn't |
| Port already in use / stale server | Stop old `node dist/cli.js` processes |
| Colab errors | See the table in §7 |

---

**Questions:** ask before changing anything in `llm/`, the provider selection rules, or the "no silent vendor fallback" rule. Those are deliberate design decisions, and the reasoning is documented in the file headers.
