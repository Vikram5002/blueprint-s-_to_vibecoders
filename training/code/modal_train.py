"""
Train the code adapter on Modal (docs/GPU-COMPUTE-PROPOSAL.md, C2).

Runs training/code/train_code.py UNCHANGED - same defaults (seed 42, the
train_full.py-mirrored hyperparameters) as the desktop RUNBOOK - inside a
container laid out like the repo, on one L40S. Only the host differs, and
summary.json records it.

  - Base weights cache in the shared vibe-hf-cache Volume (downloaded once).
  - The run directory (adapter/, adapter.zip, summary.json, checkpoints)
    lands in the vibe-runs Volume, committed as it goes, so a dropped
    connection loses nothing; `--resume` continues from the last checkpoint.
  - The local entrypoint then copies the run to training/runs/ on the MSI.

Usage (on the MSI):
    modal run training/code/modal_train.py                 # train, then download
    modal run training/code/modal_train.py --resume-run code_modal_<ts>
"""
import subprocess
import sys
import time
from pathlib import Path

import modal

REPO_LOCAL = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/repo")
HF_DIR = "/hf"
RUNS_DIR = "/runs"

app = modal.App("vibe-train")
hf_cache = modal.Volume.from_name("vibe-hf-cache", create_if_missing=True)
runs = modal.Volume.from_name("vibe-runs", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install("unsloth", "trl", "peft", "bitsandbytes", "accelerate", "datasets")
    .env({"HF_HOME": HF_DIR})
    .add_local_file(REPO_LOCAL / "training" / "code" / "train_code.py", "/repo/training/code/train_code.py")
    .add_local_file(REPO_LOCAL / "training" / "code" / "formatted" / "dataset.jsonl", "/repo/training/code/formatted/dataset.jsonl")
    .add_local_file(REPO_LOCAL / "pdsf" / "local_inference_server.py", "/repo/pdsf/local_inference_server.py")
)


@app.function(image=image, gpu="L40S", volumes={HF_DIR: hf_cache, RUNS_DIR: runs}, timeout=6 * 3600)
def train(run_name: str, resume: bool) -> str:
    out = f"{RUNS_DIR}/{run_name}"
    command = ["python", "/repo/training/code/train_code.py", "--out", out]
    if resume:
        command.append("--resume")
    started = time.time()
    try:
        subprocess.run(command, check=True, cwd="/repo")
    finally:
        runs.commit()
        hf_cache.commit()
    return f"{run_name} trained in {(time.time() - started) / 3600:.2f} h"


@app.local_entrypoint()
def main(resume_run: str = "") -> None:
    run_name = resume_run or time.strftime("code_modal_%Y%m%d_%H%M%S")
    print(train.remote(run_name, bool(resume_run)))
    local = REPO_LOCAL / "training" / "runs" / run_name
    local.mkdir(parents=True, exist_ok=True)
    for name in ("adapter.zip", "summary.json"):
        # `python -m modal`: the modal script is not on PATH on every machine (it is not on the MSI).
        subprocess.run([sys.executable, "-m", "modal", "volume", "get", "--force", "vibe-runs", f"{run_name}/{name}", str(local / name)], check=True)
    print(f"downloaded to {local}")
