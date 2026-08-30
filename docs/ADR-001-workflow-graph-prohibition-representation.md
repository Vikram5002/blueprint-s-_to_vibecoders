# ADR-001: How the workflow graph represents compiled prohibitions

**Status:** Proposed. This is a decision document, not an implementation —
see the closing note. No code changes accompany this ADR.

**Context date:** 2026-08-30. No prior ADRs exist in this repository
(checked `docs/` and the whole tree before writing this); this file uses
the fallback structure — Context / Options / Decision / Consequences —
rather than matching an established local convention, because there
isn't one yet.

---

## Context

`ui/src/workspace/workflow-mocks.ts` and `workflow-layout.ts`'s
`deriveEdges()` currently draw one graph edge per `DomainSpec.dependsOn`
entry. `SMALL_PROJECT_SCHEMA` has 3 such entries, so the graph draws 3
edges, and clicking one shows a `Constraint` if `findDomainConstraint()`
manages to phrase-match one to it.

`compileDomainConstraints` (built earlier this session) answers a related
but different question. For any 4-domain `ProjectSchema` it emits exactly
**12** records — one per ordered pair of distinct domains, always, closed-
world: `4 × 3 = 12`. For `SMALL_PROJECT_SCHEMA`, that's the same 3
`dependsOn` entries as `WorkflowPermission`s, plus **9 prohibitions** — a
`must-not-import` `Constraint` for every ordered pair `dependsOn` does
*not* name.

Those 9 have no home in the current graph. `deriveEdges()` never creates
an edge for an absent `dependsOn` pair, so there is nothing to click, and
the edge-inspection panel's "no rule stated yet" fallback text doesn't
even apply — that message requires an edge to already exist to attach
itself to. A prohibition in the compiler's output is not "an edge with no
rule." It is a real, STATED claim (`must-not-import`, with its own `id`,
`rawText`, `confidence: 1`) that currently cannot be represented in this
graph *at all*, drawn or not.

This is not hypothetical or new. The mock's own author already hit a
one-instance version of it by hand, in `SMALL_PROJECT_SCHEMA` itself:

> `// Does not attach to any drawn edge: frontend does not depend on
> database directly, so there is no frontend -> database edge to attach
> it to. Kept anyway, honestly — not every stated rule describes an
> intended edge.`

The compiler generalizes that one hand-written exception into the norm:
for 4 domains, **9 of every 12 compiled records** are exactly this case,
every time, for every schema.

**This is a representation disagreement, not a bug.** Both models are
internally consistent on their own terms. `deriveEdges()` draws *declared
architecture* — what a schema's author actually said depends on what.
`compileDomainConstraints` emits a *closed-world claim set* — what is
permitted and what is forbidden, both equally real, both equally STATED,
neither one more "the graph" than the other. The question this ADR
answers is which of these two models the workflow graph should be a
picture *of* — or whether it should try to be a picture of both.

---

## The two models, stated fairly

| | `deriveEdges()` (current) | `compileDomainConstraints` |
|---|---|---|
| Edge count for 4 domains | Equal to `dependsOn.length`, schema-dependent | Always exactly 12 |
| What "no edge" means | Nothing — not drawn, not represented | A real prohibition, with its own `id`/`rawText` |
| Growth | Grows only with declared structure | Fixed size, independent of the schema's content |
| Represents | Intended architecture | The full permitted/forbidden partition |

Neither model is wrong. `deriveEdges()` answers "what does this project
depend on." `compileDomainConstraints` answers "what is this project
allowed and not allowed to depend on." Those are different questions,
and right now only the first one has a UI.

---

## Option A — draw prohibition edges too

Every one of the 12 records becomes a drawn graph element; permissions
and prohibitions distinguished visually (color, stroke style, direction
convention).

