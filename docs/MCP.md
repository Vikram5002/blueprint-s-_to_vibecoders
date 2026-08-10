# Serving the architecture to agents

Three surfaces, in descending order of usefulness: an MCP server, a regenerated
`AGENTS.md`, and a self-contained HTML report. All three are read-only.

```bash
npx vibe-blueprint . --mcp       # speak MCP on stdio
npx vibe-blueprint . --export    # write AGENTS.md and blueprint.html
```

---

## 1. The MCP server

### `check_import` is the point

Every other tool here answers a question about the past: what does this
repository look like, what does it claim, where do those disagree. `check_import`
answers a question about a line that has not been written yet.

```
check_import(from: "src/parser/parse.ts", to: "src/llm/gemini.ts")
  -> forbidden
     "parser/ and graph/ must NEVER import from llm/." (CLAUDE.md:7)
```

That is the whole thesis in one call. An agent about to write an import can ask
whether the repository's own documentation permits it, *before* writing it,
instead of finding out in review — or never.

#### Why it cannot reuse the violation detector

`detectViolations` answers "which stated rules does this repository already
break". For an import that has not been written, the answer is always *none*.
Wiring `check_import` to it would have made every forbidden import look fine
right up until it was committed, and then start failing.

So the four detectors are re-expressed against a hypothetical edge. That
duplication is a real risk — two implementations of the same rules are free to
drift, and a checker that blesses what the report later flags is worse than no
checker. `check-import.test.ts` pins them together: for each relation, an edge
the detector calls a violation must be an edge the checker calls forbidden, and
the path-pattern case is checked exhaustively across every ordered pair.

#### Three verdicts, and the third is not a failure

| Verdict | Meaning |
|---|---|
| `forbidden` | A stated rule forbids this. Carries the sentence and its location. |
| `allowed` | Every document was read, and none forbids it. |
| `cannot-determine` | Genuinely unanswered. |

`cannot-determine` is returned when a path does not resolve, when a rule that
might concern these modules could not be evaluated, or when **any document went
unread, failed, or was truncated**. It outranks `allowed`, because an agent
given a confident yes by a tool that could not actually tell is worse off than
one given no answer — it will write the line and stop thinking.

It does *not* outrank `forbidden`. Missing data cannot un-find a finding.

This last rule was not designed in; it was found. See *An unread document is not
an absent rule*, below.

### The other three tools

| Tool | Returns | Provenance |
|---|---|---|
| `get_architecture(level?)` | Modules or files, and the edges between them | `DERIVED` |
| `get_violations(severity?)` | Where code and documentation disagree | `COMPARISON` |
| `get_constraints()` | The rules the repository states about itself | `STATED` |

Every response is labelled. An agent has no other way to tell a traced import
from a sentence someone wrote in a README, and the value of the whole surface
collapses if it treats them alike (rule 2). Every edge carries the file and line
behind it (rule 3) — an edge that arrives without evidence is an assertion the
agent cannot check.

`get_constraints` also reports the **uncheckable count**, because on this
project's own documents roughly twenty architectural statements are not
decidable from an import graph for every one that is. An agent told only about
the checkable few would badly misjudge how much of the stated architecture this
tool actually covers.

### Read-only, and structurally so

There is no write path — not a disabled one, not a flag. The tool handlers never
receive a store, and `architecture.test.ts` asserts that `src/mcp` imports no
socket, opens no listener, and reaches no store or filesystem writer. Adding
write access means deleting a test, which is the deliberate, separate decision
the scope note asks for.

**No port is opened.** stdio is a pipe to a parent process that already holds our
file descriptors — strictly less network exposure than the HTTP server, not
merely the same.

### Why the protocol is hand-rolled

`@modelcontextprotocol/sdk` is not installed. CLAUDE.md says not to add heavy
dependencies without asking, and the project has honoured that before: no
`@google/genai` for Gemini, a fifteen-line `.env` reader instead of dotenv. The
surface a read-only server needs is four methods (`initialize`, `ping`,
`tools/list`, `tools/call`) and one framing rule (newline-delimited JSON).

The cost is that protocol correctness is ours to demonstrate rather than assume,
so it is tested, and the acceptance below drives a real client.

Two things that are easy to get wrong and are therefore pinned by tests:

- **Notifications are never answered.** JSON-RPC 2.0 §4.1. Replying to
  `notifications/initialized` makes stricter clients report a protocol error.
- **Version negotiation echoes only what we know.** A client's requested version
  is echoed if supported, otherwise we answer with our newest. Echoing an
  unknown version back is a lie that surfaces three calls later.

### Connecting a client

```jsonc
// .mcp.json
{
  "mcpServers": {
    "vibe-blueprint": {
      "command": "npx",
      "args": ["vibe-blueprint", ".", "--mcp"]
    }
  }
}
```

`--mcp` implies `--no-serve` and `--no-open`, and silences every human-facing
line on stdout: in this mode **stdout belongs to the protocol**, and one stray
summary line corrupts the stream. Diagnostics go to stderr, which clients ignore.

---

## 2. `AGENTS.md`

The fallback for agents that do not speak MCP, and the only surface a human
reviews in a diff.

