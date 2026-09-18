"""
Format captured code-generation records into the code adapter's training set.

Input:  capture JSONL written by scripts/capture-code-batch.mjs, one record per
        line (contract below). Several files may be given; globs are expanded.
Output: training/code/formatted/dataset.jsonl   rows of {system, user, assistant}
        training/code/formatted/manifest.json    what went in, what was dropped, why

Row contract (docs/LOCAL-CODE-MODEL-PLAN.md section 6):
    system    = system_with_schema(record.request.system, record.request.schema)
                imported from pdsf/local_inference_server.py - the SAME function
                the server calls at inference, so rows match what the model will
                see byte-for-byte.
    user      = record.request.user, verbatim.
    assistant = json.dumps({"code": record.code}, separators=(",", ":"))
                compact - the shape extractCode parses.

Capture record contract (every field required; a missing one fails the run):
    {recordId, sourceFile, sessionId, kind: "first"|"correction",
     domain: "backend"|"security"|"frontend"|"database",
     component: {id, name, purpose}, targetPath,
     request: {system, user, schema}, code, accepted, reasons: [str],
     teacher, capturedAt}

Usage:
    python training/code/format-code-dataset.py capture/code-*.jsonl
    python training/code/format-code-dataset.py capture/code-*.jsonl --dry-run   # no tokenizer needed
"""
import argparse
import glob
import hashlib
import json
import os
import random
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "pdsf"))

from local_inference_server import render_ids, system_with_schema  # noqa: E402

DEFAULT_OUT_DIR = os.path.join(HERE, "formatted")
DEFAULT_TOKENIZER = "Qwen/Qwen2.5-Coder-7B-Instruct"

KINDS = ("first", "correction")
DOMAINS = ("backend", "security", "frontend", "database")
REQUIRED_TOP = {
    "recordId": str, "sourceFile": str, "sessionId": str, "kind": str, "domain": str,
    "component": dict, "targetPath": str, "request": dict, "code": str, "accepted": bool,
    "reasons": list, "teacher": str, "capturedAt": str,
}
REQUIRED_COMPONENT = {"id": str, "name": str, "purpose": str}
REQUIRED_REQUEST = {"system": str, "user": str, "schema": dict}


class ContractError(Exception):
    pass


def _check_fields(obj, spec, where):
    for key, typ in spec.items():
        if key not in obj:
            raise ContractError(f"{where}: missing field {key!r}")
        if not isinstance(obj[key], typ):
            raise ContractError(f"{where}: field {key!r} must be {typ.__name__}, got {type(obj[key]).__name__}")


def validate_record(record, where):
    if not isinstance(record, dict):
        raise ContractError(f"{where}: record is not a JSON object")
    _check_fields(record, REQUIRED_TOP, where)
    _check_fields(record["component"], REQUIRED_COMPONENT, f"{where}.component")
    _check_fields(record["request"], REQUIRED_REQUEST, f"{where}.request")
    if record["kind"] not in KINDS:
        raise ContractError(f"{where}: kind must be one of {KINDS}, got {record['kind']!r}")
    if record["domain"] not in DOMAINS:
        raise ContractError(f"{where}: domain must be one of {DOMAINS}, got {record['domain']!r}")
    if not all(isinstance(r, str) for r in record["reasons"]):
        raise ContractError(f"{where}: reasons must be a list of strings")
    # Gemini output must never be used for training (docs/GEMINI-TERMS-REVIEW.md).
    # The teacher is recorded on every row precisely so this can be enforced
    # mechanically rather than by remembering.
    if "gemini" in record["teacher"].lower():
        raise ContractError(f"{where}: teacher {record['teacher']!r} is Gemini - its output is not training data")


def read_records(paths):
    records = []
    for pattern in paths:
        matches = sorted(glob.glob(pattern)) or [pattern]
        for path in matches:
            if not os.path.isfile(path):
                raise ContractError(f"input not found: {path}")
            with open(path, encoding="utf-8") as fh:
                for line_no, line in enumerate(fh, 1):
                    line = line.strip()
                    if not line:
                        continue
                    where = f"{path}:{line_no}"
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError as e:
                        raise ContractError(f"{where}: invalid JSON ({e})")
                    validate_record(record, where)
                    record["_where"] = where
                    records.append(record)
    return records


