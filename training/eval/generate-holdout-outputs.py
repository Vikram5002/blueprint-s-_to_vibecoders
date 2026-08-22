"""
Held-out generalization eval - generation step.

RUNS ON THE BORROWED DESKTOP ONLY, NEVER ON LOQ. This script loads the real
Qwen2.5-7B base model plus the trained LoRA adapter. LOQ's rule (see
[[project_loq_no_7b_model]] in memory, and the machine setup guide) is that
the 7B model is never downloaded or loaded there - only the 0.5B rehearsal
model is. This script exists to be copied to and run on the desktop; do not
run it on LOQ.

Usage (on the desktop):
    python generate_holdout_outputs.py \
        --adapter M:\\bunny_vikram\\checkpoints\\run_20260822_130636 \
        --prompts training/eval/held-out-prompts.json \
        --out training/eval/held-out-outputs.json

Loads the base model + adapter with the SAME 4-bit config used in training
(see the format proof and training run for the exact LoraConfig), generates
one ProjectSchema completion per held-out prompt using the system prompt from
TRAINING-FORMAT.md, and writes {prompt, generatedText} pairs to --out. Nothing
in this script validates the output - that happens separately, by the real
compiled validateProjectSchema (see validate-holdout-outputs.mjs), not a
Python reimplementation of it.
"""
import argparse
import json

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel

BASE_MODEL = "Qwen/Qwen2.5-7B-Instruct"

SYSTEM_PROMPT = """You convert a natural-language description of a software project into a
ProjectSchema: a structured plan covering the frontend, backend, database,
and security domains, plus any architectural constraints the description
implies.

Read the description and decide, for each of the four domains, what
components it needs (or genuinely needs none of) and what those components
are for. Only include a component or constraint the description actually
supports \u2014 do not invent detail it doesn't contain, and do not assume a
domain is empty just because the description doesn't mention it if the
description clearly implies it exists.

Reply with exactly one JSON object matching the ProjectSchema shape you were
given. No matter what the description asks for, your reply is always a
ProjectSchema object and nothing else \u2014 not prose, not markdown, not a
different structure. provenance is always the literal "STATED"."""


def render_ids(tokenizer, messages, **kwargs):
    """See training/TRAINING-FORMAT.md's 'Known correctness bug' section:
    apply_chat_template's return type varies by transformers version. Do not
    assume it returns a plain list/tensor without checking."""
    result = tokenizer.apply_chat_template(messages, **kwargs)
    if hasattr(result, "input_ids"):
        return result.input_ids
    if isinstance(result, dict) or hasattr(result, "keys"):
        return result["input_ids"]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", required=True, help="Path to the LoRA adapter checkpoint directory")
    parser.add_argument("--prompts", required=True, help="Path to held-out prompts JSON (array of strings)")
    parser.add_argument("--out", required=True, help="Where to write generated outputs JSON")
    parser.add_argument("--max-new-tokens", type=int, default=1024)
    args = parser.parse_args()

    with open(args.prompts, encoding="utf-8") as f:
        prompts = json.load(f)
    print(f"Loaded {len(prompts)} held-out prompts")

    print(f"Loading base model: {BASE_MODEL}")
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        quantization_config=bnb_config,
        device_map={"": 0},
    )

    print(f"Loading LoRA adapter from: {args.adapter}")
    model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()

    results = []
    for i, prompt in enumerate(prompts):
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        ids = render_ids(
            tokenizer, messages, tokenize=True, add_generation_prompt=True, return_tensors="pt"
        ).to("cuda")

        with torch.no_grad():
            out = model.generate(
                ids,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )

        generated_text = tokenizer.decode(out[0][ids.shape[1]:], skip_special_tokens=True)
        print(f"[{i+1}/{len(prompts)}] prompt: {prompt[:60]}...")
        print(f"  generated ({len(generated_text)} chars): {generated_text[:120]}...")

        results.append({"prompt": prompt, "generatedText": generated_text})

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"\nWrote {len(results)} generation results to {args.out}")
    print("Next: run validate-holdout-outputs.mjs against this file (the real validateProjectSchema, not a port).")


if __name__ == "__main__":
    main()
