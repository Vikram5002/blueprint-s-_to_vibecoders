# Local code-generation model: plan

**Status:** approved in direction. **Decided 2026-09-18: training data comes from an open-weight teacher model, not Gemini** (the Gemini terms were not cleared, see `docs/GEMINI-TERMS-REVIEW.md`). Preparation phase: the desktop is not yet available, so every script is being finished and tested here first. No data has been collected, no model has been evaluated, and nothing has been trained.
**Date:** 2026-09-18
**Related:** `training/TRAINING-FORMAT.md`, `training/data/METHODOLOGY.md`, `training/eval/RESULTS*.md`, `docs/GENERATION.md`

---

## 1. The problem

The local fine-tuned model (Qwen2.5-7B-Instruct + LoRA) was trained on 288 examples of **plan generation**: turning a prompt into a ProjectSchema. It has never seen a single example of **code generation**. When it's used for *Generate Application*, it writes code that fails `npm run build`. Live runs showed examples such as `import { db: ordersDb }`, `db.exec(sql, [args])`, and a database variable used inside a browser page.

This is a gap in the training data, not a bug in the prompt or the pipeline. On the same plans, Gemini's code built successfully the first time.

**Goal:** make a local model a valid choice for writing code, reusing all of the existing generation pipeline without modifying it. That includes `component-codegen.ts`, `extractNamedExports`, the dependency-export context, the build-repair loop, and Blueprint verification.

## 2. Decisions made

| Decision | Choice |
|---|---|
| Model for **planning** | **Qwen2.5-7B-Instruct** + the existing plan adapter. Unchanged from today. |
| Model for **code** | **Qwen2.5-Coder-7B-Instruct** + a new code adapter. It's the same size as Instruct but trained much more heavily on source code. |
| Who picks the code model | **The user**, from the **Code** dropdown in the workspace: Gemini, Local code model, Anthropic, Bluesminds, or "Same as Model". Nothing switches models automatically. |
| One adapter or two | **Two separate adapters.** Config C showed that one change can quietly make a working behaviour worse. Separate adapters can be tested and rolled back on their own. |
| Where the training **data** comes from | **An open-weight teacher model, Qwen2.5-Coder-14B-Instruct (Apache-2.0), served from Colab** through the same server and the same pipeline. Gemini output is never used for training. |
| Where training runs | The borrowed desktop, as for the plan adapter. It's only needed for the GPU hours; everything else is prepared and tested on the laptop first and moved by git (adapters by pendrive). |
| Where serving runs | Google Colab (T4), as today. |

## 3. What the reading found

1. **None of Gemini's past code generations were saved.**
   - The project cache has 61 entries and 0 of them are `component-code`.
   - No file in `capture/` records a code prompt.
   - The 17 folders in `generated/` hold only final files, cover about 3 distinct plans, and several were written by the local model.
   - Recoverable examples: about 25. The data has to be collected fresh.
2. **The existing plan data can supply the code data.** The 288 validated plans contain:

   | Split | Plans | Frontend | Backend | Database | Security |
   |---|---|---|---|---|---|
   | gold (test only) | 47 | 93 | 68 | 80 | 26 |
   | real-project | 44 | 47 | 45 | 37 | 45 |
   | synthetic | 197 | 431 | 271 | 258 | 187 |

   The 47 gold plans hold 94 backend + security components. That's a ready-made test set, and it keeps the existing rule that gold data is never used for training.
3. **The plan adapter already sees a different prompt in use than in training.** `local_inference_server.py` (lines 396–398) adds `"\n\nReply with JSON matching exactly this schema:\n" + json.dumps(schema)` to the system prompt. The training rows in `training/formatted/dataset.jsonl` don't include that text. The plan adapter worked despite this, but code prompts and outputs are much longer, so the code adapter must be trained on exactly what the server sends (section 6).
4. **Today's broken local code came from the plan adapter.** That adapter was trained to always output a project plan, so it may be actively hurting code writing. Step 0 (section 9) measures the models with no adapter loaded.
5. **`train_full.py` isn't in the repo.** It has to be committed, so the settings of both adapters can be checked. RESULTS-CONFIG-C.md already ran into this problem once.

## 4. How it runs: training on the desktop, serving on Colab

```
Borrowed desktop (training)                Google Colab T4 (serving)
---------------------------                -------------------------
Qwen2.5-7B-Instruct  + 288 plan rows  ->   plan adapter  --\
                                                             >-> local_inference_server.py -> tunnel URL
Qwen2.5-Coder-7B     + code rows      ->   code adapter  --/
```

**Hard rule:** an adapter only loads on the base model it was trained on. The code adapter must be trained on `unsloth/qwen2.5-coder-7b-instruct-bnb-4bit` (or the equivalent Hugging Face name) and served on that same Coder model.

### Memory on the T4 (about 15 GB)

Planning and coding now use **two different base models**. Each takes about 5.5 GB in 4-bit, plus working memory during generation, which is largest for 4,096-token code files. There are two ways to run them.

