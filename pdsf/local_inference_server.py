"""
Local inference server for the fine-tuned QLoRA checkpoints, speaking the exact
CompletionResult JSON shape from src/llm/provider.ts so src/llm/local.ts can be a
plain fetch() adapter, same style as bluesminds.ts.

Loads every base model ONCE at startup (unlike generate-holdout-outputs.py, which
is a one-shot script) and serves POST /complete for repeated low-latency calls -
this is what makes "per-request latency" a meaningful number instead of one
dominated by model load time.

Serves one or more named models from a single process. Each `--model` entry is
NAME=BASE[:ADAPTER_DIR]; entries that share a BASE share the loaded 4-bit weights
and switch LoRA adapters per request (PEFT multi-adapter), so the planner
(Instruct + plan adapter), the coder (Coder + code adapter) and a plain
adapter-less teacher can all live in one process. See
docs/LOCAL-CODE-MODEL-PLAN.md section 8.

Not part of the TypeScript repo - this is local desktop / Colab infrastructure
that the real src/llm/local.ts adapter talks to over HTTP.

Usage:
    # one model (backward-compatible alias, same as before):
    python local_inference_server.py --adapter "D:\\runs\\run_20260912_154324" --port 8712

    # several models, first one is the default:
    python local_inference_server.py \
        --model plan=Qwen/Qwen2.5-7B-Instruct:/content/adapter_root/run_x \
        --model code=Qwen/Qwen2.5-Coder-7B-Instruct:/content/code_adapter \
        --model teacher=Qwen/Qwen2.5-Coder-14B-Instruct

Endpoints:
    POST /complete   {system, user, maxOutputTokens, temperature?, schema?, model?}
    GET  /models     {"models":[{"name","base","adapter"}], "default": NAME}
"""
import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "hf_cache"))

# The GPU runtime (torch / transformers / peft) is imported lazily by
# _import_runtime(), called from main(). Everything above the model-loading
# layer - system_with_schema(), parse_model_specs(), the JSON state machine -
# is importable without torch installed, which is what lets
# training/code/format-code-dataset.py reuse system_with_schema() so training
# rows match inference byte-for-byte, and what lets test_server_units.py run
# on a machine with no GPU stack.
torch = None
AutoModelForCausalLM = None
AutoTokenizer = None
BitsAndBytesConfig = None
PeftModel = None


def _import_runtime():
    global torch, AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, PeftModel
    import torch as _torch
    from transformers import AutoModelForCausalLM as _M, AutoTokenizer as _T, BitsAndBytesConfig as _B
    from peft import PeftModel as _P

    torch = _torch
    AutoModelForCausalLM = _M
    AutoTokenizer = _T
    BitsAndBytesConfig = _B
    PeftModel = _P


BASE_MODEL = "Qwen/Qwen2.5-7B-Instruct"
DEFAULT_MODEL_NAME = "local:qwen2.5-7b-instruct+run_20260912_154324"
SCHEMA_SUFFIX = "\n\nReply with JSON matching exactly this schema:\n"


def system_with_schema(system, schema):
    """
    The effective system prompt the model sees when a request carries a JSON
    schema. This is the ONE place that text is built: the /complete handler
    calls it at inference time and training/code/format-code-dataset.py calls
    it when writing training rows, so the two cannot drift apart
    (docs/LOCAL-CODE-MODEL-PLAN.md section 6).

    `schema is None` returns `system` unchanged. Any other value - including an
    empty object - is appended with json.dumps' default separators, exactly as
    the original handler did.
    """
    if schema is None:
        return system
    return system + SCHEMA_SUFFIX + json.dumps(schema)


def render_ids(tokenizer, messages, **kwargs):
    """See training/TRAINING-FORMAT.md's 'Known correctness bug' section."""
    result = tokenizer.apply_chat_template(messages, **kwargs)
    if hasattr(result, "input_ids"):
        return result.input_ids
    if isinstance(result, dict) or hasattr(result, "keys"):
        return result["input_ids"]
    return result


