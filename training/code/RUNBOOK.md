# Code adapter: desktop training runbook

The borrowed desktop is only a GPU. Everything here is "clone, place data, run
one command, copy two files back". Nothing is decided on the desktop.

What gets trained: a LoRA adapter on **Qwen2.5-Coder-7B-Instruct** (4-bit via
Unsloth) from `training/code/formatted/dataset.jsonl`. The plan adapter
(Qwen2.5-7B-Instruct) is unchanged. Same hyperparameters as the plan runs:
r=16, alpha=16, lr 2e-4, 3 epochs, batch 2, no dropout, no prompt masking
(`training/train_full.py`).

## Before you go

- `dataset.jsonl` and `manifest.json` exist in `training/code/formatted/`
  (produced by `training/code/format-code-dataset.py` from the capture JSONL;
  the teacher was Qwen2.5-Coder-14B-Instruct, never Gemini - the formatter
  refuses Gemini-teacher rows).
- Either they are committed and pushed, or they are on the pendrive. If on the
  pendrive, note the manifest's `output.sha256` so you can check the copy.
- Optional but useful: the pendrive also carries a Hugging Face cache of
  `unsloth/qwen2.5-coder-7b-instruct-bnb-4bit` (~5.5 GB) if the desktop's
  internet is slow.

## On the desktop

1. Clone or pull:
   ```
   git clone <repo-url> blueprint && cd blueprint
   # or, if already there:  git pull
   ```
2. Python 3.10+ with an NVIDIA driver. Create an env and install torch for the
   desktop's CUDA first, then the rest:
   ```
   python -m venv .venv && .venv\Scripts\activate      # Windows
   pip install torch --index-url https://download.pytorch.org/whl/cu124
   pip install -r training/code/requirements-desktop.txt
   python -c "import torch; print(torch.cuda.get_device_name(0))"
   ```
3. Place the data if it did not come with git:
   ```
   copy E:\dataset.jsonl  training\code\formatted\dataset.jsonl
   copy E:\manifest.json  training\code\formatted\manifest.json
   ```
4. The one command:
   ```
   python training/code/train_code.py
   ```
   It creates `training/runs/code_<timestamp>/` with `adapter/`, `adapter.zip`
   and `summary.json`. The first lines print token counts per row - they must
   be in the hundreds or thousands, not single digits
   (`training/TRAINING-FORMAT.md`, the apply_chat_template bug).

   If the session is interrupted, continue the same run:
   ```
   python training/code/train_code.py --resume --out training/runs/code_<timestamp>
   ```

### Expected time and memory

Reference: the plan adapter, 288 rows of ~1-2k tokens each, 3 epochs, took
about 1.5-3 h and peaked at **9.37 GB** VRAM (`RESULTS-run_20260912_154324.md`,
`docs/LOCAL-CODE-MODEL-PLAN.md` section 9). Code rows are 3-5x longer
(up to 6144 tokens), so expect:

- VRAM: 10-14 GB peak at batch 2. A 12 GB card may need `--batch 1 --grad-accum 8`
  (same effective batch of 8).
- Time: 2-5 h for 300-450 rows, 3 epochs.

`summary.json` records the measured numbers; put them in
`training/eval/RESULTS-CODE-M1.md`.

## What to copy back

Two files from `training/runs/code_<timestamp>/`:

| File | Size | Where it goes |
|---|---|---|
| `summary.json` | KB | commit it to `training/runs/code_<timestamp>/summary.json` |
| `adapter.zip` | ~150 MB | pendrive only. **Never `git add` it** - GitHub rejects files over 100 MB and the push would fail. |

`.gitignore` already ignores `training/runs/*/adapter/`, `adapter.zip` and
`checkpoint-*/`, so `git add training/runs/code_<timestamp>/summary.json` is
safe and nothing large can be staged by accident. Check `git status` anyway.

## Handing the adapter to Colab

`adapter.zip` already has the adapter files at the zip root with `/`
separators (train_code.py writes it that way; do not re-zip with
`Compress-Archive` on the folder, see the notebook's note on backslashes).

In `docs/colab/vibe-local-model-colab.ipynb`:

1. Set `MODE = 'plan+code'` in the Mode cell.
2. In the upload cell, upload `adapter.zip` (plan adapter) **and**
   `code_adapter.zip` - so rename the desktop's `adapter.zip` to
   `code_adapter.zip` first. Plus `local_inference_server.py`.
3. The server cell starts both models; the smoke-test cell prints
   `GET /models`, which must list `local` and `local-code` - the names
   `src/llm/local.ts` sends for the planner and the coder.

If the T4 runs out of memory with both bases loaded, run two sessions
(`MODE = 'plan'` in one, and a second notebook with the code adapter), each
with its own tunnel URL - the workspace has a separate URL box for the code
model (`docs/LOCAL-CODE-MODEL-PLAN.md` section 4).

## Not done here

- No evaluation. That is the Colab harness over the 94 gold components
  (`docs/LOCAL-CODE-MODEL-PLAN.md` section 7).
- `train_full.py` (the plan adapters' script) is in the repo at
  `training/train_full.py`; `train_code.py`'s defaults mirror it (the header
  of `train_code.py` lists the one forced difference, sequence length).
