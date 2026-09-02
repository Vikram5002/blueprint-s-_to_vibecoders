# ADR-002: Request model for the ProjectSchema generation + compilation API

**Status:** Proposed (2026-09-02) — awaiting approval before any endpoint
code is written, per the explicit instruction that produced this document.

**Context date:** 2026-09-02. Written before `src/server/` gains any route
for `generate-project-schema.ts` or `compile-constraints.ts` — both
currently have zero HTTP call sites. Uses the same Context / Options /
Decision / Consequences shape ADR-001 was asked to use, in ADR-001's own
voice: state the tradeoffs honestly, don't pick a side by default, name
what was considered and rejected rather than silently omitting it.

---

## Context

The first HTTP surface connecting `ui/` to `createProjectSchemaGenerator()`
and `compileDomainConstraints()` has two phases, chained:

1. **Generate** — `generate(prompt)` makes one live `CompletionProvider`
   call and validates the result. This is the only slow, variable part.
2. **Compile** — `compileDomainConstraints(schema)` is synchronous,
   deterministic, and already measured as effectively free: its own
   docstring (`src/workflow/compile-constraints.ts`) records the
   revalidation added this session at **~1.89us**, against the compiler's
   own **~8.46us**, on this repo's largest real schema — call it ~10us
   combined. Against generation's multi-second latency, compile time does
   not factor into this decision at all.

So the whole design question reduces to: how does the API expose a
request whose latency is dominated by one live model call, when that
model call's actual latency profile depends on which provider answers it.

**Measured latency, both providers, as given:**

| Provider | Per-request latency | Concurrency |
|---|---|---|
| Gemini (live call) | 3–16s | Provider-side; not this codebase's concern |
| Local model | 10.7–27s | **None** — one GPU, one model process, requests serialize |

The local number is the one that matters for this decision. "No
concurrency handling" is not a detail — it means a second request arriving
while the first is still generating does not run in parallel, it queues
fully behind it. Two concurrent requests against the local model cost up
to `27 + 27 = 54s` for the second one; three cost up to `81s`; the codebase
enforces no bound on this today. This is a real, already-measured
consequence of the current implementation, not a hypothetical worst case
invented for this ADR.

**One thing this ADR will not lean on:** the classic "a synchronous call
might get killed by a reverse proxy's 30-second timeout" argument for
async APIs does not automatically apply here. Per CLAUDE.md's tech-stack
table, the server binds to `127.0.0.1` only — there is no proxy, gateway,
or CDN in the path for this tool, on either machine. If that were the only
argument available, it would not be enough on its own, and this document
says so plainly rather than reaching for it as a generic justification.
The real argument has to come from the measured numbers above, not from
web-services convention.

**Why this can't be answered per-request inside the API layer:** provider
selection is deliberately centralized. `src/llm/select-provider.ts` is the
one place in this codebase that is supposed to know which provider is
live (`VIBE_LLM_PROVIDER`); every call site above it — `label-modules.ts`,
`extract-intent.ts`, and now `generate-project-schema.ts` — is written
provider-agnostic, against the `CompletionProvider` interface, on purpose.
An HTTP layer that changed its own response contract (sync here, async
there) depending on which provider happens to be configured would be a
new place that leaks provider identity above that seam, which nothing
else in this codebase does.

No API contract exists yet for either function — `compileDomainConstraints`
has never had a production call site (confirmed in ADR-001), and
`generate-project-schema.ts` has none either. That makes this exactly the
"cheap to decide now, expensive to decide after a consumer exists" moment
ADR-001 already named for its own decision.

---

## Options

### Option A — synchronous request-response

`POST /api/workflow/generate` blocks until generate-then-compile finishes,
returns `200` with the full result in one response.

**Consequence, stated plainly:** viable on Gemini's 3–16s in isolation —
nothing in the stack would kill that connection. It is not viable once the
local model is the configured provider: the client has no way to
distinguish "still generating, 4th in the local queue" from "the
connection died," and any timeout picked to be safe against the local
model's unbounded-queue worst case would be needlessly long for Gemini,
while any timeout sized for Gemini would routinely misfire against the
local model under nothing more than ordinary concurrent use. A single
synchronous contract cannot be tuned correctly for both providers at once,
because the two providers' worst cases are not close to each other.

### Option B — submit-and-poll (job + status endpoint)

`POST /api/workflow/jobs` accepts `{ prompt }`, creates a job in `pending`
state, returns `202` and a job id immediately, before generation starts.
`GET /api/workflow/jobs/:id` returns the job's current status
(`pending` / `running` / `succeeded` / `failed`) and, once `succeeded`, the
full result. The actual generate-then-compile work runs after the `POST`
has already returned.