# ---------------------------------------------------------------------------
# Model specs: what `--model NAME=BASE[:ADAPTER_DIR]` parses into. Pure Python,
# no torch, so it is unit-testable and the CLI can reject bad input before
# spending minutes loading weights.
# ---------------------------------------------------------------------------


class ModelSpec:
    __slots__ = ("name", "base", "adapter")

    def __init__(self, name, base, adapter=None):
        self.name = name
        self.base = base
        self.adapter = adapter

    def as_dict(self):
        return {"name": self.name, "base": self.base, "adapter": self.adapter}

    def __eq__(self, other):
        return isinstance(other, ModelSpec) and self.as_dict() == other.as_dict()

    def __repr__(self):
        return f"ModelSpec({self.as_dict()!r})"


def parse_model_arg(text):
    """
    NAME=BASE[:ADAPTER_DIR] -> ModelSpec.

    The split is on the FIRST ':' after the '='. HF model ids never contain a
    colon, so everything after that first colon is the adapter path - which is
    what keeps Windows paths like `plan=Qwen/Qwen2.5-7B-Instruct:D:\\runs\\x`
    working (the drive-letter colon stays inside the adapter path).
    """
    if not isinstance(text, str) or "=" not in text:
        raise ValueError(f"--model must look like NAME=BASE[:ADAPTER_DIR], got {text!r}")
    name, _, rest = text.partition("=")
    name = name.strip()
    if not name:
        raise ValueError(f"--model has an empty NAME: {text!r}")
    base, _, adapter = rest.partition(":")
    base = base.strip()
    adapter = adapter.strip()
    if not base:
        raise ValueError(f"--model {name!r} has an empty BASE: {text!r}")
    return ModelSpec(name, base, adapter or None)


def parse_model_specs(model_args, adapter=None, model_name=None, base_model=BASE_MODEL):
    """
    Resolves the CLI into an ordered list of ModelSpec. The first entry is the
    default model for requests that carry no "model" field.

    - `--model` given one or more times: each parsed by parse_model_arg.
    - `--adapter DIR` (legacy alias): exactly one model, named `--model-name`
      (or DEFAULT_MODEL_NAME), on BASE_MODEL. Kept so every existing launch
      command and the Colab notebook's 'plan' mode keep working unchanged.
    - Both, or neither: an error. Mixing them would make "which one is the
      default" ambiguous.
    """
    model_args = list(model_args or [])
    if model_args and adapter:
        raise ValueError("use either --model (repeatable) or the legacy --adapter, not both")
    if not model_args and not adapter:
        raise ValueError("no model given: pass --model NAME=BASE[:ADAPTER_DIR] or --adapter DIR")

    if adapter:
        specs = [ModelSpec(model_name or DEFAULT_MODEL_NAME, base_model, adapter)]
    else:
        specs = [parse_model_arg(text) for text in model_args]

    seen = set()
    for spec in specs:
        if spec.name in seen:
            raise ValueError(f"duplicate --model name: {spec.name!r}")
        seen.add(spec.name)
    return specs


def clamp_max_new_tokens(requested, cap, default=512):
    """Requested budget, bounded above by --max-new-tokens-cap and below by 1."""
    try:
        value = int(requested) if requested is not None else int(default)
    except (TypeError, ValueError):
        value = int(default)
    if value < 1:
        value = 1
    if cap is not None and value > int(cap):
        value = int(cap)
    return value


_JSON_SPECIAL = set('{}[],:"\\')
_JSON_SPACE = set(" \t\n\r")


def _signature(text):
    """
    Collapses a token's text to the shortest string with identical structural
    behaviour: runs of ordinary characters become a single 'x', runs of
    whitespace a single ' '. Two tokens sharing a signature drive the state
    machine identically, so the machine runs once per signature per state
    rather than once per token.
    """
    out = []
    prev = None
    for ch in text:
        if ch in _JSON_SPECIAL:
            out.append(ch)
            prev = None
        elif ch in _JSON_SPACE:
            if prev != " ":
                out.append(" ")
            prev = " "
        else:
            if prev != "x":
                out.append("x")
            prev = "x"
    return "".join(out)


