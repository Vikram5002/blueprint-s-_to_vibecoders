# Tasks 1–5 integration dependency map

This map is based on the current `semi` tree and locally available
`origin/main` (`2d43b049e0f1321c9f4e03ca32afc9abdc5448e5`). It records the
minimum feature dependency groups, not a request to import the whole branch.

| Task | Required feature files and data | Supporting dependencies/configuration | Relevant history |
|---|---|---|---|
| **1. Gemini evaluator** | `scripts/eval-code-model.mjs`; `src/generate/{verify-and-regenerate,build-and-repair,runtime-check,detect-service-locator-evasion,plan-rules,component-codegen,generate-project,assemble}.ts`; `src/workflow/validate-project-schema.ts`; `training/data/gold/gold.jsonl`; passing reference-project directories. | Transitive workflow/schema and LLM provider modules, compiled `dist/`, Node build scripts, runtime/build checks, and the reference manifest/project files. The evaluator imports `dist/llm/local.js`, `dist/llm/select-provider.js`, and the generation modules directly. The project trees are not in Git. | `a05e8ae` evaluator; `4e64e65` provider outage handling; `e024043` resumable per-row checkpointing; `b069597` Gemini result artifact. |
| **2. Expanded evaluation** | Paired evaluator JSON reports and project-level rows; `training/eval/code/` contains reports on `origin/main`. The Qwen3 independent reference project directory is not tracked. | Exact pairing by `(sessionId, targetPath)`, same `reference` label, boolean metric outcomes. `scripts/compare-code-evaluations.mjs` and the statistics module now enforce this on completed reports. Project provenance can be audited from metadata, but not the absent project contents or their licensing. | `c463aeb` independent-reference outputs; `3fbe111` expanded results; `b069597` Gemini output. |
| **3. Second training round** | Integrated on `semi`: `training/code/train_code.py`, `format-code-dataset.py`, `formatted-r2/{dataset.jsonl,manifest.json}`, the exact captured teacher/correction JSONLs, and `pdsf/local_inference_server.py`. | Data-only validation is standard-library/torch-free and checks the dataset hash, rows, teacher counts and Gemini exclusion. Actual local training requires Unsloth, Transformers, PEFT, TRL, bitsandbytes, Accelerate, Datasets, a compatible CUDA GPU, and the base model weights. The historical run summary still has conflicting round/dataset metadata and weights are absent. No Modal/cloud trainer was integrated or launched. | `5b0a227` round-two dataset and correction generator; `7e51cbd` second-adapter evaluation service; `2d43b04` summary with the provenance mismatch. |
| **4. Responsive Page Builder** | `ui/src/workspace/PageBuilderCanvas.tsx` and its store, geometry, type, catalogue, preview, theme, template, page-switcher and page-sync modules; `src/generate/canvas-layout.ts` plus its render helpers and tests. | Workspace shell/entry point and API routes are required for save/load and generated-file operations. UI additionally imports `@dnd-kit/core` and Zustand. The editor keeps a 1280×800 logical coordinate plane and fits it to the available viewport; generated output has separate responsive scaling logic and tests. Neither subsystem exists on `semi`. | `a2f21a9` editor and fit-to-viewport canvas; `9ec5440` generated-page scaling; surrounding workspace state/API commits are prerequisites. |
| **5. Accessibility/E2E** | Added for the current graph UI: `ui/e2e/graph-accessibility.spec.ts`, Playwright config, and keyboard/axe checks. Page Builder E2E specs and workspace views remain missing. | Locked Playwright/axe dependencies and test script are installed; Chromium channel is used by the checks. Page Builder E2E still requires the full workspace/backend feature chain and its dependencies. | `dcabae3` Playwright setup; `d09a85e` initial axe/accessibility pass. |

## Branch compatibility

`semi` has the architecture-analysis app, not the VibeCoder project-generation
workspace. The only overlapping product surface is the existing React UI and
some provider infrastructure. Adding the evaluator alone cannot work because
its generated `dist` imports and the gold/reference inputs are missing. Adding
the Page Builder alone cannot work because its state, APIs, generated-page
pipeline, and workspace shell are missing. The minimum coherent integration is
therefore a scoped application subsystem across `src/workflow`, `src/generate`,
`ui/src/workspace`, and the UI test/build configuration, plus data inputs.
Several of those groups may overlap with other assigned work; Task 6's contents
are not present in this checkout, so that overlap cannot currently be checked.

No external packages were installed. Root and UI `node_modules` are absent. The
UI packages that must be added for the Page Builder and browser checks are
`@dnd-kit/core`, `zustand`, `tailwindcss`, `postcss`, `autoprefixer`,
`@playwright/test`, and `@axe-core/playwright`. Playwright browser binaries also
need downloading. Local training dependencies are listed above; no cloud
training dependency should be invoked without separate approval.
