"""
An independent reference model on Modal, for the larger code-model evaluation.

Round 1's caveat (docs/RESULTS-CODE-M1.md): 23 of the 26 reference projects
were built by the same Qwen2.5-Coder-32B teacher that wrote the training data,
which may favour the adapter. This serves a DIFFERENT model -
Qwen3-Coder-30B-A3B-Instruct, 4-bit AWQ - that never produced training data,
so scripts/eval-code-model.mjs --build-reference can build a second reference
set the adapter has never seen the style of.

It is served by vLLM's OpenAI-compatible API, which the app's existing
`openai-compatible` provider talks to; nothing in the evaluation script changes.

Credit safety, as in modal_teacher.py:
  - `modal serve` (not `deploy`): the app exists only while that terminal is open.
  - scaledown_window: an idle GPU shuts down after 5 minutes.
  - max_containers=1, one L40S (~$1.95/h; an L4 leaves too little memory for 32k context).
  - The endpoint requires an API key (VIBE_REF_KEY, read from the local
    environment when serving), so the public URL is useless to anyone else.

Usage:
    modal run training/code/modal_reference.py::download          # once, CPU only, ~17 GB
    VIBE_REF_KEY=<random> modal serve training/code/modal_reference.py
Then:
    VIBE_LLM_PROVIDER=openai-compatible VIBE_OPENAI_BASE_URL=<url>/v1 \
    VIBE_OPENAI_API_KEY=<same random> VIBE_OPENAI_MODEL=reference \
    node scripts/eval-code-model.mjs --build-reference --reference-provider=openai-compatible \
        --reference=capture/code/gold-reference-qwen3
"""
import os
import subprocess

import modal

REFERENCE_REPO = "cyankiwi/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit"
PORT = 8000
HF_DIR = "/hf"

app = modal.App("vibe-reference")
hf_cache = modal.Volume.from_name("vibe-hf-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    # vLLM 0.10.2 breaks on transformers 5 (Qwen2Tokenizer lost an attribute it reads).
    .pip_install("vllm==0.10.2", "transformers==4.56.2", "huggingface_hub[hf_transfer]")
    .env({"HF_HOME": HF_DIR, "HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

# Read on the local machine when serving; shipped to the container as a secret.
key_secret = modal.Secret.from_dict({"VIBE_REF_KEY": os.environ.get("VIBE_REF_KEY", "")}) if modal.is_local() else modal.Secret.from_dict({})


@app.function(image=image, volumes={HF_DIR: hf_cache}, timeout=3600)
def download():
    """CPU only: fetch the weights into the shared Volume once."""
    from huggingface_hub import snapshot_download

    snapshot_download(REFERENCE_REPO)
    hf_cache.commit()
    print(f"cached {REFERENCE_REPO} in volume vibe-hf-cache")


@app.function(
    image=image,
    gpu="L40S",
    volumes={HF_DIR: hf_cache},
    secrets=[key_secret],
    timeout=3600,
    scaledown_window=300,
    max_containers=1,
)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=1800)
def reference():
    key = os.environ.get("VIBE_REF_KEY", "")
    if key == "":
        raise RuntimeError("VIBE_REF_KEY is empty - refusing to serve an open endpoint")
    subprocess.Popen(
        [
            "vllm", "serve", REFERENCE_REPO,
            "--served-model-name", "reference",
            "--host", "0.0.0.0",
            "--port", str(PORT),
            "--api-key", key,
            "--max-model-len", "32768",
            "--gpu-memory-utilization", "0.90",
        ]
    )