class _JsonStructure:
    """
    Incremental JSON punctuation validator. Cheap to copy, since the processor
    speculatively replays every candidate signature against it each step.
    """

    VALUE_OR_CLOSE = 0  # array just opened: a value, or ]
    VALUE_REQUIRED = 1  # after , in an array, after :, or the document start
    KEY_OR_CLOSE = 2    # object just opened: a key, or }
    KEY_REQUIRED = 3    # after , in an object
    AFTER_KEY = 4       # a key string just closed: : must follow
    AFTER_VALUE = 5     # a value just finished: , or a close must follow

    __slots__ = ("stack", "expect", "in_string", "escape", "string_is_key", "in_literal", "failed")

    def __init__(self):
        self.stack = []
        self.expect = self.VALUE_REQUIRED
        self.in_string = False
        self.escape = False
        self.string_is_key = False
        self.in_literal = False
        self.failed = False

    def copy(self):
        c = _JsonStructure.__new__(_JsonStructure)
        c.stack = list(self.stack)
        c.expect = self.expect
        c.in_string = self.in_string
        c.escape = self.escape
        c.string_is_key = self.string_is_key
        c.in_literal = self.in_literal
        c.failed = self.failed
        return c

    def key(self):
        """Everything a replay's outcome depends on, for memoisation."""
        return (
            tuple(self.stack),
            self.expect,
            self.in_string,
            self.escape,
            self.string_is_key,
            self.in_literal,
        )

    def feed(self, text):
        for ch in text:
            if not self._feed_char(ch):
                self.failed = True
                return False
        return True

    def _feed_char(self, ch):
        if self.in_string:
            if self.escape:
                self.escape = False
                return True
            if ch == "\\":
                self.escape = True
                return True
            if ch == '"':
                self.in_string = False
                self.expect = self.AFTER_KEY if self.string_is_key else self.AFTER_VALUE
                return True
            return True  # ordinary string content

        if ch in _JSON_SPACE:
            self.in_literal = False
            return True

        if ch == '"':
            if self.expect in (self.VALUE_OR_CLOSE, self.VALUE_REQUIRED):
                self.in_string = True
                self.string_is_key = False
                self.in_literal = False
                return True
            if self.expect in (self.KEY_OR_CLOSE, self.KEY_REQUIRED):
                self.in_string = True
                self.string_is_key = True
                self.in_literal = False
                return True
            return False

        if ch == "{":
            if self.expect not in (self.VALUE_OR_CLOSE, self.VALUE_REQUIRED):
                return False
            self.stack.append("{")
            self.expect = self.KEY_OR_CLOSE
            self.in_literal = False
            return True

        if ch == "[":
            if self.expect not in (self.VALUE_OR_CLOSE, self.VALUE_REQUIRED):
                return False
            self.stack.append("[")
            self.expect = self.VALUE_OR_CLOSE
            self.in_literal = False
            return True

        if ch == "}":
            if not self.stack or self.stack[-1] != "{":
                return False
            if self.expect not in (self.KEY_OR_CLOSE, self.AFTER_VALUE):
                return False
            self.stack.pop()
            self.expect = self.AFTER_VALUE
            self.in_literal = False
            return True

        if ch == "]":
            if not self.stack or self.stack[-1] != "[":
                return False
            # VALUE_REQUIRED is excluded on purpose: that is the state after a
            # comma, and this is exactly what forbids a trailing comma.
            if self.expect not in (self.VALUE_OR_CLOSE, self.AFTER_VALUE):
                return False
            self.stack.pop()
            self.expect = self.AFTER_VALUE
            self.in_literal = False
            return True

        if ch == ",":
            # Requiring AFTER_VALUE here is what forbids a doubled comma.
            if self.expect != self.AFTER_VALUE or not self.stack:
                return False
            self.expect = self.KEY_REQUIRED if self.stack[-1] == "{" else self.VALUE_REQUIRED
            self.in_literal = False
            return True

        if ch == ":":
            if self.expect != self.AFTER_KEY:
                return False
            self.expect = self.VALUE_REQUIRED
            self.in_literal = False
            return True

        # Any other character: an opaque literal (number, true/false/null).
        if self.expect in (self.VALUE_OR_CLOSE, self.VALUE_REQUIRED):
            self.expect = self.AFTER_VALUE
            self.in_literal = True
            return True
        if self.expect == self.AFTER_VALUE and self.in_literal:
            return True
        return False


