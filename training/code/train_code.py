"""
QLoRA fine-tune of the CODE adapter on Qwen2.5-Coder-7B-Instruct (Unsloth).

One command on the borrowed desktop (see RUNBOOK.md):
    python training/code/train_code.py

Hyperparameters default to the values the plan adapter was trained with
(training/eval/RESULTS-run_20260912_154324.md: r=16, lora_alpha=16, lr=2e-4,
3 epochs, batch_size=2, no dropout). docs/LOCAL-CODE-MODEL-PLAN.md section 6:
"Training settings stay the same as the plan runs."

TODO(train_full.py): the plan adapter's script `train_full.py` is not in the
repo (LOCAL-CODE-MODEL-PLAN.md section 3, item 5). This file was written from
the DOCUMENTED values above, not by copying train_full.py. When train_full.py
is recovered from the pendrive: diff it against this file, in particular
  - target_modules, gradient accumulation, warmup, scheduler, weight decay,
    seed, max_seq_length, whether loss was masked on the prompt,
and record any difference in summary.json's "hparams" of the next run and in
training/eval/RESULTS-CODE-M1.md. Until then, the comparability of this
adapter's settings with the plan adapter's is by documentation only.

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
DEFAULT_TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default=DEFAULT_BASE)
    p.add_argument("--data", default=DEFAULT_DATA)
    p.add_argument("--out", default=None, help="default training/runs/code_<timestamp>")
    p.add_argument("--epochs", type=float, default=3)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--r", type=int, default=16)
    p.add_argument("--alpha", type=int, default=16)
    p.add_argument("--dropout", type=float, default=0.0)
    p.add_argument("--batch", type=int, default=2)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--max-seq-len", type=int, default=6144)
    p.add_argument("--warmup-steps", type=int, default=5)
    p.add_argument("--weight-decay", type=float, default=0.01)
    p.add_argument("--scheduler", default="linear")
    p.add_argument("--seed", type=int, default=3407)
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


def encode_row(tokenizer, row, max_seq_len):
    """
    input_ids for the whole conversation; labels = -100 over the prompt
    (system + user + the assistant header the generation prompt adds), real
    ids over the assistant turn. The prompt render must be a strict prefix of
    the full render, which is checked rather than assumed.
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
    labels = [-100] * len(prompt_ids) + full_ids[len(prompt_ids):]
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
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out = args.out or os.path.join(REPO, "training", "runs", f"code_{stamp}")
    if args.resume and not args.out:
        raise SystemExit("--resume needs --out pointing at the run to continue")
    os.makedirs(out, exist_ok=True)

    import torch
    from unsloth import FastLanguageModel
    from datasets import Dataset
    from transformers import DataCollatorForSeq2Seq, Trainer, TrainingArguments
    import transformers, peft, unsloth  # noqa: E401 - versions for summary.json

    rows = read_rows(args.data)
    print(f"rows: {len(rows)} from {args.data}")

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

    encoded = [encode_row(tokenizer, row, args.max_seq_len) for row in rows]
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
        optim="adamw_8bit",
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
        "task": "component code generation (backend + security, round 1)",
        "base": args.base,
        "data": os.path.relpath(args.data, REPO).replace(os.sep, "/") if os.path.isabs(args.data) else args.data,
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
            "optim": "adamw_8bit",
            "seed": args.seed,
            "bf16": bf16,
            "load_in_4bit": True,
            "gradient_checkpointing": "unsloth",
            "loss_masked_on_prompt": True,
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
        "note": "hparams taken from RESULTS-run_20260912_154324.md; TODO diff against train_full.py when recovered",
    }
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(summary, fh, indent=2)

    print(json.dumps({k: summary[k] for k in ("rows", "steps", "elapsed_seconds", "final_loss", "peak_vram_gb")}))
    print(f"adapter: {adapter_dir}\nzip:     {zip_path}\nsummary: {os.path.join(out, 'summary.json')}")


if __name__ == "__main__":
    main()
