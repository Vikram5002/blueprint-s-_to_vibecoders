"""
Pure-Python unit tests for local_inference_server.py's torch-free layer:
system_with_schema (the training/inference prompt contract) and the
--model NAME=BASE[:ADAPTER_DIR] parsing.

Run either way:
    python pdsf/test_server_units.py
    python -m pytest pdsf/test_server_units.py

No GPU stack needed: importing the server module must NOT import torch, and
the first test asserts exactly that.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import local_inference_server as srv  # noqa: E402


def test_import_does_not_pull_in_torch():
    assert srv.torch is None, "module import must stay torch-free; runtime is imported in main()"


def test_system_with_schema_none_is_identity():
    assert srv.system_with_schema("hello", None) == "hello"


def test_system_with_schema_matches_original_handler_bytes():
    schema = {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]}
    system = "You write one file."
    expected = system + "\n\nReply with JSON matching exactly this schema:\n" + json.dumps(schema)
    assert srv.system_with_schema(system, schema) == expected
    # json.dumps default separators (", " and ": "), not compact - the
    # original handler used the default, and training rows must match it.
    assert '"type": "object"' in srv.system_with_schema(system, schema)


def test_system_with_schema_empty_object_is_still_appended():
    assert srv.system_with_schema("s", {}) == "s\n\nReply with JSON matching exactly this schema:\n{}"


def test_parse_model_arg_base_only():
    spec = srv.parse_model_arg("teacher=Qwen/Qwen2.5-Coder-14B-Instruct")
    assert spec == srv.ModelSpec("teacher", "Qwen/Qwen2.5-Coder-14B-Instruct", None)


def test_parse_model_arg_with_adapter():
    spec = srv.parse_model_arg("plan=Qwen/Qwen2.5-7B-Instruct:/content/adapter_root/run_x")
    assert spec.name == "plan"
    assert spec.base == "Qwen/Qwen2.5-7B-Instruct"
    assert spec.adapter == "/content/adapter_root/run_x"


def test_parse_model_arg_keeps_windows_drive_colon_in_adapter():
    spec = srv.parse_model_arg("plan=Qwen/Qwen2.5-7B-Instruct:D:\\runs\\run_20260912_154324")
    assert spec.base == "Qwen/Qwen2.5-7B-Instruct"
    assert spec.adapter == "D:\\runs\\run_20260912_154324"


def _raises(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except ValueError:
        return True
    return False


def test_parse_model_arg_rejects_malformed():
    assert _raises(srv.parse_model_arg, "no-equals-sign")
    assert _raises(srv.parse_model_arg, "=Qwen/base")
    assert _raises(srv.parse_model_arg, "name=")
    assert _raises(srv.parse_model_arg, "name=:/adapter/only")


def test_parse_model_specs_first_is_default_and_order_kept():
    specs = srv.parse_model_specs([
        "plan=Qwen/Qwen2.5-7B-Instruct:/a",
        "code=Qwen/Qwen2.5-Coder-7B-Instruct:/b",
        "teacher=Qwen/Qwen2.5-Coder-14B-Instruct",
    ])
    assert [s.name for s in specs] == ["plan", "code", "teacher"]
    assert specs[2].adapter is None


def test_parse_model_specs_legacy_adapter_alias():
    specs = srv.parse_model_specs([], adapter="/content/adapter_root/run_x", model_name="local:x")
    assert specs == [srv.ModelSpec("local:x", srv.BASE_MODEL, "/content/adapter_root/run_x")]


def test_parse_model_specs_legacy_alias_default_name():
    specs = srv.parse_model_specs([], adapter="/x")
    assert specs[0].name == srv.DEFAULT_MODEL_NAME


def test_parse_model_specs_rejects_both_and_neither_and_duplicates():
    assert _raises(srv.parse_model_specs, ["a=b"], adapter="/x")
    assert _raises(srv.parse_model_specs, [], adapter=None)
    assert _raises(srv.parse_model_specs, ["a=b:/1", "a=c:/2"])


def test_registry_describe_shape_without_loading():
    reg = srv.ModelRegistry(srv.parse_model_specs(["plan=B1:/a", "teacher=B2"]))
    described = reg.describe()
    assert described["default"] == "plan"
    assert described["models"] == [
        {"name": "plan", "base": "B1", "adapter": "/a"},
        {"name": "teacher", "base": "B2", "adapter": None},
    ]
    assert reg.resolve("nope") is None  # nothing loaded yet either


def test_handler_unknown_model_is_unavailable_error_without_touching_gpu():
    reg = srv.ModelRegistry(srv.parse_model_specs(["plan=B1:/a"]))  # nothing loaded: entries empty
    Handler = srv.make_handler(reg)
    handler = Handler.__new__(Handler)  # no socket; only _complete is exercised
    result = handler._complete({"system": "s", "user": "u", "model": "code"})
    assert result["ok"] is False
    assert result["error"]["kind"] == "unavailable"
    assert "'code'" in result["error"]["message"]


def test_clamp_max_new_tokens():
    assert srv.clamp_max_new_tokens(None, 4096) == 512
    assert srv.clamp_max_new_tokens(9000, 4096) == 4096
    assert srv.clamp_max_new_tokens(100, 4096) == 100
    assert srv.clamp_max_new_tokens(0, 4096) == 1
    assert srv.clamp_max_new_tokens("bad", 4096) == 512


def test_cli_parser_accepts_repeatable_model_and_cap_default():
    args = srv.build_arg_parser().parse_args(["--model", "a=b", "--model", "c=d:/e"])
    assert args.model == ["a=b", "c=d:/e"]
    assert args.max_new_tokens_cap == 4096
    assert args.port == 8712


if __name__ == "__main__":
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok    {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {name}: {type(e).__name__}: {e}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