def format_row(record):
    return {
        "system": system_with_schema(record["request"]["system"], record["request"]["schema"]),
        "user": record["request"]["user"],
        "assistant": json.dumps({"code": record["code"]}, separators=(",", ":")),
    }


def row_messages(row):
    return [
        {"role": "system", "content": row["system"]},
        {"role": "user", "content": row["user"]},
        {"role": "assistant", "content": row["assistant"]},
    ]


def count_tokens(tokenizer, row):
    ids = render_ids(tokenizer, row_messages(row), tokenize=True)
    n = len(list(ids))
    # TRAINING-FORMAT.md: a count in the single digits means apply_chat_template
    # returned a dict and we counted its keys. Refuse rather than write garbage.
    if n < 20:
        raise ContractError(f"tokenizer returned {n} ids for a full row - render_ids workaround not effective here")
    return n


def _entry(record, extra=None):
    out = {
        "recordId": record["recordId"],
        "sourceFile": record["sourceFile"],
        "sessionId": record["sessionId"],
        "kind": record["kind"],
        "domain": record["domain"],
        "componentId": record["component"]["id"],
        "targetPath": record["targetPath"],
        "teacher": record["teacher"],
    }
    if extra:
        out.update(extra)
    return out


def _display_path(path):
    """Repo-relative when possible; absolute otherwise (e.g. an --out-dir on another drive)."""
    try:
        return os.path.relpath(path, REPO).replace(os.sep, "/")
    except ValueError:
        return os.path.abspath(path).replace(os.sep, "/")


def _counts(items, key):
    out = {}
    for item in items:
        out[item[key]] = out.get(item[key], 0) + 1
    return dict(sorted(out.items()))