**Consequence, addressed honestly rather than assumed away:** 4 domains
admit at most `4 × 3 = 12` ordered directed edges with no self-loops —
which is exactly what the closed-world compiler always emits. **Drawing
every record means the graph is always the complete directed graph on 4
nodes, for every project, regardless of what the schema actually says.**
The number of edges never varies; only the mix of permitted-vs-forbidden
does. That is a sharper problem than "the graph looks busy" — it means
the graph's *shape* carries zero information. A viewer can no longer read
architecture from topology at a glance the way they can today (3 edges,
a specific shape, specific to this schema); they would have to read edge
*styling* instead, for every one of 12 edges, every time.

So Option A is not viable as "just draw all 12 edges plainly." It only
works with real de-emphasis built in from the start:

- **Visual weight asymmetry**: permissions solid, saturated, labeled;
  prohibitions thin, low-opacity, unlabeled by default — the eye should
  parse permissions as the graph's primary structure and prohibitions as
  background texture, not the reverse.
- **On-demand reveal**: prohibitions hidden by default, shown per-node on
  hover/click ("3 things this domain must not depend on"), never all 9
  visible simultaneously by default.
- **An explicit filter control**: "show prohibitions: none / all /
  violated only" — the last option becomes available only once real
  violation-checking exists (see the verification-display section
  below), and is arguably the option worth defaulting to once it does.

Any of these is real, new UI work — a second visual language, a new
interaction model, and (mechanically) a parallel edge-id scheme, since
`WorkflowEdge.id` is currently just `${from}->${to}` and only ever
constructed for entries that exist in `dependsOn`; prohibition edges
would need the same addressable scheme extended to every ordered pair,
which is straightforward (the pair itself is always a stable identifier)
but is still a change, not a given.

---

## Option B — the graph stays a strict subset; prohibitions live elsewhere

`deriveEdges()` keeps doing exactly what it does today — one edge per
real `dependsOn` entry, nothing else. Prohibitions surface somewhere
else: a list, a dedicated panel, or folded into the verification display
once real code exists to check them against.

**Consequence, stated as plainly as the prompt asked:** the workflow
graph stops being the complete picture of what the compiler knows. A
user looking only at the graph would never learn that "frontend must not
import database" is a real, compiled, STATED rule for their project —
they would have to go find it somewhere else. For a tool whose whole
positioning is "here is the one place that shows the gap between what
you said and what you built," having the *graph itself* — the most
prominent, spatial, at-a-glance surface — be structurally incomplete is
a real cost, not a cosmetic one.

Its advantage is equally real: **zero regression to what already ships.**
The graph stays exactly as legible as it is today, no new visual
language, no new interaction model, no edge-id scheme to extend. This
option costs nothing today and defers the harder design work.

---

## Option C — a third path: prohibitions attached to the graph, not drawn as edges on it

Keep `deriveEdges()` exactly as it is — permitted edges only, current
behavior, zero regression, same as Option B. But don't send prohibitions
to a separate screen either. `WorkflowGraph.tsx` already has an
`aside` side panel wired up for edge inspection; extend the *same panel*
so that clicking (or hovering) a **domain node** — not an edge — shows a
compact list: "N things this domain must not depend on," each entry
linking the relevant prohibition's `rawText`.

This is genuinely different from both A and B, not a relabeling of one
of them: it takes Option B's placement (a list, not a drawn edge — so
none of Option A's "always the complete graph" readability problem) and
gives it Option A's locality (reachable from the graph itself, one click
away, not a separate destination in the app — so none of Option B's
"you have to go somewhere else" cost). The mechanism is cheap because the
infrastructure already exists: the side panel, `DOMAIN_LABEL`, and the
existing pattern of "select something, show its detail" are all already
built for edges and only need extending to nodes.