| Setup | How | When to use |
|---|---|---|
| **One Colab session, both models** | The server loads both base models and routes each request by model name | If Step 0 shows it fits: about 11 GB of models plus room for a 4,096-token generation |
| **Two Colab sessions** | One notebook serves the planner, a second serves the coder, each with its own tunnel URL | If one session runs out of memory. Free Colab usually allows only one GPU session per account at a time, so this may need a second Google account or Colab Pro. |

The workspace supports **both** setups, because the local code model gets its **own URL box** (section 8). If both models run on the same server, you paste the same URL into both boxes.

## 5. Where the training data comes from

The plan is a fresh collection run: `scripts/capture-code-batch.mjs`, built in the same style as `capture-schema-batch.mjs`.

**Teacher:** Qwen2.5-Coder-14B-Instruct, no adapter, served from Colab by `local_inference_server.py` in `teacher` mode. It's Apache-2.0 licensed, so its output can be used for training. It takes about 9.5 GB in 4-bit, so it fits a T4; the 32B version does not.

1. For each of the **241 non-gold plans**, run the real `generateAndVerifyProject`, then `npm install`, `npm run build`, and the build-repair loop, with the **teacher as the code provider** and the cache switched off. This is exactly what the server does.
2. **Accept a component only if** the whole project builds, Blueprint reports no violations, the auth-bypass detector finds nothing, **and the live route check (metric D) passes for that component**. The training data is held to the same bar as the ship bar.
3. **Rebuild each accepted component's prompt from the final files.** Call the real `generateComponentFile` again, giving it the final files as context and a recording stub provider that returns the final code. `component-codegen.ts` runs unmodified. The prompt then describes exactly the dependency code the example is paired with, even if a dependency was rewritten during repair.
4. Save every attempt, failures included, one JSON line per record, written to disk immediately.

**Size of round 1:** 300–450 backend and security examples, drawn from 548 candidates minus projects that don't build. A 14B teacher will fail more often than Gemini did, so the yield is uncertain; the repair loop raises it. If the yield is under about 250, a second pass over the failed plans (with the repair instruction) is the first thing to try before changing the plan.
- That's the same count range that worked for plans: 91 examples taught the format, and 288 fixed the empty-constraint problem.
- Each code example is 3–5 times longer, so it's much more text to learn from, for a harder task.
- Frontend and database examples come out of the same run and are stored for later rounds.

**Collection cost:** about 2,500 teacher calls on a Colab T4. A 14B model on a T4 writes roughly 8 tokens a second, so a typical component takes 1–3 minutes and a full plan (with install, build and repairs) about 15–30 minutes. Over 241 plans that's about **60–120 hours of Colab time**, spread over many sessions, since free sessions end after a few hours. The collection script is resumable for exactly this reason: it skips plans already recorded and can be restarted with each new tunnel URL. Colab Pro would cut this to a few long sessions.

## 6. Training data format

Every training example must be built from **what the server actually receives**, never from a hand-written copy of the prompt.

| Part | Content |
|---|---|
| `system` | `COMPONENT_CODE_SYSTEM_PROMPT` + `"\n\nReply with JSON matching exactly this schema:\n"` + `json.dumps(COMPONENT_CODE_JSON_SCHEMA)`. It's built by the **same Python function** the server uses, moved into one shared function so the two can't drift apart. |
| `user` | The recorded `request.user`, exactly as `buildUserPrompt` produced it: the header lines, allowed imports, each dependency's `exports:` list and exact declarations, HTTP endpoints, and constraints. |
| `assistant` | `JSON.stringify({ code: finalFileContents })`, compact, the shape `extractCode` parses. |

- **Correction examples:** about 15% of rows pair a recorded `CORRECTION REQUIRED` prompt with its fixed file. They're counted separately, so their effect can be measured.
- **Nothing is silently shortened:** every row's length is measured with `render_ids`. A row longer than the training length limit is **dropped and reported**, because a shortened row would teach the model to stop mid-file.
- **Training settings stay the same as the plan runs:** r=16, alpha=16, lr 2e-4, 3 epochs. Config C showed that a lower training loss does not mean better real results.

## 7. How we test it

**Test set:** the 94 backend and security components of the 47 gold plans. The data is split by project, so no test project ever contributes training data.

**Harness: swap in one component at a time.**
1. Gemini builds each gold project fully. We keep only the projects that build and pass Blueprint.
2. For each component, **only that one file** is regenerated by the model under test, with exactly the same context.
3. The real `npm run build`, Blueprint check and auth-bypass detector run on the result.

**Setups compared:**

| Setup | What it shows |
|---|---|
| Gemini | The target to match |
| Plain Qwen2.5-7B-Instruct | How the model does without any adapter |
| Instruct + plan adapter | Today's behaviour (the failures seen live) |
| Plain Qwen2.5-Coder-7B | Coder's starting point before training |
| **Coder + code adapter** | The candidate |

