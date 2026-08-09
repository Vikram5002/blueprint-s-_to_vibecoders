# Violation detection

Week 8 is where the two halves of the data model meet for the first time. Weeks
3–5 derived a graph from real import statements; Week 7 extracted constraints
from prose. This compares them.

A violation is **not a third kind of truth**. It is a comparison, and it records
both sides separately so a reader can disagree with either. Nothing here asserts
that the code is wrong — it asserts that the code and the documentation
disagree, and shows the sentence and the import line that disagree. Which of the
two should change is the developer's call, and often the answer is the document.

**Scope:** detection only. No drift, no snapshots, no history — that is Week 9.

---

## The four checks

| Constraint | Violated by |
|---|---|
| `must-not-import(A, B)` | any edge A → B |
| `may-only-import-via(A, B, C)` | any **direct** edge A → B |
| `must-not-cycle(A)` | any dependency cycle touching A |
| `must-be-layer-above(A, B)` | any edge **B → A** |

### The layer direction

`must-be-layer-above(A, B)` means A sits *above* B, so A may depend on B and B
may not depend on A. The violation is the **upward** edge.

Getting this backwards would flag every correctly layered design in existence —
a systematic, confident false positive across every repository that does the
right thing. It has a test in both directions for that reason.

### `may-only-import-via` — the rule, decided

**A violation is any direct file edge from A to B. Nothing else.**

The obvious follow-up question is whether C should also be checked — if A may
only reach B through C, does C itself need validating? The answer here is no,
deliberately:

1. **Whether C misbehaves is a different sentence's job.** If the documentation
   cares that C must not reach B, it says so, and that becomes its own
   constraint with its own confidence and its own evidence. Folding the check in
   here would produce one finding assembled from two rules, and a user could not
   tell which sentence to argue with.
2. **A → C → B is the routing working.** That is precisely what the constraint
   asked for. Reporting a transitive reach through the permitted route would
   flag the intended design as a breach.
3. **Transitive reachability is nearly always true and says almost nothing.** In
   a repository the size of pyright, most modules reach most other modules
   through some chain. A check that fires on "A can eventually reach B somehow"
   fires constantly, and a finding that is always true carries no information.

**The cost of that choice, stated plainly:** this will not catch a laundering
module that exists only to relay A's imports to B while technically satisfying
the letter of the rule. Catching that requires a rule *about C*, and the honest
place for it is a constraint about C — not a cleverer reading of this one.

Files that are themselves part of C are never blamed for reaching B.

### Cycles

Detected at **module** level, which is the level the constraint is written at. A
sentence saying "the domain must not cycle" is about the domain as a unit, not
about two files inside it importing each other.

Uses **iterative Tarjan**, for two reasons. Every cycle lies inside exactly one
strongly connected component, so one linear pass finds them all and a
three-module tangle is reported once rather than once per traceable loop.
Iterative rather than recursive because a 1,900-file repository produces chains
deep enough to blow the call stack, and a conformance check that crashes on
large inputs is worse than one that reports nothing.

---

## Severity, in one sentence

> **Severity is how much we trust the rule, multiplied by how much we trust the
> evidence, scaled by how entrenched the breach is.**

```
score = constraintConfidence × edgeTrust × entrenchment
```

Every term is in 0–1 and already computed elsewhere for its own reasons.
**High ≥ 0.7, medium ≥ 0.4, low below.**

| Term | Source | What it means |
|---|---|---|
| `constraintConfidence` | Week 7 | Where the rule was written, how it was phrased, whether its subjects resolved. AGENTS.md saying "must never" ≈ 1; a README saying "we prefer" is low. |
| `edgeTrust` | Week 3 | Local import resolution rate over the files implicated. A corner of the graph we only partly read supports a weaker claim. |
| `entrenchment` | Week 2–3 | Import count, saturating. 1 import → 0.70, 3 → 0.80, 9 → 0.90, 27 → 0.96. |

### Why multiplied, not summed

Because any one term being near zero should sink the whole finding, and a
weighted sum cannot express that. A rule the extractor was unsure of, broken by
edges we resolved badly, is not a medium-severity issue merely because it
happens to occur in fifty places — it is a guess about a guess. Multiplication
makes each factor a veto; addition lets a strong term carry a weak one.

### Why entrenchment has a floor

It is bounded below at 0.6 rather than running to zero. The first version did
run to zero, and scored a single-import breach of a certain rule at 0.25 —
filed as *low*. That is backwards: a breach is a breach at one import, and a
single import through a forbidden boundary is exactly the finding a developer
wants surfaced while it is still one line to delete. Entrenchment adjusts
severity within a band; it does not decide whether something counts.

### What is deliberately excluded

Nothing about how large or central a module is — not file count, not fan-in, not
centrality. Those measure blast radius; severity here measures confidence in a
claim. Mixing them would make big modules emit high-severity findings by
default, which is how a conformance report becomes noise nobody reads.

An edge that is not `DERIVED` scores **exactly zero**, not "low". That is not a
weak finding, it is a finding that must not exist, and a score rounding to low
would let it appear in a report as a minor issue.

---

## Checked, satisfied, unchecked

Three outcomes, reported separately, for the same reason Week 7 separates
extraction from resolution:

- **satisfied** — evaluated against the graph, and it holds.
- **violated** — evaluated, and broken.
- **unchecked** — could not be evaluated: `unresolved-role` (a subject matched
  nothing in this repository) or `empty-target` (it matched something holding no
  analysed files).