**Consequence:** the contract is identical regardless of which provider
answers — the client polls the same way whether the result lands in 4
seconds or 80. No connection is held open across the slow part, so there
is no timeout to mis-tune per provider, and provider identity never has
to reach the HTTP layer. The cost is real and worth naming, not hidden:
two round trips instead of one, and whichever frontend consumes this
(not this task's concern — `ui/` is untouched here) has to implement
polling instead of awaiting a single call. That is genuine added
complexity, but it is complexity paid once, in the client, rather than a
per-request risk of an unkillable hung connection.

### Option C — hybrid: synchronous when the fast provider is live, async fallback otherwise

Considered and rejected outright, not modeled further. This is exactly
the provider-identity leak named in Context: the API layer would have to
know which provider `select-provider.ts` chose in order to decide which
HTTP contract to speak this request, which is a decision this codebase
has never allowed anywhere above that one seam. It would also mean the
same endpoint returns two different response shapes and status-code
sequences depending on server-side state the client cannot see in
advance — a worse contract than committing to either A or B alone. Named
here only so it is visible as considered, not silently skipped.

---

## Decision

**Option B — submit-and-poll, applied uniformly, regardless of which
provider actually serves the request.**

This is explicitly not "pick per request based on the configured
provider" — that is Option C, rejected above. The same job-based contract
is used whether Gemini or the local model answers.

**Does the answer differ by provider, stated as plainly as asked:** if
this system only ever had to support Gemini's 3–16s, a synchronous design
would likely have been defensible — the server is local-only, nothing in
the path imposes an external timeout, and the latency is short enough
that a blocking call is a reasonable thing to ask a browser to wait on.
It is specifically the local model's measured combination — 10.7–27s
*and* zero concurrency handling, so one slow request fully blocks the
next with no bound this codebase enforces today — that makes a
synchronous contract unsafe for a case this system must actually support,
since both providers are live, interchangeable options behind one
interface. Designing the API around the fast case and hoping the slow one
doesn't get hit is exactly the kind of thing CLAUDE.md's measure-first
discipline, and ADR-001's own decide-before-building framing, exist to
prevent.

---

## Consequences

- **New resource: a job.** First cut is in-memory (`Map<jobId, JobRecord>`),
  not persisted to `.vibe/blueprint.db`. A generation job is ephemeral,
  single-process state; this task is explicitly a scaffold proving the
  real data path end to end, not production hardening. A server restart
  loses in-flight and completed jobs — named here as a known, accepted
  limitation, not something this task fixes.
- **Job states:** `pending -> running -> succeeded | failed`. Generate and
  compile are two real phases inside `running`, but compile's ~10us
  against generate's multi-second latency means there is no meaningful
  intermediate status worth exposing between them — the job moves
  straight from `running` to its terminal state once both steps finish.
- **Result shape, per ADR-001 and the task's own instruction:** the
  `succeeded` payload carries the full `ProjectSchema` plus the compiler's
  output as two separate fields — `prohibitions: Constraint[]` and
  `permissions: WorkflowPermission[]` — never flattened into one list,
  since ADR-001 already established these are structurally different
  claims.
- **A hard cap on concurrent/queued jobs is decided now, not deferred.**
  This is not the same class of gap as "no persistence" or "no auth"
  below — an unbounded in-memory queue interacts directly with the exact
  local-model contention problem this ADR's whole decision is built
  around. Submit-and-poll removes the *held-open-connection* risk from a
  burst of requests, but does nothing by itself to stop a burst from
  piling up an unbounded backlog against a provider that serializes at
  10.7–27s per job; leaving the queue unbounded would let that burst
  degrade the service in exactly the way this document exists to
  prevent. `MAX_CONCURRENT_JOBS`, a named, tunable constant (a scaffold
  default in the 5–10 range), caps jobs counted in `pending` or
  `running` together. A `POST` that would exceed the cap is rejected
  immediately — `503`, with a `Retry-After` hint — rather than accepted
  and silently queued past the limit.
- **Explicitly deferred, matching the task's stated scope:** no
  persistence, no job TTL or cleanup, no auth, no rate limiting beyond
  the concurrency cap above. These are real gaps for a production
  surface and are named as gaps, not solved here.
- **Client polling cadence and backoff are not this ADR's concern.** This
  fixes the server-side contract only; the polling strategy is whoever
  builds the `ui/` consumer's decision, later, separately.
- **Breaking-change cost if this is wrong:** identical in kind to what
  ADR-001 named for its own decision — once a real consumer exists, sync
  vs. async is a breaking contract change for every client, not a UI
  refactor. Deciding this now, before that consumer exists, is the whole
  reason this document exists rather than the answer being discovered
  mid-implementation.
