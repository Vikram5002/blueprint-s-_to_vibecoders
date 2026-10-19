"""
Serves the local-model protocol (GET /models, POST /complete - what
src/llm/local.ts and scripts/capture-code-batch.mjs speak) in front of a vLLM
OpenAI-compatible server, so a vLLM-served teacher can produce training data
through the unchanged capture pipeline.

    vllm serve cyankiwi/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit --served-model-name teacher --port 8000 ...
    python teacher_shim.py --vllm http://127.0.0.1:8000 --model teacher --port 8712

Standard library only. Binds to loopback; reach it through an SSH tunnel.
"""
import argparse
import json
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def complete(args, body):
    request = {
        "model": args.model,
        "messages": [{"role": "system", "content": body["system"]}, {"role": "user", "content": body["user"]}],
        "max_tokens": min(int(body.get("maxOutputTokens", 4096)), args.max_tokens),
        "temperature": body.get("temperature", 0),
    }
    if body.get("schema") is not None:
        request["response_format"] = {"type": "json_schema", "json_schema": {"name": "response", "schema": body["schema"]}}
    req = urllib.request.Request(f"{args.vllm}/v1/chat/completions", data=json.dumps(request).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=900) as response:
            reply = json.load(response)
    except urllib.error.HTTPError as error:
        return {"ok": False, "error": {"kind": "provider-error", "message": f"vLLM HTTP {error.code}: {error.read()[:300]!r}"}}
    choice = reply["choices"][0]
    if choice.get("finish_reason") == "length":
        return {"ok": False, "error": {"kind": "incomplete", "message": "the teacher reached its output limit"}}
    usage = reply.get("usage") or {}
    return {"ok": True, "value": {"text": choice["message"]["content"], "model": args.model,
                                  "usage": {"promptTokens": usage.get("prompt_tokens", 0),
                                            "completionTokens": usage.get("completion_tokens", 0), "cachedPromptTokens": 0}}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vllm", default="http://127.0.0.1:8000")
    parser.add_argument("--model", default="teacher")
    parser.add_argument("--port", type=int, default=8712)
    parser.add_argument("--max-tokens", type=int, default=8192)
    args = parser.parse_args()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/models":
                self.reply(200, {"models": [{"name": args.model, "base": args.model, "adapter": None}], "default": args.model})
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/complete":
                self.reply(404, {"error": "not found"})
                return
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self.reply(200, complete(args, body))

        def log_message(self, *_):
            pass

    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