The real cost is that it's a compromise, not a resolution: prohibitions
still don't appear as first-class graph elements, so anyone who expects
"the graph" to mean "every relationship, drawn" (the literal reading of
`compileDomainConstraints`'s own closed-world claim) still won't find
that here. It reads as a genuine option, not a way to avoid the decision.

---

## Which option serves the verification display

Worth separating two different questions here, because conflating them
overstates the case for Option A:

**Does violation-attachment technically require a graph edge to exist?**
No. Every prohibition already carries its own stable, content-derived
`id` (`compiledConstraintId` in `compile-constraints.ts`) independent of
whether it is ever drawn. The verification engine can reference a
`Constraint.id` directly regardless of visualization — this repo already
has exactly this convention working elsewhere: `check_import`
(`docs/MCP.md`) answers `forbidden | allowed | cannot-determine` for a
hypothetical import, carrying the forbidding sentence and its location,
with no dependency on any graph having drawn that edge first. Attaching
a violation to a prohibition is already solved at the data layer under
any of A/B/C.

**Where does a user go to *see* a violation in context, once one exists?**
This is where the options actually diverge, and it's the real argument
for keeping prohibitions reachable from the graph (A or C) rather than
fully separate (B). A violation is inherently a claim *about a
relationship between two domains* — that is exactly what the graph
already visualizes spatially for permissions. If prohibitions have no
presence in the graph at all, a violation surfaces as text in a list,
divorced from the one view that already shows "how do these domains
relate." A or C let a violation be shown *in place* — the same node or
edge a user would naturally click to ask "does security depend on
backend?" is where the answer, forbidden-and-violated, already lives.
Option B does not preclude building this later, but it means the
verification display would have to reconstruct that spatial context on
its own rather than reuse the graph's.

---

## The HTTP API note, made explicit as asked

No `server/` JSON API endpoint for this exists yet — `compileDomainConstraints`
has no production call site at all today (confirmed: only its own test file
and a throwaway diagnostic script call it). That means **this decision is
still cheap to make now and expensive to make later.** Whatever shape
crosses the API boundary (`ui/` never imports `src/` directly per rule 4;
this data has to cross as JSON) fixes the contract every future consumer
depends on — the UI today, and potentially the CLI's JSON output or the
MCP surface later, both of which already have their own conventions to
stay consistent with (`check_import`'s three-verdict shape is the closest
existing precedent).

Concretely, the endpoint shape is decided by which option is chosen:

- **Option A** → the endpoint returns something close to
  `compileDomainConstraints`'s own shape almost as-is: all 12 records,
  tagged permission-or-prohibition.
  **Option B** → the endpoint returns only permitted edges — today's
  `deriveEdges()`-equivalent shape, permission-only, and prohibitions
  either never leave the server or ship via a *separate* endpoint later.
  **Option C** → the endpoint returns permitted edges (as B) plus a
  prohibitions list keyed by domain, shaped for "what does domain X not
  depend on," not by edge.

Changing this after the endpoint ships is a breaking API change, not a
UI refactor — every consumer would need to change with it. Deciding now,
before any consumer exists, is strictly cheaper than deciding after.

---

## Recommendation

**Option C**, with the option to grow into Option A's on-demand-reveal
variant later if real usage shows people want prohibitions drawn, not
just listed.

Reasoning: Option A's core problem is real and not fixable by more
effort alone — a 4-domain closed-world graph is *always* the complete
directed graph, so drawing all of it, even beautifully de-emphasized,
means the graph's shape stops carrying the "what does this project
actually depend on" information it carries today. That's the thing this
tool is *for*. Option B is the cheapest and safest, but concedes the
exact thing the compiler was built to make explicit — "absence is the
point" (the compiler's own module docstring) becomes invisible again the
moment absence has no representation anywhere near the graph. Option C
keeps the graph's shape meaningful (only real dependencies drawn, same
as today), while making the closed-world claim reachable from the same
screen a user is already looking at — which is also the design that
costs the least to extend toward the verification display later, since
"click a node, see what it's forbidden from" is the same interaction a
violation would use to say "click a node, see what it's forbidden from
*and is currently doing anyway*."

**This is stated as a recommendation, not a decision.** You asked for
this explicitly, and it matters here specifically: this ADR intentionally
does not pick a side in the document's own body, and this closing
paragraph is opinion, clearly separated from the neutral options above
it. The actual decision — A, B, C, or something else — is yours to make.
No code has been written or changed for any option; this document exists
so that choice can be made deliberately, before the HTTP API that will
have to live with it gets built.
