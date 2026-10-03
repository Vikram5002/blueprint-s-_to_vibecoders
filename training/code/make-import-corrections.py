"""
Round-2 training data: synthetic "invented import" corrections.

Round 1's measured weak spot (docs/RESULTS-CODE-M2.md): most of the adapter's
remaining backend failures were TS2305 - importing a name the local module
does not export (`updateTransactionCategory` from ../db/transactions-table),
although the prompt lists the module's real exports. Repair rounds rarely
fixed it. Gemini never made the mistake.

This builds correction records for exactly that failure, deterministically and
without any teacher: take an ACCEPTED first-attempt record whose code imports
from a local module, rename one imported value to a plausible name that the
module does not export, and pair the prompt the pipeline would then send (the
original request + the real CORRECTION block for a TS2305 build failure, built
exactly as src/generate/verify-and-regenerate.ts and component-codegen.ts
build it) with the ORIGINAL accepted code as the answer.

Output is capture-format JSONL (kind "correction", teacher
"synthetic-import-mutation"), so format-code-dataset.py formats it like any
other capture. Gold plans are never read: inputs are training captures only.

Usage:
    python training/code/make-import-corrections.py capture/code/teacher-32b-modal-batch-1.jsonl \
        --out capture/code/synthetic-import-corrections.jsonl --per-record 2
"""
import argparse
import hashlib
import json
import random
import re

IMPORT_RE = re.compile(r'^import\s*\{([^}]*)\}\s*from\s*"(\.\.?/[^"]+)";?\s*$', re.M)
EXPORTS_RE = re.compile(r"^- (\S+) exports: (.+)$", re.M)

VERB_SWAPS = {
    "get": ["fetch", "find", "list", "load"],
    "insert": ["create", "add", "save"],
    "update": ["patch", "set", "modify"],
    "delete": ["remove"],
    "create": ["insert", "add"],
    "list": ["get", "getAll"],
    "find": ["get", "fetch"],
}
SUFFIXES = ["ById", "ByUserId", "s", "ForUser", "Record"]

RULE = "The generated project must compile cleanly with `npm run build` (tsc, strict mode)."
EXPLANATION = (
    "A previous attempt at this exact file failed to compile - 1 real tsc error(s). "
    "Fix the reported problem(s) directly. Do not change this file's exports or introduce a new import "
    "unless the error itself requires it."
)
FIX = (
    "Write the complete corrected file: it must still fulfil the purpose above and must fix every error "
    "listed, following the compile rules in your instructions. Keep the same exported names."
)


def fake_names(real: str, taken: set) -> list:
    """Plausible names a model invents for `real` - never one the module really exports."""
    out = []
    m = re.match(r"([a-z]+)(.*)", real)
    if m:
        verb, rest = m.groups()
        for alt in VERB_SWAPS.get(verb, []):
            out.append(alt + rest)
        for suffix in SUFFIXES:
            if not rest.endswith(suffix):
                out.append(real + suffix)
    return [n for n in dict.fromkeys(out) if n not in taken and n != real]


def correction_user(first_user: str, file: str, line_no: int, line_text: str, module: str, fake: str) -> str:
    snippet = f"{line_text.strip()}    <- TS2305: Module '\"{module}\"' has no exported member '{fake}'."
    return "\n".join([
        first_user,
        "",
        "CORRECTION REQUIRED - your previous attempt at this exact file was already written to disk and "
        "checked against the project's real architecture. It violated a stated rule:",
        f"  Rule violated: {RULE}",
        f"  What happened: {EXPLANATION}",
        "The exact offending line(s) from your previous attempt:",
        f"  {file}:{line_no}: {snippet}",
        FIX,
    ])


def mutations(record: dict, rng: random.Random, per_record: int) -> list:
    code, user = record["code"], record["request"]["user"]
    exports = {path: {n.strip() for n in names.split(",")} for path, names in EXPORTS_RE.findall(user)}
    candidates = []
    for match in IMPORT_RE.finditer(code):
        module = match.group(2)
        names = [n.strip() for n in match.group(1).split(",") if n.strip() and not n.strip().startswith("type ")]
        real = exports.get(module)
        if real is None:
            continue
        for name in names:
            # Values only (functions): a renamed type or the shared `db` handle is not the observed failure.
            if name in real and name[:1].islower() and name != "db":
                for fake in fake_names(name, real):
                    candidates.append((match, module, name, fake))
    rng.shuffle(candidates)
    out, used = [], set()
    for match, module, name, fake in candidates:
        if name in used or len(out) >= per_record:
            continue
        used.add(name)
        mutated = re.sub(rf"\b{re.escape(name)}\b", fake, code)
        line_no = code[: match.start()].count("\n") + 1
        line_text = mutated.splitlines()[line_no - 1]
        digest = hashlib.sha256(f"{record['recordId']}:{name}:{fake}".encode()).hexdigest()[:16]
        out.append({
            **record,
            "recordId": f"{record['sessionId']}:synthetic-import:{digest}",
            "kind": "correction",
            "request": {**record["request"], "user": correction_user(user, record["targetPath"], line_no, line_text, module, fake)},
            "code": code,  # the answer is the original, accepted, compiling file
            "accepted": True,
            "reasons": [f"synthetic: {name} renamed to {fake} (TS2305); answer is the accepted original"],
            "teacher": "synthetic-import-mutation",
        })
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--out", required=True)
    parser.add_argument("--per-record", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20261003)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    written = 0
    with open(args.out, "w", encoding="utf-8", newline="\n") as out:
        for path in args.inputs:
            for line in open(path, encoding="utf-8"):
                record = json.loads(line)
                if record["kind"] != "first" or not record["accepted"]:
                    continue
                for synthetic in mutations(record, rng, args.per_record):
                    out.write(json.dumps(synthetic, ensure_ascii=False) + "\n")
                    written += 1
    print(f"wrote {written} synthetic correction records to {args.out}")


if __name__ == "__main__":
    main()
