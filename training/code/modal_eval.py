"""
Serve the code model for evaluation on Modal (docs/GPU-COMPUTE-PROPOSAL.md, C1/C3).

One process, one L40S, two served names over the SAME 4-bit base weights:

  - `base`: plain Qwen2.5-Coder-7B-Instruct            (C1 - the baseline)
  - `code`: the same base + the trained code adapter   (C3 - what is tested)

so the two are compared on identical weights, hardware and server code; the
adapter is the only difference. The adapter is read from the vibe-runs Volume
that modal_train.py wrote it to. scripts/eval-code-model.mjs runs on the MSI
and picks a model per run with `--candidate=<url>,model=base|code`.

Same credit safety as modal_teacher.py: `modal serve` only while the terminal
is open, 5-minute idle shutdown, never more than one container.

Usage (on the MSI):
    modal serve training/code/modal_eval.py
    set VIBE_CODE_RUN=code_modal_20260927_212455   (optional - that run is the default)
"""
import os
import subprocess
from pathlib import Path

import modal

BASE_REPO = "unsloth/qwen2.5-coder-7b-instruct-bnb-4bit"
RUN = os.environ.get("VIBE_CODE_RUN", "code_modal_20260927_212455")
PORT = 8712
HF_DIR = "/hf"
RUNS_DIR = "/runs"
SERVER = Path(__file__).resolve().parents[2] / "pdsf" / "local_inference_server.py" if modal.is_local() else Path("/app/local_inference_server.py")

app = modal.App("vibe-eval")
hf_cache = modal.Volume.from_name("vibe-hf-cache", create_if_missing=True)
runs = modal.Volume.from_name("vibe-runs", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.5.1", "transformers>=4.46,<5", "peft", "bitsandbytes", "accelerate", "huggingface_hub")
    .env({"HF_HOME": HF_DIR, "VIBE_CODE_RUN": RUN})
    .add_local_file(SERVER, "/app/local_inference_server.py")
)


@app.function(
    image=image,
    gpu="L40S",
    volumes={HF_DIR: hf_cache, RUNS_DIR: runs},
    timeout=1800,
    scaledown_window=300,
    max_containers=1,
)
@modal.web_server(port=PORT, startup_timeout=1800)
def serve():
    adapter = f"{RUNS_DIR}/{os.environ['VIBE_CODE_RUN']}/adapter"
    subprocess.Popen(
        [
            "python", "/app/local_inference_server.py",
            "--host", "0.0.0.0",
            "--port", str(PORT),
            "--max-new-tokens-cap", "8192",
            "--model", f"base={BASE_REPO}",
            "--model", f"code={BASE_REPO}:{adapter}",
        ]
    )