class JsonSignatureIndex:
    """
    The vocabulary grouped by structural signature, built once per server
    process. Immutable after construction and therefore safe to share across
    threads - unlike the processor itself, which holds per-generation state.
    """

    def __init__(self, tokenizer, device):
        import torch as _torch

        vocab_size = len(tokenizer)
        texts = tokenizer.batch_decode([[i] for i in range(vocab_size)])

        # Special and added tokens are exempted, with an empty text and an
        # empty signature, so they are structurally inert: never masked, and a
        # no-op when they are folded into the state.
        #
        # This is not a nicety. EOS decodes to the literal text "<|im_end|>",
        # whose characters the state machine rejects once the document has
        # closed - so without this the model physically cannot stop. Observed
        # directly: a complete, valid document followed by whitespace until the
        # token budget ran out, because whitespace was the only legal
        # continuation left. The final text is decoded with
        # skip_special_tokens=True, so these tokens never form part of the JSON
        # payload and giving them no structural effect is also the honest model.
        exempt = set(getattr(tokenizer, "all_special_ids", None) or [])
        added = getattr(tokenizer, "added_tokens_decoder", None)
        if added:
            exempt |= set(added.keys())
        self.exempt_ids = exempt

        texts = ["" if i in exempt else t for i, t in enumerate(texts)]
        self.token_text = texts

        groups = {}
        for token_id, text in enumerate(texts):
            groups.setdefault(_signature(text), []).append(token_id)

        self.signatures = list(groups.keys())
        self.buckets = [_torch.tensor(groups[s], dtype=_torch.long, device=device) for s in self.signatures]
        self.vocab_size = vocab_size

    def __len__(self):
        return len(self.signatures)


class JsonPunctuationLogitsProcessor:
    """
    Masks tokens whose text would make the generated document invalid JSON.

    CONSTRUCT ONE PER REQUEST. It holds the running parse state for a single
    generation. The server is a ThreadingHTTPServer, so a shared instance would
    interleave two generations' states and corrupt both - and would present as
    nondeterminism rather than as an obvious crash. The index it reads is
    immutable and is the only thing shared.
    """

    def __init__(self, index, prompt_len, neg_inf=float("-inf")):
        self.index = index
        self.prompt_len = prompt_len
        self.state = _JsonStructure()
        self.consumed = 0
        self.failed_open = False
        self.fail_open_events = 0
        self.masked_steps = 0
        self._cache = {}
        self._neg_inf = neg_inf

    def _disallowed_for(self, state):
        cached = self._cache.get(state.key())
        if cached is not None:
            return cached
        disallowed = []
        for i, signature in enumerate(self.index.signatures):
            probe = state.copy()
            if not probe.feed(signature):
                disallowed.append(i)
        result = (disallowed, len(disallowed) < len(self.index.signatures))
        self._cache[state.key()] = result
        return result

    def __call__(self, input_ids, scores):
        if self.failed_open:
            return scores

        generated = input_ids[0][self.prompt_len:]
        total = int(generated.shape[0])
        while self.consumed < total:
            token_id = int(generated[self.consumed].item())
            self.consumed += 1
            if not self.state.feed(self.index.token_text[token_id]):
                # Already invalid despite the mask - a state machine bug, a
                # fail-open earlier in this generation, or a token the mask
                # could not have caught. Stop constraining rather than fight it.
                self.failed_open = True
                self.fail_open_events += 1
                return scores

        disallowed, any_allowed = self._disallowed_for(self.state)
        if not any_allowed:
            # Masking everything would write -inf across the row and produce
            # NaNs. Fail open instead, and record that it happened.
            self.failed_open = True
            self.fail_open_events += 1
            return scores

        for i in disallowed:
            scores.index_fill_(1, self.index.buckets[i], self._neg_inf)
        self.masked_steps += 1
        return scores