The brief asked for human-readable *and* machine-parseable, which usually pull
against each other. They are reconciled by making the prose the document and the
machine half a fenced block inside it:

````markdown
```json blueprint:constraints
{ "constraints": [...], "violations": [...], "completeness": {...} }
```
````

A person reads the headings; a parser reads the tagged block without parsing
Markdown prose. Neither audience gets a degraded version, and there is one file
to keep in sync.

**Regenerated, never merged.** The block sits between
`<!-- BEGIN vibe-blueprint -->` and `<!-- END vibe-blueprint -->`, and only that
span is rewritten. Notes the developer wrote around it survive. Merging *inside*
the block would mean reconciling a stale claim with a fresh measurement, and the
measurement is the point.

### The feedback loop, and why the block is stripped on read

`AGENTS.md` is also one of the documents intent extraction *reads*. Left alone,
the second run would read the first run's output back in as freshly stated
intent — the tool measuring itself, counting every constraint twice, and making a
rule it merely *reported* indistinguishable from one a human wrote.

`stripGeneratedBlocks` removes the marked span before extraction. It is
deliberately tolerant: an unmatched BEGIN truncates to end-of-file, because a
half-written block from an interrupted run is still our output.

---

## 3. `blueprint.html`

One self-contained file. Double-click it; there is no server.

It does **not** reuse the React bundle. That bundle is a client of the JSON API —
rule 4 says so, and that is right while a server exists — but under `file://`
there is no API to call, and a bundle fetching `/api/graph` from a local file
produces exactly the console errors this export must not produce. The data is
inlined at generation time and rendered by a few dozen lines of vanilla script.

**No external requests of any kind**: no CDN, font, image, or analytics. Partly
so a double-click works offline; partly because this is a local-first tool
reading private source code, and an export that phoned anywhere would be a data
leak wearing a report's clothes. A test asserts the absence of `http://`,
`fetch(`, `src=` and `href=`.

The timestamp and commit are rendered in the header rather than an HTML comment,
because a static file outlives the run that made it and a reader has no other way
to tell whether they are looking at today's measurement.

Untrusted source text is escaped for `<script>` embedding — `</script>` closes
the element from inside a JSON string no matter where it appears, and a
repository that renders HTML will contain that text.

---

## What acceptance found

Both of these were found by running the thing for real, not by testing it.

### An unread document is not an absent rule

Driving a client against this repository with the Gemini daily free-tier quota
exhausted, `CLAUDE.md` was never read. Asking whether `parser/` may import `llm/`
returned:

> **allowed** — "no stated rule applies to it"

against a document that forbids exactly that, in capital letters, as rule one.
The tool gave an agent permission to break the repository's most load-bearing
rule because it could not read the sentence stating it.

This is the same family as the truncation bug (Week 10) and the drift-chart bug
(Week 9): an unmeasured zero and a measured zero are byte-identical unless
something insists on telling them apart. It is worst here, because this is the
answer an agent acts on *before* writing code rather than a number in a report.

Fixed in two places: `check_import` now takes the extraction's health and
downgrades to `cannot-determine`, and `buildIntentResponse` — which the Week 10
UI panel also reads — gained an `extraction-failed` reason, having previously
reported "the documents were read and stated no dependency rules" about
documents it had failed to read.

### A systematic false positive

Against a constructed breach repository, `check_import` reported **every** import
as forbidden, including `api -> parser`, which that repo's `AGENTS.md`
explicitly permits.

Rules written about directories resolve as `PATH_PATTERN`, and the overlap test
compared the endpoint's *module* ids. A path pattern is narrower than the module
its files land in, so comparing modules silently widened every such rule to its
whole module — and the repo was small enough that clustering produced a single
module, widening every rule to everything.

The detector never had this bug because it has always crossed *file* sets. The
existing agreement tests missed it because their fixtures used `MODULE`-status
subjects with one file per module, where the two granularities coincide.

Week 8 named this failure mode as worse than missed coverage, and it is: a
confident, systematic false positive is what makes an agent stop trusting the
tool and stop calling it.

---

## Verified, and not

**Verified.** The full handshake and all four tools against a scripted JSON-RPC
client, on this repository and on a constructed breach repository — including
`forbidden` on a known-violating edge with the sentence and location attached,
and `cannot-determine` on an unresolvable path. `blueprint.html` generated from
both, executed in a DOM harness: valid embedded payload, zero console errors, no
external references, timestamp and commit rendered. `AGENTS.md` splices without
disturbing surrounding prose and survives repeated regeneration.

**Not verified.**

- **The three reference repositories (`requests`, `zod`, `pyright`) were not
  re-checked.** They are not present on this machine, and re-cloning plus
  re-analysing each is bounded by the same daily model quota. The scale property
  was exercised instead on this repository (208 files, 25 modules, 452 edges),
  which is the same order as `zod`.
- **A packaged MCP client (Claude Code itself) was not attached.** The exchanges
  recorded above came from a scripted client speaking the same wire protocol,
  which proves the framing and the payloads but not the discovery path in a
  shipped host.
- **The Haiku/Sonnet label comparison remains unrun** (no `ANTHROPIC_API_KEY`),
  as since Week 5.
