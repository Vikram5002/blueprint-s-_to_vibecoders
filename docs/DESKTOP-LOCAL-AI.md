# Desktop local AI (0.2.3)

The Windows installer offers local planning and code generation on first launch.
Return to **File > Local AI Setup** to recheck hardware, choose a model folder,
download/resume, verify existing files, or stop local AI. Skipping setup preserves
the existing online-provider workflow. Stopping local AI keeps downloaded files
and restores the saved workspace provider settings when they still point to the
managed runtime. Other project folders are restored when reopened.

## Models and requirements

Three adapters on two base models; each choice is the best measured one:

| Role | Base model | Adapter | Training rows | Why this one |
| --- | --- | --- | --- | --- |
| Plan (`local`) | Qwen2.5-7B-Instruct | `planner_r4` from `pdsf/plan_r4.zip` | 331 complete plans | complete plans for 75 of 86 held-out prompts (round 3: 20; 91-row: 2) - `training/eval/planner` |
| Code (`local-code`) | Qwen2.5-Coder-7B-Instruct | `code_modal_20260927_212455` from `pdsf/code_adapter.zip` | 403 | best first attempt and whole-project rate of rounds 1-5 |
| Repair (`local-fix`) | Qwen2.5-Coder-7B-Instruct (same files) | `code_rich_r4` from `pdsf/code_adapter_r4.zip` | 2,221 | round 1 writing + round 4 repairing: 95.7% after repair against 87.0% |

The planner also answers **Suggest more features** with its own instruction (no
separate model). Changing any entry in `desktop/prepare-local-ai.py` means its
adapter ID, source checksum, converted checksum, model label, UI copy and
evaluations change together; never relabel one adapter as another.

The installer includes llama.cpp b11572 for Windows x64, F16 GGUF conversions of
the LoRA adapters, and license files. It downloads the official Qwen Q4_K_M base
models (9,366,147,168 bytes total, about 9.37 GB / 8.72 GiB). The planner uses two
GGUF shards; both must be in the same folder. GGUFs are pinned by repository
revision, byte length and SHA-256. Original training ZIPs are left untouched.

Supported setup requires Windows x64 and at least approximately 16 GB usable
installed RAM. The bundled runtime performs a real CPU/backend probe. It also
enumerates Vulkan devices and distinguishes shared integrated memory from
dedicated VRAM. Recommendations are deliberately conservative:

- Dedicated GPU with at least 7,500 MiB: full GPU offload.
- Dedicated GPU with at least 3,500 MiB: hybrid - `(memory - 900) / 160` layers on
  the GPU (4 to 27; 20 on a 4,152 MiB GTX 1650), the rest on CPU. A load that runs
  out of graphics memory retries with 4 fewer layers.
- Otherwise: CPU, with a clear speed warning.
- Wrong architecture, insufficient RAM or a failed runtime probe: setup stays
  unavailable; online providers remain usable.

These thresholds are recommendations, not performance guarantees. Driver
compatibility and available memory are finally checked by loading and running
**both** models during setup. GPU failures are reported; the user can retry CPU
mode. The application never silently sends a failed local request to a cloud
provider. Full GPU behavior still needs validation on a suitable second PC.

## Runtime behavior

On a GPU the runtime uses flash attention and an 8-bit KV cache. Measured on the
development laptop (GTX 1650, one 300-token coder answer): the old fixed 12 layers
wrote 7.8 tok/s and loaded in 12 s; 20 layers with these settings write 12.0 tok/s
and load in 4 s. 22 or more layers did not fit in 4 GB.

Replies are not limited by time: the bridge sends headers at once and a space
every 30 s while the model works, and the engine talks to llama-server over plain
`node:http` - Node's `fetch` drops an answer that takes over 300 s, which a large
file on a hybrid laptop does.

Only one llama-server process/model is loaded at a time. Planning and code
requests share a bounded sequential queue; changing roles unloads the previous
model first. Idle models unload after five minutes. Normal app exit stops the
owned runtime. The runtime uses a 16,384-token context, output requests up to
8,192 tokens, and explicit errors for truncated output or context/memory errors.