# ---------------------------------------------------------------------------
# Model registry: one loaded base per distinct BASE id, adapters attached to it
# by name. Two --model entries on the same base share the base weights; the
# per-request switch is PEFT's set_adapter (or disable_adapter for an
# adapter-less entry that shares a base with an adapter-bearing one).
# ---------------------------------------------------------------------------


class _LoadedBase:
    __slots__ = ("base_id", "model", "tokenizer", "signature_index", "is_peft", "adapter_names")

    def __init__(self, base_id, model, tokenizer):
        self.base_id = base_id
        self.model = model
        self.tokenizer = tokenizer
        self.signature_index = None
        self.is_peft = False
        self.adapter_names = []


class ModelRegistry:
    def __init__(self, specs):
        self.specs = list(specs)
        self.default_name = self.specs[0].name
        self.bases = {}      # base id -> _LoadedBase
        self.entries = {}    # NAME -> (ModelSpec, _LoadedBase)

    @staticmethod
    def _bnb_config():
        return BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        )

    @staticmethod
    def _allocated_gb():
        return torch.cuda.memory_allocated() / (1024**3)

    def load_all(self):
        for spec in self.specs:
            base = self.bases.get(spec.base)
            if base is None:
                base = self._load_base(spec.base)
                self.bases[spec.base] = base
            if spec.adapter:
                self._attach_adapter(base, spec)
            else:
                print(f"[{spec.name}] plain base {spec.base}, no adapter")
            self.entries[spec.name] = (spec, base)

        for base in self.bases.values():
            base.model.eval()
            print(f"Building JSON constraint signature index for {base.base_id}...")
            t_index = time.perf_counter()
            base.signature_index = JsonSignatureIndex(base.tokenizer, device=base.model.device)
            print(f"  {len(base.signature_index)} signatures over {base.signature_index.vocab_size} tokens "
                  f"in {time.perf_counter() - t_index:.2f}s")

        torch.cuda.reset_peak_memory_stats()
        print(f"All models loaded. VRAM allocated now: {self._allocated_gb():.2f} GB")

    def _load_base(self, base_id):
        print(f"Loading base model: {base_id}")
        before = self._allocated_gb()
        t0 = time.perf_counter()
        tokenizer = AutoTokenizer.from_pretrained(base_id)
        model = AutoModelForCausalLM.from_pretrained(
            base_id,
            quantization_config=self._bnb_config(),
            device_map={"": 0},
        )
        print(f"  base {base_id}: +{self._allocated_gb() - before:.2f} GB VRAM "
              f"in {time.perf_counter() - t0:.1f}s")
        return _LoadedBase(base_id, model, tokenizer)

    def _attach_adapter(self, base, spec):
        print(f"[{spec.name}] loading LoRA adapter from: {spec.adapter}")
        before = self._allocated_gb()
        if not base.is_peft:
            base.model = PeftModel.from_pretrained(base.model, spec.adapter, adapter_name=spec.name)
            base.is_peft = True
        else:
            base.model.load_adapter(spec.adapter, adapter_name=spec.name)
        base.adapter_names.append(spec.name)
        print(f"  adapter {spec.name}: +{self._allocated_gb() - before:.2f} GB VRAM")

    def describe(self):
        return {"models": [spec.as_dict() for spec in self.specs], "default": self.default_name}

    def resolve(self, name):
        """(spec, base) for NAME, or None when no such model is served.

        A request may name a model by its served NAME, or by the prefix
        before the first ':' of a served NAME: the TypeScript adapter
        (src/llm/local.ts, servedModelName) sends that prefix, and the legacy
        --adapter alias serves under a full 'local:<checkpoint>' label."""
        if name is None:
            name = self.default_name
        found = self.entries.get(name)
        if found is not None:
            return found
        for served, entry in self.entries.items():
            if served.split(":", 1)[0] == name:
                return entry
        return None


