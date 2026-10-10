"""
QLoRA fine-tune of the CODE adapter on Qwen2.5-Coder-7B-Instruct (Unsloth).

Second-round command on the borrowed desktop (see RUNBOOK.md):
    python training/code/train_code.py --round 2

Hyperparameters default to the values the plan adapter was trained with
(training/eval/RESULTS-run_20260912_154324.md: r=16, lora_alpha=16, lr=2e-4,
3 epochs, batch_size=2, no dropout). docs/LOCAL-CODE-MODEL-PLAN.md section 6:
"Training settings stay the same as the plan runs."

Diffed against training/train_full.py (the plan adapters' real script,
recovered 2026-09-18). Defaults below MIRROR it so the two adapters differ in
as little as possible - the Config C lesson is that one changed variable can
quietly change behaviour:
  - same: r=16, alpha=16, dropout 0, all 7 projection target_modules,
    lr 2e-4, 3 epochs, batch 2, gradient accumulation 1, seed 42, TRL/HF
    default optimizer (adamw_torch), no warmup, no weight decay, linear
    schedule, gradient checkpointing.
  - same: NO loss masking on the prompt. train_full.py trains SFTTrainer on
    the full rendered chat text. --mask-prompt turns masking on as an
    explicit experiment, recorded in summary.json.
  - different, forced by the data: max_seq_length 6144 (was 2048; code rows
    are 3-5x longer). Nothing else.
Every value lands in summary.json, so a later reader never has to rediscover
this.

What it does:
  1. loads --base in 4-bit through Unsloth's FastLanguageModel
  2. reads --data ({system, user, assistant} rows from format-code-dataset.py)
  3. renders each row with tokenizer.apply_chat_template via render_ids (the
     return-type workaround from training/TRAINING-FORMAT.md), and masks the
     loss on every prompt token so the adapter trains on the assistant turn only
  4. trains with transformers.Trainer
  5. writes <out>/adapter/, <out>/adapter.zip (contents at zip root, forward
     slashes - what the Colab notebook's extract cell expects) and
     <out>/summary.json with EVERY hparam (the gap RESULTS-CONFIG-C.md hit).
"""
import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "pdsf"))

from local_inference_server import render_ids  # noqa: E402  (torch-free import)

DEFAULT_BASE = "unsloth/qwen2.5-coder-7b-instruct-bnb-4bit"
DEFAULT_DATA = os.path.join(HERE, "formatted", "dataset.jsonl")
ROUND_TWO_DATA = os.path.join(HERE, "formatted-r2", "dataset.jsonl")
DEFAULT_TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default=DEFAULT_BASE)
    p.add_argument("--data", default=None)
    p.add_argument("--round", dest="training_round", choices=("1", "2"), default=None,
                   help="training-data round; round 2 defaults to formatted-r2/dataset.jsonl")
    p.add_argument("--validate-data-only", action="store_true",
                   help="validate JSONL and its sibling manifest without loading model/training packages")
    p.add_argument("--out", default=None, help="default training/runs/code_<timestamp>")
    p.add_argument("--epochs", type=float, default=3)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--r", type=int, default=16)
    p.add_argument("--alpha", type=int, default=16)
    p.add_argument("--dropout", type=float, default=0.0)
    p.add_argument("--batch", type=int, default=2)
    p.add_argument("--grad-accum", type=int, default=1)
    p.add_argument("--max-seq-len", type=int, default=6144)
    p.add_argument("--warmup-steps", type=int, default=0)
    p.add_argument("--weight-decay", type=float, default=0.0)
    p.add_argument("--scheduler", default="linear")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--optim", default="adamw_torch", help="train_full.py used TRL's default; train_sweep.py used adamw_8bit")
    p.add_argument("--mask-prompt", action="store_true",
                   help="train on the assistant turn only (train_full.py did NOT mask; off by default to match it)")
    p.add_argument("--save-steps", type=int, default=25, help="checkpoint cadence for --resume")
    p.add_argument("--logging-steps", type=int, default=1)
    p.add_argument("--resume", action="store_true",
                   help="continue from the latest checkpoint in --out (pass the same --out)")
    return p.parse_args(argv)


