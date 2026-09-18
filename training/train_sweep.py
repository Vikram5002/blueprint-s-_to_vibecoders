"""
Hyperparameter sweep training run. Varies one dimension (r, learning_rate, or
epochs) from the baseline config (r=16, alpha=16, lr=2e-4, 3 epochs, which
produced run_20260822_130636's final loss of 0.90) while holding everything
else fixed, on the same 91-row training/formatted/dataset.jsonl.

Caveat, stated plainly: the original run_20260822_130636 was produced by a
training script not present on this machine (only its checkpoint + summary.json
were staged via pendrive). This script reconstructs the same LoRA config
(r/alpha/target_modules from run_20260822_130636/adapter_config.json) and the
same base model + dataset format used in every proof run on this desktop
(Qwen/Qwen2.5-7B-Instruct with on-the-fly 4-bit quant via Unsloth). The
sweep configs (A/B/C below) ARE directly comparable to each other, since they
all share this exact script. Comparison to the 0.90 baseline number carries
one asterisk: it's not confirmed the original script quantized/loaded the base
model the identical way (its adapter_config.json records
'unsloth/qwen2.5-7b-instruct-unsloth-bnb-4bit' as base_model_name_or_path, a
pre-quantized repo not used here, to avoid an extra multi-GB download on a
time-boxed session).

Usage:
    python train_sweep.py --r 32 --alpha 16 --lr 2e-4 --epochs 3 --label configA-r32
"""
import argparse
import json
import os
import time
from datetime import datetime

os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "hf_cache"))

import torch
from unsloth import FastLanguageModel
from datasets import Dataset
from trl import SFTTrainer, SFTConfig

MODEL_NAME = "Qwen/Qwen2.5-7B-Instruct"
MAX_SEQ_LEN = 2048
DATA_FILE = "training/formatted/dataset.jsonl"
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def render_ids(tokenizer, messages, **kwargs):
    result = tokenizer.apply_chat_template(messages, **kwargs)
    if hasattr(result, "input_ids"):
        return result.input_ids
    if isinstance(result, dict) or hasattr(result, "keys"):
        return result["input_ids"]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--r", type=int, required=True)
    parser.add_argument("--alpha", type=int, required=True)
    parser.add_argument("--lr", type=float, required=True)
    parser.add_argument("--epochs", type=float, required=True)
    parser.add_argument("--label", required=True, help="short config label, e.g. configA-r32")
    args = parser.parse_args()

    rows = []
    with open(DATA_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    print(f"Loaded {len(rows)} formatted rows.")

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL_NAME,
        max_seq_length=MAX_SEQ_LEN,
        load_in_4bit=True,
        dtype=None,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=args.r,
        target_modules=TARGET_MODULES,
        lora_alpha=args.alpha,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )

    formatted_texts = []
    for row in rows:
        messages = [
            {"role": "system", "content": row["system"]},
            {"role": "user", "content": row["user"]},
            {"role": "assistant", "content": row["assistant"]},
        ]
        formatted_texts.append(tokenizer.apply_chat_template(messages, tokenize=False))

    dataset = Dataset.from_dict({"text": formatted_texts})

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = os.path.join("training", "runs", f"run_{timestamp}")
    os.makedirs(run_dir, exist_ok=True)

    sft_config = SFTConfig(
        output_dir=f"./_sweep_tmp_{timestamp}",
        per_device_train_batch_size=2,
        gradient_accumulation_steps=1,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        logging_steps=5,
        optim="adamw_8bit",
        dataset_text_field="text",
        max_length=MAX_SEQ_LEN,
        report_to=[],
        save_strategy="no",
    )

    trainer = SFTTrainer(
        model=model,
        train_dataset=dataset,
        args=sft_config,
        processing_class=tokenizer,
    )

    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    t_start = time.perf_counter()

    result = trainer.train()

    torch.cuda.synchronize()
    t_end = time.perf_counter()
    elapsed = t_end - t_start
    peak_vram_gb = torch.cuda.max_memory_allocated() / (1024**3)

    model.save_pretrained(run_dir)
    tokenizer.save_pretrained(run_dir)

    summary = {
        "timestamp": datetime.now().isoformat(),
        "label": args.label,
        "rows": len(rows),
        "r": args.r,
        "lora_alpha": args.alpha,
        "learning_rate": args.lr,
        "epochs": args.epochs,
        "elapsed_seconds": elapsed,
        "final_loss": result.training_loss,
        "peak_vram_gb": peak_vram_gb,
        "output_dir": os.path.abspath(run_dir),
    }
    with open(os.path.join(run_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print("\n----- SWEEP RUN RESULT (%s) -----" % args.label)
    print(json.dumps(summary, indent=2))
    print(f"\nSaved to: {run_dir}")


if __name__ == "__main__":
    main()