def make_handler(registry, max_new_tokens_cap=4096):
    # One lock for the whole process: set_adapter mutates the shared PEFT
    # model, so an adapter switch racing another request's generate would
    # run that request on the wrong weights. Serialising generate itself is
    # no loss either - a single GPU cannot usefully overlap two generations.
    generate_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass  # quiet; the caller measures latency itself

        def _send_json(self, status, obj):
            payload = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if self.path != "/models":
                self.send_response(404)
                self.end_headers()
                return
            self._send_json(200, registry.describe())

        def do_POST(self):
            if self.path != "/complete":
                self.send_response(404)
                self.end_headers()
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))

            result = self._complete(body)
            self._send_json(200, result)

        def _complete(self, request):
            # request matches CompletionRequest: {system, user, maxOutputTokens, temperature?, schema?, effort?, model?}
            try:
                system = request["system"]
                user = request["user"]
                max_new_tokens = clamp_max_new_tokens(request.get("maxOutputTokens"), max_new_tokens_cap)
                temperature = request.get("temperature")
                schema = request.get("schema")
                requested_model = request.get("model")

                resolved = registry.resolve(requested_model)
                if resolved is None:
                    served = ", ".join(sorted(registry.entries))
                    return {
                        "ok": False,
                        "error": {
                            "kind": "unavailable",
                            "message": f"no model named {requested_model!r} is served here (available: {served})",
                        },
                    }
                spec, base = resolved
                model = base.model
                tokenizer = base.tokenizer
                signature_index = base.signature_index

                effective_system = system_with_schema(system, schema)

                messages = [
                    {"role": "system", "content": effective_system},
                    {"role": "user", "content": user},
                ]
                ids = render_ids(
                    tokenizer, messages, tokenize=True, add_generation_prompt=True, return_tensors="pt"
                ).to("cuda")
                prompt_tokens = ids.shape[1]

                gen_kwargs = dict(
                    max_new_tokens=max_new_tokens,
                    pad_token_id=tokenizer.eos_token_id,
                )
                if temperature is not None and temperature > 0:
                    gen_kwargs.update(do_sample=True, temperature=float(temperature))
                else:
                    gen_kwargs.update(do_sample=False)

                # Constrain only when a schema was requested. /complete is a
                # general endpoint: a caller that asked for prose would have
                # every token of it masked by a JSON validator. `schema is not
                # None` is the same condition system_with_schema uses to decide
                # whether the schema text is appended, so the two stay in step.
                #
                # Constructed here, inside the request, never at load: this is
                # a ThreadingHTTPServer and the processor carries the running
                # parse state for one generation. A shared instance would
                # interleave two requests' states and corrupt both.
                json_processor = None
                if schema is not None and signature_index is not None:
                    json_processor = JsonPunctuationLogitsProcessor(signature_index, prompt_len=int(prompt_tokens))
                    gen_kwargs["logits_processor"] = [json_processor]

                with generate_lock:
                    torch.cuda.reset_peak_memory_stats()
                    t0 = time.perf_counter()
                    out = _generate_on(base, spec, ids, gen_kwargs)
                    torch.cuda.synchronize()
                    elapsed = time.perf_counter() - t0
                    peak_vram_gb = torch.cuda.max_memory_allocated() / (1024**3)

                # Constraint telemetry rides on every response, including the
                # failure paths: a fail-open that only showed up on success
                # would hide exactly the case worth seeing.
                def _constraint_debug():
                    if json_processor is None:
                        return {"constrained": False}
                    if json_processor.fail_open_events:
                        print(
                            f"WARNING: JSON constraint failed open "
                            f"({json_processor.fail_open_events} event(s)) after "
                            f"{json_processor.masked_steps} constrained step(s)"
                        )
                    return {
                        "constrained": True,
                        "constraintMaskedSteps": json_processor.masked_steps,
                        "constraintFailOpenEvents": json_processor.fail_open_events,
                    }

                new_ids = out[0][ids.shape[1]:]
                completion_tokens = new_ids.shape[0]
                text = tokenizer.decode(new_ids, skip_special_tokens=True)

                # Truncation check: did generation stop because it hit the
                # token budget rather than producing an EOS token itself?
                # Mirrors provider.ts's 'incomplete' kind - CompletionFailure's
                # own dedicated case, not a flavour of 'refused'.
                hit_token_limit = completion_tokens >= max_new_tokens and (
                    new_ids.numel() == 0 or new_ids[-1].item() != tokenizer.eos_token_id
                )

                if hit_token_limit:
                    return {
                        "ok": False,
                        "error": {
                            "kind": "incomplete",
                            "message": f"the answer was cut off at the output token limit ({max_new_tokens} tokens)",
                        },
                        # The partial text is the only evidence of WHY a
                        # generation ran away. Omitting it here is the same gap
                        # that made the first malformed-JSON batch undiagnosable.
                        "_debug": {
                            "latencySeconds": elapsed,
                            "peakVramGb": peak_vram_gb,
                            "partialText": text[-1500:],
                            "model": spec.name,
                            **_constraint_debug(),
                        },
                    }

                if text.strip() == "":
                    return {
                        "ok": False,
                        "error": {"kind": "refused", "message": "empty response"},
                        "_debug": {"latencySeconds": elapsed, "peakVramGb": peak_vram_gb, "model": spec.name,
                                   **_constraint_debug()},
                    }

                response = {
                    "ok": True,
                    "value": {
                        "text": text,
                        "usage": {
                            "promptTokens": int(prompt_tokens),
                            "completionTokens": int(completion_tokens),
                            "cachedPromptTokens": 0,
                        },
                        "model": spec.name,
                    },
                    "_debug": {"latencySeconds": elapsed, "peakVramGb": peak_vram_gb, "model": spec.name,
                               **_constraint_debug()},
                }
                # This server cannot enforce request.schema (no constrained/
                # structured decoding wired up locally, unlike Anthropic/Gemini's
                # native json_schema support) - report the downgrade rather than
                # silently ignoring it, per provider.ts's own schemaDowngraded contract.
                if schema is not None:
                    response["value"]["schemaDowngraded"] = True
                return response

            except Exception as e:  # noqa: BLE001 - report as CompletionFailure, don't crash the server
                return {"ok": False, "error": {"kind": "unavailable", "message": f"{type(e).__name__}: {e}"}}

    return Handler