The bridge binds only to `127.0.0.1`, uses a fresh unguessable path each launch,
rejects browser Origin headers, validates requests and caps their size. The
underlying llama server uses its own ephemeral port and API key. Setup IPC is
restricted to the local setup page; the workspace has no filesystem IPC bridge.
The workspace receives the current addresses automatically. Model provenance
includes the adapter ID and GGUF quantization, so this runtime is distinguishable
from the earlier Python/NF4 service.

Downloads use `.part` files, resume with validated HTTP ranges, verify SHA-256,
then rename to their final filenames. Existing mismatched user files are not
deleted. Cancelling keeps partial downloads. Selecting another folder is saved
so interrupted setup can resume there on a later launch. Existing files can be
verified without downloading anything.

Inference can work offline after setup. The desktop server and generated
applications still need Node.js/npm; first-time dependency installation and
generated apps with external services may require internet. Python, CUDA and
training tools are not required by end users.

## Build and preserve installers

From `desktop/`:

```powershell
npm run prepare:local  # build machine only: Python, torch, transformers, safetensors
npm run vendor        # build and pack the root server package explicitly
npm test
npm run dist
```

`dist` verifies adapters, licenses, the server package identity, and the separate
versioned output directory before packaging. Output is
`desktop/release/0.2.0/VibeCoder Setup 0.2.0.exe`. The earlier installer and its
unpacked files stay in `desktop/release/`; they are not removed or rebuilt.

The original `VibeCoder Setup 0.1.0.exe` is 112,745,886 bytes with SHA-256:

```text
407403ca384873e9c6cbefd666989cac01c03273aa2aa86001dfebf1adf32039
```

Build/validation logs and test model downloads are in the ignored
`backup/local-ai-validation/` folder. The build script pins the source ZIP,
runtime ZIP, base configs and source adapters. Converted manifest and adapters
are generated under ignored `desktop/vendor/local-ai/` and bundled as resources.

## Validation recorded on 2026-10-13

On this i7-11800H / 16 GB RAM / GTX 1650 4 GB laptop:

- Both real adapters loaded and generated in hybrid mode (setup check: 48.6 s).
- A planner request passed the application's ProjectSchema generator/validator
  (52.7 s), and a code request passed its component generator (24.9 s).
- The generated TypeScript passed strict compilation, 500 dice-range checks,
  and checks rejecting zero, negative, fractional and non-finite inputs.
- Both real adapters loaded and generated in CPU mode (setup check: 70.1 s).
  CPU schema-constrained generation returned the expected JSON (20.9 s).
- All three downloaded base GGUFs matched their expected byte counts and SHA-256.
- Lint/type checking and all 12 desktop tests passed. The root suite had 1,537
  passes and one intentional skip; its remaining unzip test passed after adding
  the installed Git `usr/bin` directory to the test process PATH (1,538 unique
  passing tests in total).
- The first-launch setup, hardware display, skip and workspace launch were
  exercised through Electron. The temporary test launcher's incorrect Electron
  import was fixed; that launcher is not included in the installer.
- Electron UI integration also passed importing the real models, automatically
  connecting the planner/coder providers, reconnecting after an app restart,
  and restoring the previous provider settings when local AI is stopped.

These are functional smoke checks, not a quality certification. For example,
the planner's offline dice-app output still declared a frontend-to-backend
dependency despite an empty backend. That baseline model limitation is recorded
in `backup/local-ai-validation/runtime-results.json`; the 288-example checkpoint
has not been substituted or evaluated.

## Further release validation

Automated tests cover CPU/GPU/shared-memory recommendations, range resume,
cancellation, corrupt downloads, preservation of mismatched files, queueing,
cross-origin rejection, single-process model switching, idle unload, schema
forwarding, truncated responses and model identity. The desktop integration test
installs the server in a temporary folder and verifies both startup and reuse.

Before treating this as a release for other users, record:

1. Broader planning and complete generated-application evaluation through VibeCoder. Previous
   NF4/QLoRA training scores do not certify this Q4_K_M inference conversion.
2. Installation, launch, skip, download/import, restart and uninstall on a second
   Windows PC. Test low disk space, unsupported hardware and a missing GPU driver.
3. A full GPU test on a PC with sufficient VRAM. This development laptop has a
   4 GB GTX 1650, so it cannot validate that mode.

Publishing, code signing, the VS Code extension, Oracle, AWS, paper and patent
work are outside this desktop change.