A constraint that could not be checked reads exactly like one that passed if you
only count violations. Reporting them together would let a repository look
conformant *because* its rules were unevaluable, which is the most flattering
possible way to be wrong.

**Low confidence is not a reason to skip a constraint.** A shaky rule is still
evaluated and its doubt is carried by the severity score. Skipping it would hide
a real disagreement behind a threshold, and the point of having a formula is
that it can say "this might not matter" without discarding the finding.

---

## Rule 3, one level up

Every violation carries the evidence from every edge that breaks it — file, line
and the actual import statement — copied from the graph rather than referenced.

A violation a user cannot trace to a file and a line is an accusation without a
source, which is precisely what this project exists not to produce. The CLI
prints the rule's own text and location alongside it, so both halves of the
disagreement are visible together:

```
  [high] parser/ imports llm/ in 1 file(s), across 1 import statement(s).
         The documentation says it must not.
         rule: "`parser/` and `graph/` must NEVER import from `llm/`."
         from: CLAUDE.md:68
         src/parser/parse-repository.ts:1  import { DEFAULT_GEMINI_MODEL } from '../llm/gemini.js';
```

---

## Precision and recall

### Ground truth

The three constraints Week 7 extracted are rules this project holds about
itself, so the answer is checkable by reading the source. Verified by grep over
the real tree — including test files — before the test was written:

- no file under `src/parser` imports `llm/`
- no file under `src/graph` imports `llm/`
- no file under `ui/src` imports `src/`

**Expected violations: zero.** The tool agrees.

That is a real result, not a null one. Agreeing that a conformant repository is
conformant is what over-eager conformance tools get wrong, and it is the
outcome that matters most given the project's own position that a false
violation costs more trust than a missed one.

### Known positives

An all-negative ground truth measures precision and says nothing about recall —
a detector returning `[]` unconditionally would score perfectly. So the second
half of the evaluation injects edges that are violations by construction: real
files, real modules, edges that do not exist in the tree.

Injecting edges rather than editing files keeps the truth exact. There is no
question about what *should* have been detected, because the edge set is written
in the test.

| | |
|---|---|
| **Precision** | **100%** — 2 of 2 predicted were correct |
| **Recall** | **100%** — 2 of 2 injected were found |
| **False positives** | **0**, across 3 known-negative injected edges |

The negatives include the **reverse** edge — `llm/` importing `parser/` — which
no rule forbids. Only the stated direction is a breach, and a detector that
fired on both would be wrong in a way that is easy to miss.

The evaluation also asserts the graph it is checking is real (200+ edges, 5+
modules) before trusting a zero, so a vacuous pass over an empty graph cannot
masquerade as a clean repository.

---

## Measured on all four repositories

| Repo | Constraints | Checked | Satisfied | Unchecked | Violations |
|---|---|---|---|---|---|
| blueprint | 3 | 3 | **3** | 0 | **0** |
| requests | 0 | 0 | 0 | 0 | 0 |
| zod | 0 | 0 | 0 | 0 | 0 |
| pyright | 0 | 0 | 0 | 0 | 0 |

Three of the four have nothing to check, and that is not a failure of this
week's work — it is Week 7's headline finding arriving downstream. Those
repositories state no constraints expressible in the four relations, so there is
nothing for a conformance check to compare against. **A repository with no
violations because it stated no rules is a different result from one with no
violations because it obeys them**, and the report distinguishes them: the
former shows `0 of 0 constraints`, the latter `3 of 3 checked, 3 satisfied`.

It also means violation detection is exercised against real prose on exactly one
repository. The same denominator problem recorded in `INTENT.md` — see the open
item on positive documents — bounds this week too.

### End-to-end demonstration

Detection was verified on a mutated copy of this repository with one deliberate
breach of rule 1 (`src/parser/parse-repository.ts` importing `src/llm/gemini.js`):

```
  Conformance         2 of 3 constraint(s) checked
    not checkable     1
      unresolved-role   1
    satisfied         1
    violated          1

  Violations          1  (1 high, 0 medium, 0 low)  across 1 edge(s)
```

Both interesting paths fire in one run. The injected breach is found and rated
high. The `ui/` constraint is reported as **not checkable** rather than silently
satisfied, because `ui/` was not part of the copied tree — which is exactly the
distinction the unchecked category exists to preserve.

---

## Determinism

Same graph plus same constraints gives byte-identical violations, always:

- Constraints are sorted by id before evaluation; violations sorted by id after.
- Edges within a violation are sorted by edge id.
- Tarjan sorts both its node list and each successor list, so components — and
  the violation ids derived from them — do not depend on map iteration order.
- Severity scores are rounded to fixed precision, so floating-point drift cannot
  change a band across platforms.
- Violation ids are a hash of the constraint id, the kind and the sorted edge
  ids.

Asserted directly: two runs over the same inputs, and one run with constraints
and edges supplied in reverse order, must produce identical JSON.

---

## Where violations appear

- **CLI** — a conformance section that leads with what was checked. Zero
  violations prints as a result, not as absent output.
- **`--json`** — a top-level `conformance` key, never folded into `graph` or
  `clustering`.
- **`/api/graph`** — a `violations` overlay keyed by edge id, carrying severity,
  the explanation, and the rule's text and source.

The overlay is beside the edges, never written onto them. Rule 2: an edge is
DERIVED, a constraint is STATED, and a violation is a comparison of the two.
Putting severity on an edge would make a claim look like a property of the code,
and a client would have no way to tell which of the two it was drawing. A test
asserts the edges stay clean.

The full violation panel is Week 9–10.