def _token_stats(values):
    if not values:
        return {"count": 0}
    ordered = sorted(values)
    return {
        "count": len(values),
        "min": ordered[0],
        "max": ordered[-1],
        "mean": round(statistics.fmean(values), 1),
        "p50": ordered[len(ordered) // 2],
        "p95": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
        "total": sum(values),
    }


def cap_corrections(kept, share, rng):
    """
    Limits correction rows to at most `share` of the OUTPUT. With F first rows
    kept in full, the most corrections allowed is floor(share*F/(1-share)),
    which is the largest C with C/(F+C) <= share. Chosen deterministically by
    the seeded rng.
    """
    firsts = [k for k in kept if k["record"]["kind"] == "first"]
    corrections = [k for k in kept if k["record"]["kind"] == "correction"]
    if share >= 1.0:
        return kept, []
    max_corr = int(share * len(firsts) / (1.0 - share)) if share > 0 else 0
    if len(corrections) <= max_corr:
        return kept, []
    rng.shuffle(corrections)
    dropped = corrections[max_corr:]
    keep_ids = {id(k) for k in firsts} | {id(k) for k in corrections[:max_corr]}
    return [k for k in kept if id(k) in keep_ids], dropped


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", help="capture JSONL file(s) or globs")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    parser.add_argument("--max-tokens", type=int, default=6144,
                        help="rows whose full chat-template render exceeds this are DROPPED and listed")
    parser.add_argument("--correction-share", type=float, default=0.15,
                        help="max fraction of output rows with kind=correction")
    parser.add_argument("--seed", type=int, default=20260918)
    parser.add_argument("--tokenizer", default=DEFAULT_TOKENIZER)
    parser.add_argument("--dry-run", action="store_true",
                        help="skip tokenization (no length drops); for machines without the tokenizer")
    args = parser.parse_args()

    t0 = time.perf_counter()
    try:
        records = read_records(args.inputs)
    except ContractError as e:
        raise SystemExit(f"CONTRACT ERROR: {e}")
    print(f"read {len(records)} records from {len(args.inputs)} input(s)")

    tokenizer = None
    if not args.dry_run:
        from transformers import AutoTokenizer
        print(f"loading tokenizer {args.tokenizer} ...")
        tokenizer = AutoTokenizer.from_pretrained(args.tokenizer)

    dropped = []
    kept = []
    seen_ids = set()
    for record in records:
        if record["recordId"] in seen_ids:
            dropped.append(_entry(record, {"reason": "duplicate recordId"}))
            continue
        seen_ids.add(record["recordId"])
        if not record["accepted"]:
            dropped.append(_entry(record, {"reason": "not accepted", "reasons": record["reasons"]}))
            continue
        if not record["code"].strip():
            dropped.append(_entry(record, {"reason": "empty code"}))
            continue
        row = format_row(record)
        tokens = None
        if tokenizer is not None:
            try:
                tokens = count_tokens(tokenizer, row)
            except ContractError as e:
                raise SystemExit(f"CONTRACT ERROR: {record['_where']}: {e}")
            if tokens > args.max_tokens:
                dropped.append(_entry(record, {"reason": f"over max tokens ({tokens} > {args.max_tokens})",
                                               "tokens": tokens}))
                continue
        kept.append({"record": record, "row": row, "tokens": tokens})

    rng = random.Random(args.seed)
    kept, over_share = cap_corrections(kept, args.correction_share, rng)
    for k in over_share:
        dropped.append(_entry(k["record"], {"reason": f"correction share cap ({args.correction_share})",
                                            "tokens": k["tokens"]}))

    rng = random.Random(args.seed)
    rng.shuffle(kept)

    if not kept:
        raise SystemExit("CONTRACT ERROR: no rows survived - nothing written")

    os.makedirs(args.out_dir, exist_ok=True)
    dataset_path = os.path.join(args.out_dir, "dataset.jsonl")
    manifest_path = os.path.join(args.out_dir, "manifest.json")
    with open(dataset_path, "w", encoding="utf-8", newline="\n") as fh:
        for k in kept:
            fh.write(json.dumps(k["row"], ensure_ascii=False) + "\n")

    kept_records = [k["record"] for k in kept]
    with open(dataset_path, "rb") as fh:
        sha = hashlib.sha256(fh.read()).hexdigest()

    manifest = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "settings": {
            "inputs": args.inputs,
            "maxTokens": args.max_tokens,
            "correctionShare": args.correction_share,
            "seed": args.seed,
            "tokenizer": None if args.dry_run else args.tokenizer,
            "dryRun": args.dry_run,
            "systemBuiltBy": "pdsf/local_inference_server.py:system_with_schema",
        },
        "output": {
            "path": _display_path(dataset_path),
            "sha256": sha,
            "rows": len(kept),
            "byDomain": _counts(kept_records, "domain"),
            "byKind": _counts(kept_records, "kind"),
            "bySourceFile": _counts(kept_records, "sourceFile"),
            "byTeacher": _counts(kept_records, "teacher"),
            "distinctSessions": len({r["sessionId"] for r in kept_records}),
        },
        "input": {
            "records": len(records),
            "byDomain": _counts(records, "domain"),
            "byKind": _counts(records, "kind"),
            "bySourceFile": _counts(records, "sourceFile"),
            "accepted": sum(1 for r in records if r["accepted"]),
        },
        "tokens": (
            {"skipped": "dry-run"} if args.dry_run
            else _token_stats([k["tokens"] for k in kept])
        ),
        "dropped": {
            "count": len(dropped),
            "byReason": _counts([{"r": d["reason"].split(" (")[0]} for d in dropped], "r"),
            "entries": dropped,
        },
        "rows": [_entry(k["record"], {"index": i, "tokens": k["tokens"]}) for i, k in enumerate(kept)],
    }
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=2)

    print(f"wrote {len(kept)} rows -> {dataset_path}")
    print(f"  by domain: {manifest['output']['byDomain']}")
    print(f"  by kind:   {manifest['output']['byKind']}")
    print(f"  dropped:   {manifest['dropped']['byReason']}")
    print(f"  tokens:    {manifest['tokens']}")
    print(f"manifest -> {manifest_path}  ({time.perf_counter() - t0:.1f}s)")


if __name__ == "__main__":
    main()
