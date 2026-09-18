import json, time, torch
from datetime import datetime
from pathlib import Path
from unsloth import FastLanguageModel
from trl import SFTTrainer, SFTConfig
from datasets import Dataset

ROOT = Path(r"D:\70572300022")
DATASET_PATH = ROOT / "training" / "formatted" / "dataset.jsonl"
OUTPUT_DIR = ROOT / "training" / "runs" / datetime.now().strftime("run_%Y%m%d_%H%M%S")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print(f"Loading dataset from {DATASET_PATH}")
rows = [json.loads(l) for l in open(DATASET_PATH, encoding="utf-8")]
print(f"Loaded {len(rows)} rows")

print("Loading Qwen2.5-7B-Instruct in 4-bit...")
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="Qwen/Qwen2.5-7B-Instruct",
    max_seq_length=2048,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"],
    lora_alpha=16,
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing=True,
    random_state=42,
)

def render_ids(result):
    # Version-tolerant handling - some transformers versions return a
    # BatchEncoding-like dict instead of a plain list/tensor.
    if hasattr(result, "input_ids"):
        return result.input_ids
    if isinstance(result, dict):
        return result["input_ids"]
    return result

def to_text(row):
    messages = [
        {"role": "system", "content": row["system"]},
        {"role": "user", "content": row["user"]},
        {"role": "assistant", "content": row["assistant"]},
    ]
    return tokenizer.apply_chat_template(messages, tokenize=False)

texts = [to_text(r) for r in rows]
dataset = Dataset.from_dict({"text": texts})

print(f"Starting training: {len(rows)} examples, 3 epochs")
t0 = time.time()

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="text",
    max_seq_length=2048,
    args=SFTConfig(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=1,
        num_train_epochs=3,
        learning_rate=2e-4,
        logging_steps=5,
        output_dir=str(OUTPUT_DIR),
        save_strategy="no",
        report_to="none",
        seed=42,
    ),
)

result = trainer.train()
elapsed = time.time() - t0

print(f"\nTraining complete in {elapsed:.1f}s")
print(f"Final loss: {result.training_loss:.4f}")
print(f"Peak VRAM: {torch.cuda.max_memory_allocated() / 1e9:.2f} GB")

print(f"\nSaving adapter to {OUTPUT_DIR}")
model.save_pretrained(str(OUTPUT_DIR))
tokenizer.save_pretrained(str(OUTPUT_DIR))

summary = {
    "timestamp": datetime.now().isoformat(),
    "rows": len(rows),
    "epochs": 3,
    "elapsed_seconds": elapsed,
    "final_loss": result.training_loss,
    "peak_vram_gb": torch.cuda.max_memory_allocated() / 1e9,
    "output_dir": str(OUTPUT_DIR),
}
with open(OUTPUT_DIR / "summary.json", "w") as f:
    json.dump(summary, f, indent=2)

print(f"\nDone. Adapter and summary saved to: {OUTPUT_DIR}")