def _generate_on(base, spec, ids, gen_kwargs):
    """
    Runs generate on the right weights for `spec`. Caller holds generate_lock.

    - base has no adapters at all: plain model.generate.
    - spec has an adapter: set_adapter(spec.name) then generate.
    - spec has no adapter but the base carries other entries' adapters:
      generate inside disable_adapter() so the shared base answers as plain.
    """
    model = base.model
    with torch.no_grad():
        if not base.is_peft:
            return model.generate(ids, **gen_kwargs)
        if spec.adapter:
            model.set_adapter(spec.name)
            return model.generate(ids, **gen_kwargs)
        with model.disable_adapter():
            return model.generate(ids, **gen_kwargs)


def build_arg_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--model", action="append", default=[], metavar="NAME=BASE[:ADAPTER_DIR]",
        help="a model to serve; repeatable; the first one is the default. "
             "Omit :ADAPTER_DIR to serve the plain base.",
    )
    parser.add_argument("--adapter", default=None,
                        help=f"legacy alias: one model named --model-name on {BASE_MODEL}")
    parser.add_argument("--model-name", default=DEFAULT_MODEL_NAME,
                        help="name of the single model when using --adapter")
    parser.add_argument("--port", type=int, default=8712)
    parser.add_argument("--max-new-tokens-cap", type=int, default=4096,
                        help="upper bound applied to every request's maxOutputTokens")
    return parser


def main():
    args = build_arg_parser().parse_args()
    try:
        specs = parse_model_specs(args.model, adapter=args.adapter, model_name=args.model_name)
    except ValueError as e:
        raise SystemExit(f"error: {e}")

    _import_runtime()

    registry = ModelRegistry(specs)
    registry.load_all()
    for spec in specs:
        marker = " (default)" if spec.name == registry.default_name else ""
        print(f"  serving {spec.name}{marker}: base={spec.base} adapter={spec.adapter or '-'}")

    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port),
        make_handler(registry, max_new_tokens_cap=args.max_new_tokens_cap),
    )
    print(f"READY: serving POST /complete and GET /models on http://127.0.0.1:{args.port} "
          f"(max_new_tokens cap {args.max_new_tokens_cap})")
    server.serve_forever()


if __name__ == "__main__":
    main()
