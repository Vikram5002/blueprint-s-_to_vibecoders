"""
Serve both local models for the workspace from Modal, at a fixed address.

One process on one L4 (24 GB, about $0.80/h), two served names - the ones
src/llm/local.ts sends:

  - `local`:      Qwen2.5-7B-Instruct (4-bit) + the plan adapter
  - `local-code`: Qwen2.5-Coder-7B-Instruct (4-bit) + the code adapter

Both adapters are read from the vibe-runs Volume. Deployed (`modal deploy`),
so the address stays the same between sessions and nothing needs a terminal
open; the container starts on the first request (a minute or two, cold) and
shuts itself down after 5 idle minutes, so credit is spent only while the
workspace is actually asking it for something. Never more than one container.

Usage (on the MSI):
    modal deploy training/code/modal_serve.py      # prints the address
    modal app stop vibe-serve                      # take it down entirely
Then paste the address into the workspace's model menu - both fields.
"""
import os
import subprocess
from pathlib import Path

import modal

PLAN_BASE = "unsloth/qwen2.5-7b-instruct-unsloth-bnb-4bit"
CODE_BASE = "unsloth/qwen2.5-coder-7b-instruct-bnb-4bit"
PLAN_RUN = os.environ.get("VIBE_PLAN_RUN", "plan_run_20260822_130636")
CODE_RUN = os.environ.get("VIBE_CODE_RUN", "code_modal_20260927_212455")
PORT = 8712
HF_DIR = "/hf"
RUNS_DIR = "/runs"
SERVER = Path(__file__).resolve().parents[2] / "pdsf" / "local_inference_server.py" if modal.is_local() else Path("/app/local_inference_server.py")

app = modal.App("vibe-serve")
hf_cache = modal.Volume.from_name("vibe-hf-cache", create_if_missing=True)
runs = modal.Volume.from_name("vibe-runs", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.5.1", "transformers>=4.46,<5", "peft", "bitsandbytes", "accelerate", "huggingface_hub")
    .env({"HF_HOME": HF_DIR, "VIBE_PLAN_RUN": PLAN_RUN, "VIBE_CODE_RUN": CODE_RUN})
    .add_local_file(SERVER, "/app/local_inference_server.py")
)


@app.function(
    image=image,
    gpu="L4",
    volumes={HF_DIR: hf_cache, RUNS_DIR: runs},
    timeout=3600,
    scaledown_window=300,
    max_containers=1,
)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=1800)
def serve():
    subprocess.Popen(
        [
            "python", "/app/local_inference_server.py",
            "--host", "0.0.0.0",
            "--port", str(PORT),
            "--max-new-tokens-cap", "8192",
            "--model", f"local={PLAN_BASE}:{RUNS_DIR}/{os.environ['VIBE_PLAN_RUN']}/adapter",
            "--model", f"local-code={CODE_BASE}:{RUNS_DIR}/{os.environ['VIBE_CODE_RUN']}/adapter",
        ]
    )
