"""
The 32B teacher on Modal (docs/GPU-COMPUTE-PROPOSAL.md, A4/B1/B2).

Modal only hosts the model. The capture pipeline (generate -> build -> repair
-> Blueprint -> route check) keeps running on the MSI and talks to this over
HTTP exactly as it talks to the Colab tunnel or the desktop, so nothing in
scripts/capture-code-batch.mjs is Modal-specific and records stay
comparable across hosts.

Credit safety, by construction:
  - `modal serve` (not `deploy`): the app exists only while that terminal is
    open. Ctrl+C stops it.
  - scaledown_window: an idle GPU shuts down after 5 minutes.
  - max_containers=1: never more than one L40S billing at a time.
  - Weights live in a Modal Volume, downloaded once by a CPU-only function.

Usage (on the MSI, after `pip install modal` and `modal setup`):
    modal run training/code/modal_teacher.py::download     # once, CPU only, ~19 GB
    modal serve training/code/modal_teacher.py             # prints the teacher URL
Then, in a second terminal:
    node scripts/capture-code-batch.mjs --local=<url> --model=teacher \
        --out=capture/code/teacher-32b-modal-batch-1.jsonl --teacher-host=modal-L40S --limit=1
"""
import subprocess
from pathlib import Path

import modal

TEACHER_REPO = "unsloth/Qwen2.5-Coder-32B-Instruct-bnb-4bit"
PORT = 8712
HF_DIR = "/hf"
# Resolved on the MSI only: inside the container this module sits at /root/
# and the repo is not there (the server file arrives via add_local_file).
SERVER = Path(__file__).resolve().parents[2] / "pdsf" / "local_inference_server.py" if modal.is_local() else Path("/app/local_inference_server.py")

app = modal.App("vibe-teacher")
hf_cache = modal.Volume.from_name("vibe-hf-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.5.1", "transformers>=4.46,<5", "peft", "bitsandbytes", "accelerate", "huggingface_hub")
    .env({"HF_HOME": HF_DIR})
    .add_local_file(SERVER, "/app/local_inference_server.py")
)


@app.function(image=image, volumes={HF_DIR: hf_cache}, timeout=3600)
def download():
    """CPU only: fetch the teacher weights into the Volume once."""
    from huggingface_hub import snapshot_download

    snapshot_download(TEACHER_REPO)
    hf_cache.commit()
    print(f"cached {TEACHER_REPO} in volume vibe-hf-cache")


@app.function(
    image=image,
    gpu="L40S",
    volumes={HF_DIR: hf_cache},
    timeout=1800,
    scaledown_window=300,
    max_containers=1,
)
@modal.web_server(port=PORT, startup_timeout=1800)
def teacher():
    subprocess.Popen(
        [
            "python", "/app/local_inference_server.py",
            "--host", "0.0.0.0",
            "--port", str(PORT),
            "--max-new-tokens-cap", "8192",
            "--model", f"teacher={TEACHER_REPO}",
        ]
    )
