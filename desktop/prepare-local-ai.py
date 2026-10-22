"""Build-only: convert the existing adapters; never change the source archives.

Requires Python with torch, transformers, safetensors, numpy and gguf dependencies.
The shipped app needs neither Python nor a training environment.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "vendor" / "local-ai-build"
OUT = ROOT / "vendor" / "local-ai"
TAG = "b11572"


def digest(file):
    sha = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def download(url, dest, sha=None):
    if not dest.exists():
        print("Downloading", dest.name, flush=True)
        urllib.request.urlretrieve(url, dest)
    if sha and digest(dest) != sha:
        raise RuntimeError(f"Checksum mismatch: {dest}")


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    runtime_sha = "fcec3f8c8bbe81ae5d6c781be1bfaf8b365ac89632cd5d4545f94e285d13a0e1"
    runtime = WORK / f"llama-{TAG}-bin-win-vulkan-x64.zip"
    download(f"https://github.com/ggml-org/llama.cpp/releases/download/{TAG}/{runtime.name}", runtime, runtime_sha)
    with zipfile.ZipFile(runtime) as archive:
        archive.extractall(OUT / "runtime")
    source = WORK / f"{TAG}.zip"
    download(f"https://github.com/ggml-org/llama.cpp/archive/refs/tags/{TAG}.zip", source, "d2454093f8858e76ca9bec641e31ea7c28c551951ca8c3de8e6b9218fe7d6965")
    with zipfile.ZipFile(source) as archive:
        archive.extractall(WORK)
    llama = WORK / f"llama.cpp-{TAG}"
    (OUT / "LICENSE-llama.cpp").write_bytes((llama / "LICENSE").read_bytes())
    models = [
        # Round 4: trained only on complete plans - 75 of 86 held-out prompts got a complete plan against 20 for round 3.
        {"id": "local", "label": "Planner · round 4 · 331 complete plans", "adapter": "planner_r4", "archive": "plan_r4.zip",
         "sourceSha256": "35403e5b3b44d37d3b4d022fd4231b01b37fd36eae5d3fe5847c927716402355",
         "base": "Qwen/Qwen2.5-7B-Instruct", "baseRevision": "a09a35458c702b33eeacc393d103063234e8bc28", "revision": "bb5d59e06d9551d752d08b292a50eb208b07ab1f",
         "files": [
             ["qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf", 3993201344, "dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db"],
             ["qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf", 689872288, "539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a"]]},
        {"id": "local-code", "label": "Coder · round 1 · 403 examples", "adapter": "code_modal_20260927_212455", "archive": "code_adapter.zip",
         "sourceSha256": "42855369d8b1a647c5fc47f40ec513695a915adfa8180dc104c71f7bee9c9846",
         "base": "Qwen/Qwen2.5-Coder-7B-Instruct", "baseRevision": "c03e6d358207e414f1eca0bb1891e29f1db0e242", "revision": "13fb94bfda8c8cf22497dc57b78f391a9acb426a",
         "files": [["qwen2.5-coder-7b-instruct-q4_k_m.gguf", 4683073536, "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c"]]},
        # Repairs only (src/llm/provider-registry.ts LOCAL_REPAIR_MODEL): round 1 writes, round 4 fixes - 95.7% after repair against 87.0%.
        {"id": "local-fix", "label": "Repair coder · round 4", "adapter": "code_rich_r4", "archive": "code_adapter_r4.zip",
         "sourceSha256": "21806c5294b223046f39d6b6373de4603c6b7b36ab52a240234b859d64282b66",
         "base": "Qwen/Qwen2.5-Coder-7B-Instruct", "baseRevision": "c03e6d358207e414f1eca0bb1891e29f1db0e242", "revision": "13fb94bfda8c8cf22497dc57b78f391a9acb426a",
         "files": [["qwen2.5-coder-7b-instruct-q4_k_m.gguf", 4683073536, "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c"]]},
    ]
    for model in models:
        archive_path = ROOT.parent / "pdsf" / model["archive"]
        if digest(archive_path) != model["sourceSha256"]:
            raise RuntimeError(f"Unexpected source adapter: {archive_path}")
        adapter_dir = WORK / model["id"]
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(adapter_dir)
        config = next(adapter_dir.rglob("adapter_config.json"))
        base_dir = WORK / (model["id"] + "-config")
        base_dir.mkdir(exist_ok=True)
        config_sha = {"local": "7463bb0ea78315365e6c6b74de4e73bbcc8359dfb0c5a737584e077d42c0b03c", "local-code": "c0242402ad6a13b331ea320feea8c7e3776ffb7a4eff0757b9cd667e116d9a28", "local-fix": "c0242402ad6a13b331ea320feea8c7e3776ffb7a4eff0757b9cd667e116d9a28"}[model["id"]]
        download(f"https://huggingface.co/{model['base']}/raw/{model['baseRevision']}/config.json", base_dir / "config.json", config_sha)
        dest = OUT / (model["adapter"] + ".gguf")
        env = {**os.environ, "PYTHONPATH": str(llama / "gguf-py"), "PYTHONDONTWRITEBYTECODE": "1"}
        subprocess.run([sys.executable, str(llama / "convert_lora_to_gguf.py"), str(config.parent), "--base", str(base_dir), "--outtype", "f16", "--outfile", str(dest)], env=env, check=True)
        model["adapterFile"] = dest.name
        model["adapterSha256"] = digest(dest)
        model["files"] = [{"name": name, "bytes": size, "sha256": sha,
                            "url": f"https://huggingface.co/{model['base']}-GGUF/resolve/{model['revision']}/{name}"}
                           for name, size, sha in model["files"]]
        download(f"https://huggingface.co/{model['base']}-GGUF/raw/{model['revision']}/LICENSE", OUT / (model["id"] + "-LICENSE"))
    manifest = {"version": 1, "runtime": TAG, "runtimeSha256": runtime_sha, "models": models}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("Prepared", OUT, flush=True)


if __name__ == "__main__":
    main()