**Metrics:**
- **A.** First-attempt pass rate (the build passes and Blueprint is clean, with no repair).
- **B.** Pass rate after repair, with the real repair loop allowed its normal 2 rounds.
- **C.** Whole-project build rate, when the local model writes every backend and security file.
- **D.** Runtime check: start the generated server and send a GET to each route the component serves; a route passes if it answers with a non-5xx status and the server stays up. For a security middleware, every route of the project is checked, since it runs on all of them. `orderGuard` passed both `tsc` and Blueprint but still blocked every GET request.

**Ship bar (all must hold):**
- **D passes on every accepted component** in the final evaluation. A component that passes `tsc` and Blueprint but fails its live route check counts as a failure, not a pass (decided 2026-09-18, per the `orderGuard` finding).
- A is at least **0.8 × Gemini's A**.
- B is within **10 points** of Gemini's B.
- A beats plain Coder's A by at least **15 points**, so the training actually earned its cost.
- The plan adapter's held-out results are unchanged.

With about 94 components, differences under about 10 points are noise, and the write-up will say so. Gemini's own pass rate has never been measured systematically. Step 0 measures it.

## 8. Changes to the code (small, additive)

The generation pipeline itself isn't changed.

**`pdsf/local_inference_server.py`**
- Accept `--model name=base:adapter` more than once, so it can serve the planner (Instruct + plan adapter) and the coder (Coder + code adapter). Either both run in one process, or each runs in its own Colab session (section 4).
- Choose the model from a new `model` field in each request. A request with no `model` field keeps today's default behaviour.
- Add a lock around generation.
- Move the system-prompt building into one shared function, which the training formatter also uses.

**`src/llm/local.ts`**
- Send `model` in the request body.
- Add `DEFAULT_LOCAL_CODE_MODEL`.
- Raise the request timeout for code requests: 4,096 tokens at about 12 tokens a second on a T4 takes longer than the current 300 seconds.

**`src/llm/select-provider.ts` and `src/llm/provider-registry.ts`**
- Add a new provider option, **`local-code`**, labelled **"Local code model (Qwen2.5-Coder)"**.
- It has **its own URL setting** (`llm.localCodeBaseUrl`), so the coder can run in the same Colab session or a separate one.

**UI (`ProviderPicker.tsx` and the provider type mirror)**
- The **Code** dropdown gains "Local code model (Qwen2.5-Coder)" and shows its own URL box and Connect button when it's selected.
- The **Model** (planning) dropdown is unchanged.

**What the user sees:**

| Dropdown | Options | Typical choice |
|---|---|---|
| **MODEL** (writes the plan) | Gemini · Local model (Qwen2.5-7B-Instruct) · Anthropic · Bluesminds | Local model |
| **CODE** (writes the code) | Same as Model · Gemini · Local code model (Qwen2.5-Coder) · Anthropic · Bluesminds | Local code model once it passes the ship bar; Gemini until then |

## 9. Round 1 and the timeline

**Scope:** backend and security components only (the same scope as the original code-generation Milestone 1). Frontend and database come in later rounds.

| Step | What | Estimate |
|---|---|---|
| **0** | On Colab, measure plain Instruct and plain Coder on the 94 gold components, plus Gemini. Also check whether both models fit in one T4 session. | about half a day |
| 1 | Write the collection, formatting and evaluation scripts; commit `train_full.py` | 2–3 days (in progress on the laptop) |
| 2 | Teacher collection over the 241 non-gold plans (Colab) | 60–120 h of Colab time across many sessions; a few minutes of your time per session to paste the new URL |
| 3 | Train the code adapter on Coder (borrowed desktop) | about 1.5–3 h of GPU time |
| 4 | Evaluate all 5 setups on the 94 components (Colab T4) | about 8–12 h of GPU time |
| 5 | Serving changes (section 8) | 1–2 days |
| 6 | Write-up: `training/eval/RESULTS-CODE-M1.md` | 1–2 days |

**Total:** about 2–3 weeks part-time. It's a new sub-project, comparable in size to the plan dataset (Aug 22 → Sep 12).

**Round 1 is done when** the ship bar is clearly met or clearly missed, the numbers are written up, all scripts and `train_full.py` are committed, and "Local code model" can be selected in the Code dropdown.

## 10. Open questions

1. ~~Gemini's terms of use.~~ **Checked, not cleared, and resolved by decision (2026-09-18): no Gemini output is used for training.** The teacher is Qwen2.5-Coder-14B-Instruct (section 5). Gemini still appears in the evaluation (section 7) as the comparison baseline only, which the terms don't restrict. Full quotes in `docs/GEMINI-TERMS-REVIEW.md`.
2. **Whether both models fit in one T4 session.** Step 0 answers this. If not, the coder needs its own Colab session and tunnel (already supported by the design in section 8), which may need a second Google account or Colab Pro.
3. ~~Whether the runtime check (metric D) counts toward the ship bar.~~ **Decided 2026-09-18: it counts.** D must pass on every accepted component (section 7).
4. **Changing `pdsf/local_inference_server.py`.** The file is currently untracked and has been left alone until now. The serving changes need it to be edited and committed.
5. **Whether the borrowed desktop is still available** for training, or training moves to Colab. Colab would take about 4–6 h per run, with saved checkpoints because free sessions end.