def git_commit():
    try:
        return subprocess.check_output(["git", "-C", REPO, "rev-parse", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return None


def read_rows(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            for key in ("system", "user", "assistant"):
                if not isinstance(row.get(key), str):
                    raise SystemExit(f"{path}:{line_no}: row is missing string field {key!r}")
            rows.append(row)
    if not rows:
        raise SystemExit(f"{path}: no rows")
    return rows


def validate_dataset_manifest(path, rows):
    """Verify a sibling dataset manifest before a training run uses it."""
    manifest_path = os.path.join(os.path.dirname(os.path.abspath(path)), "manifest.json")
    if not os.path.isfile(manifest_path):
        return None

    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    output = manifest.get("output")
    if not isinstance(output, dict):
        raise SystemExit(f"{manifest_path}: missing output metadata")

    expected_path = output.get("path")
    if isinstance(expected_path, str):
        expected_abs = os.path.abspath(os.path.join(REPO, expected_path))
        if expected_abs != os.path.abspath(path):
            raise SystemExit(f"{manifest_path}: describes {expected_path}, not {path}")

    expected_hash = output.get("sha256")
    if not isinstance(expected_hash, str) or len(expected_hash) != 64:
        raise SystemExit(f"{manifest_path}: missing output SHA-256")
    with open(path, "rb") as fh:
        actual_hash = hashlib.sha256(fh.read()).hexdigest()
    if actual_hash != expected_hash:
        raise SystemExit(f"{path}: SHA-256 does not match {manifest_path}")

    expected_rows = output.get("rows")
    if expected_rows != len(rows):
        raise SystemExit(f"{manifest_path}: records {expected_rows!r} does not match dataset rows {len(rows)}")

    teachers = output.get("byTeacher")
    if (not isinstance(teachers, dict)
            or any(not isinstance(count, int) or count < 0 for count in teachers.values())
            or sum(teachers.values()) != len(rows)):
        raise SystemExit(f"{manifest_path}: teacher counts do not match dataset rows")
    if any("gemini" in teacher.lower() for teacher in teachers if isinstance(teacher, str)):
        raise SystemExit(f"{manifest_path}: Gemini-generated data is forbidden for training")
    return {
        "path": os.path.relpath(manifest_path, REPO).replace(os.sep, "/"),
        "sha256": hashlib.sha256(json.dumps(manifest, sort_keys=True).encode("utf-8")).hexdigest(),
        "dataset_sha256": actual_hash,
    }


def encode_row(tokenizer, row, max_seq_len, mask_prompt):
    """
    input_ids for the whole conversation. With mask_prompt, labels = -100
    over the prompt (system + user + the assistant header the generation
    prompt adds) and real ids over the assistant turn; without it (the
    default, matching train_full.py) labels = input_ids. The prompt render
    must be a strict prefix of the full render, which is checked rather than
    assumed.
    """
    prompt_msgs = [
        {"role": "system", "content": row["system"]},
        {"role": "user", "content": row["user"]},
    ]
    full_msgs = prompt_msgs + [{"role": "assistant", "content": row["assistant"]}]
    prompt_ids = list(render_ids(tokenizer, prompt_msgs, tokenize=True, add_generation_prompt=True))
    full_ids = list(render_ids(tokenizer, full_msgs, tokenize=True))
    if full_ids[: len(prompt_ids)] != prompt_ids:
        raise SystemExit("prompt render is not a prefix of the full render - chat template mismatch")
    if len(full_ids) > max_seq_len:
        raise SystemExit(
            f"row renders to {len(full_ids)} tokens > --max-seq-len {max_seq_len}. "
            "format-code-dataset.py should have dropped it; never truncate here "
            "(a truncated row teaches the model to stop mid-file)."
        )
    labels = ([-100] * len(prompt_ids) + full_ids[len(prompt_ids):]) if mask_prompt else list(full_ids)
    return {"input_ids": full_ids, "attention_mask": [1] * len(full_ids), "labels": labels}


def zip_adapter(adapter_dir, zip_path):
    """Contents at the zip root with '/' separators (never the folder itself)."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(adapter_dir):
            for name in sorted(files):
                full = os.path.join(root, name)
                arc = os.path.relpath(full, adapter_dir).replace(os.sep, "/")
                zf.write(full, arc)


def main(argv=None):
    args = parse_args(argv)
    args.data = args.data or (ROUND_TWO_DATA if args.training_round == "2" else DEFAULT_DATA)
    normalized_data = os.path.normpath(os.path.abspath(args.data)).replace("\\", "/")
    inferred_round = "2" if "/formatted-r2/" in normalized_data else "1"
    training_round = args.training_round or inferred_round
    if args.training_round is not None and args.training_round != inferred_round:
        raise SystemExit(f"--round {args.training_round} does not match the selected dataset path ({inferred_round})")
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out = args.out or os.path.join(REPO, "training", "runs", f"code_r{training_round}_{stamp}")
    if args.resume and not args.out:
        raise SystemExit("--resume needs --out pointing at the run to continue")

    rows = read_rows(args.data)
    data_manifest = validate_dataset_manifest(args.data, rows)
    if training_round == "2" and data_manifest is None:
        raise SystemExit("round 2 requires a valid sibling manifest.json")
    print(f"rows: {len(rows)} from {args.data}")
    if args.validate_data_only:
        print(json.dumps({
            "task": f"component code generation (round {training_round})",
            "data": os.path.relpath(args.data, REPO).replace(os.sep, "/") if os.path.isabs(args.data) else args.data,
            "rows": len(rows),
            "data_manifest": data_manifest,
            "training_started": False,
        }, indent=2))
        return

    os.makedirs(out, exist_ok=True)

    import torch
    from unsloth import FastLanguageModel
    from datasets import Dataset
    from transformers import DataCollatorForSeq2Seq, Trainer, TrainingArguments
    import transformers, peft, unsloth  # noqa: E401 - versions for summary.json

    print(f"loading {args.base} (4-bit) ...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base,
        max_seq_length=args.max_seq_len,
        dtype=None,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.r,
        lora_alpha=args.alpha,
        lora_dropout=args.dropout,
        target_modules=DEFAULT_TARGET_MODULES,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=args.seed,
    )

    encoded = [encode_row(tokenizer, row, args.max_seq_len, args.mask_prompt) for row in rows]
    lengths = [len(e["input_ids"]) for e in encoded]
    trained_tokens = [sum(1 for t in e["labels"] if t != -100) for e in encoded]
    # TRAINING-FORMAT.md: re-verify counts look sane in every new environment.
    print(f"tokens/row: min {min(lengths)} max {max(lengths)} mean {sum(lengths) / len(lengths):.0f}; "
          f"assistant tokens/row mean {sum(trained_tokens) / len(trained_tokens):.0f}")
    if min(lengths) < 20:
        raise SystemExit("a row rendered to <20 tokens - the render_ids workaround is not effective here")
    dataset = Dataset.from_list(encoded)

    bf16 = torch.cuda.is_bf16_supported()
    training_args = TrainingArguments(
        output_dir=out,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        warmup_steps=args.warmup_steps,
        weight_decay=args.weight_decay,
        lr_scheduler_type=args.scheduler,
        logging_steps=args.logging_steps,
        save_steps=args.save_steps,
        save_total_limit=2,
        optim=args.optim,
        bf16=bf16,
        fp16=not bf16,
        seed=args.seed,
        report_to="none",
        group_by_length=True,
        remove_unused_columns=False,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=DataCollatorForSeq2Seq(tokenizer, padding=True, label_pad_token_id=-100),
    )

    torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    result = trainer.train(resume_from_checkpoint=True if args.resume else None)
    elapsed = time.perf_counter() - t0
    peak_vram_gb = torch.cuda.max_memory_allocated() / (1024**3)

    adapter_dir = os.path.join(out, "adapter")
    model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    zip_path = os.path.join(out, "adapter.zip")
    zip_adapter(adapter_dir, zip_path)

    losses = [h["loss"] for h in trainer.state.log_history if "loss" in h]
    summary = {
        "run": os.path.basename(out),
        "task": f"component code generation (round {training_round})",
        "base": args.base,
        "data": os.path.relpath(args.data, REPO).replace(os.sep, "/") if os.path.isabs(args.data) else args.data,
        "data_manifest": data_manifest,
        "rows": len(rows),
        "hparams": {
            "r": args.r,
            "lora_alpha": args.alpha,
            "lora_dropout": args.dropout,
            "target_modules": DEFAULT_TARGET_MODULES,
            "bias": "none",
            "learning_rate": args.lr,
            "epochs": args.epochs,
            "per_device_train_batch_size": args.batch,
            "gradient_accumulation_steps": args.grad_accum,
            "effective_batch_size": args.batch * args.grad_accum,
            "max_seq_length": args.max_seq_len,
            "warmup_steps": args.warmup_steps,
            "weight_decay": args.weight_decay,
            "lr_scheduler_type": args.scheduler,
            "optim": args.optim,
            "seed": args.seed,
            "bf16": bf16,
            "load_in_4bit": True,
            "gradient_checkpointing": "unsloth",
            "loss_masked_on_prompt": args.mask_prompt,
            "resume": args.resume,
        },
        "tokens": {
            "min": min(lengths), "max": max(lengths), "mean": round(sum(lengths) / len(lengths), 1),
            "assistant_mean": round(sum(trained_tokens) / len(trained_tokens), 1),
        },
        "steps": trainer.state.global_step,
        "elapsed_seconds": round(elapsed, 1),
        "final_loss": losses[-1] if losses else None,
        "train_loss_mean": getattr(result, "training_loss", None),
        "peak_vram_gb": round(peak_vram_gb, 2),
        "gpu": torch.cuda.get_device_name(0),
        "versions": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "peft": peft.__version__,
            "unsloth": getattr(unsloth, "__version__", "unknown"),
        },
        "git_commit": git_commit(),
        "artifacts": {"adapter_dir": "adapter/", "adapter_zip": "adapter.zip"},
        "note": "defaults mirror training/train_full.py (the plan adapters' script); only max_seq_length differs, forced by row length",
    }
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(summary, fh, indent=2)

    print(json.dumps({k: summary[k] for k in ("rows", "steps", "elapsed_seconds", "final_loss", "peak_vram_gb")}))
    print(f"adapter: {adapter_dir}\nzip:     {zip_path}\nsummary: {os.path.join(out, 'summary.json')}")


if __name__ == "__main__":
    main()
