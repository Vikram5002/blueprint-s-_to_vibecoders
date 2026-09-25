# GPU Compute Proposal — Finishing Round 1 of the Local Code Model

**Date:** 2026-09-25 · **Status:** proposed · **Owner:** vikram5002
**Related:** `LOCAL-CODE-MODEL-PLAN.md`, `GEMINI-TERMS-REVIEW.md`, `training/code/RUNBOOK.md`

---

## 1. Problem

Round 1 of the local code model (Qwen2.5-Coder-7B + a code LoRA) needs GPU work that
no machine we currently have can do:

| Machine | GPU | Can run the 32B teacher? | Can train 7B LoRA (seq 6144)? |
|---|---|---|---|
| MSI laptop (daily machine) | GTX 1650 Max-Q, 4 GB | No | No |
| Colab free | T4, 16 GB | No (14B only, weak) | Unreliable (disconnects) |
| Borrowed desktop | RTX 4500 Ada, 24 GB | Yes | Yes — **not yet available** |
| AWS ($100 credit) | g6e / g6 | Yes | Yes — **GPU quota pending** (case 179023866500394) |

Waiting on AWS or the desktop blocks the programme for an unknown time.

## 2. Proposal

**Use Modal (modal.com) as the interim GPU provider, and switch to AWS or the
desktop as soon as either one becomes available.** The MSI stays the control centre
throughout.

Modal's free Starter plan gives **$30 of compute credit per month** (no rollover),
per-second billing, and no quota approval. An L40S (48 GB) costs ~$1.95/h, so
$30 ≈ 15 L40S hours a month. (Pricing checked 2026-09-25.)

## 3. Options considered

| Option | Teacher | Est. total time | Cost | Verdict |
|---|---|---|---|---|
| AWS g6e (L40S) | 32B | ~2–3 days | ~$40–60 of credit | Best, but blocked on quota |
| **Modal (L40S)** | **32B** | **~5–6 weeks** | **Free (2 months of ≤ $30 credit)** | **Chosen interim** |
| Kaggle (2× T4) | 32B, 4-bit, split | ~4–5 weeks | Free | Backup |
| MSI + Colab T4 | 14B | ~3–4 weeks | Free | Weaker data; fallback only |
| Free APIs (e.g. OpenRouter) | 32B, unknown quantisation | ~1–2 weeks | Free | Provenance unclear; supplementary only |
| MSI GPU alone | — | — | — | Cannot fit a 7B model |

## 4. Work breakdown

### Phase A — MSI, no GPU (start now, runs in parallel)

| # | Task | Needs |
|---|---|---|
| A1 | Per-file acceptance in capture: keep every file that compiles and passes route, Blueprint and auth-bypass checks, even when another file in the project fails. Re-score the 7 existing 14B plans. | Code only |
| A2 | Gold reference set: Gemini generates the 47 held-out plans; keep only fully passing projects. **Evaluation only — never training data;** stored in a folder no training script reads. | Gemini keys, 1–2 days |
| A3 | Gemini baseline on the 94 gold components (ship-bar reference). | Gemini keys, ~1 day |
| A4 | Modal wrapper: load the 32B once from a persistent Volume, run capture in batch, auto-stop, write records locally. Tested on the MSI/Colab first. | Code only, ~½ day |

### Phase B — Modal month 1 (~$25–28 of $30)

| # | Task | L40S hours | Cost |
|---|---|---|---|
| B1 | Setup: download Qwen2.5-Coder-32B-Instruct-AWQ (~19 GB) once into a Modal Volume; 5-file speed test | 1–2 | ~$3 |
| B2 | Teacher collection, capped at ~450 component files, resumable | ≤ 11 | ≤ ~$21 |

### Phase C — Modal month 2 (~$20–27 of $30)

| # | Task | L40S hours | Cost |
|---|---|---|---|
| C1 | Step 0 baseline: plain Qwen2.5-Coder-7B on the 94 gold components | 1.5–2 | ~$4 |
| C2 | Train the code adapter (`train_code.py`, hyperparameters mirrored from `train_full.py`) | 3–4 | ~$7 |
| C3 | Evaluate the trained model against the ship bar | 1.5–2 | ~$4 |
| C4 | Reserve: one retry / second training run | 4–6 | ~$10 |

### Phase D — Report

`RESULTS-CODE-M1.md`, docs pass (`GENERATION.md`, helper README).

## 5. Switch-over rule

When AWS or the desktop becomes available, the **remaining** tasks move there and
Modal becomes the backup. Nothing is redone, because:

- **Outputs are plain files:** teacher records (JSONL), adapters and eval results
  are pulled to the MSI and backed up to `E:\qwen_coder`.
- **Capture is resumable:** plans already recorded are skipped on any machine.
- **Scripts are shared:** only the thin Modal wrapper is Modal-specific; the
  desktop RUNBOOK is unchanged.
- **Provenance per record:** every record stores the teacher model, quantisation and
  host (e.g. `Qwen2.5-Coder-32B-Instruct · AWQ-4bit · modal-L40S`), so mixed-host
  data stays traceable in the paper.
- **Fixed training config:** seed 42 and the `train_full.py`-mirrored hyperparameters
  on every host.

## 6. Ship bar (unchanged)

- D (live route check) passes on every accepted component.
- A ≥ 0.8 × Gemini; B within 10 points of Gemini.
- ≥ 15 points over the plain Qwen2.5-Coder-7B.
- The plan adapter is untouched.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Credit overrun | Workspace spending limit set by the owner; auto-stop after each batch; all debugging done off-Modal |
| Repeated 32B downloads | AWQ 4-bit weights cached once in a Modal Volume |
| 32B too slow in the B1 speed test | Switch the remaining collection to Kaggle, or to the 14B teacher |
| Low teacher yield | Per-file acceptance (A1); plan more held-in prompts if needed |
| Free tier changes | Re-check pricing each month; Kaggle backup ready |
| Data-policy breach | Gemini output is evaluation-only (see `GEMINI-TERMS-REVIEW.md`); Qwen outputs are Apache-2.0 |
| Credentials | Owner creates the account, runs `modal setup`, enters any card details; nothing is stored in the repo |

## 8. Timeline (estimate)

| Week | Work |
|---|---|
| 1 | A1, A4, Modal account; A2/A3 start |
| 1–2 | B1, B2 (month-1 credits) |
| 3 (the month after the Modal account is created) | C1–C3 |
| 4 | C4 if needed; Phase D |

Round 2 (frontend and database models) is **out of scope** here; it needs further
months of credit, AWS or the desktop.

## 9. Decision requested

1. Approve Modal as the interim GPU provider.
2. Approve per-file acceptance (A1).
3. Owner: create the Modal account and set the spending limit.
