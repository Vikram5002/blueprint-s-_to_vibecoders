# Versioning and drift

Week 9 adds time. Weeks 3–8 describe a repository at one moment; this describes
how it moved.

Three pieces: a **snapshot** per commit, a **semantic diff** between two
snapshots, and a **drift score** charted across history.

**Scope:** no MCP server, no static export — those are Week 11. The timeline UI
is functional rather than polished; full time-travel replay is a later item.

---

## Before building any of it: the Week 5 warning

Week 5 measured cluster stability specifically so this week would not be built
on churning clusters, and flagged that this repository's ARI against `HEAD~20`
was 0.779 — the weakest number it recorded.

Re-measured at 62 commits, **before** the diff was written.

| Compared with | Shared files | ARI |
|---|---|---|
| `HEAD~1` | 186 | 1.000 |
| `HEAD~5` | 179 | 0.909 |
| `HEAD~20` | 163 | **0.824** (was 0.779) |
| `HEAD~30` | 135 | 0.586 |

`HEAD~20` improved as the repository settled. The long distances look alarming
until you notice the window: `HEAD~30` covers growth from 135 files to 186.

But comparing against HEAD is the wrong measurement for this week. A drift
chart walks history one commit at a time, so what matters is whether
*consecutive* commits agree. Over the last 25 commits:

```
  mean ARI              1.000
  identical (ARI=1)     25/25  (100%)
  weak    (ARI<0.8)     0/25
```

**Every adjacent pair produced an identical clustering.** Not similar —
identical, ARI and Jaccard both exactly 1.000, across commits that added 33
files and moved the module count between 24 and 26.

### The design constraint that follows

The chart is assembled from **consecutive steps**, never by comparing each
commit against HEAD. The same history is perfectly stable step by step and
looks chaotic end to end, because thirty commits of legitimate growth
accumulate. Comparing against HEAD would attribute all of it to whichever
commit sits at the far end.

**False-restructure rate on this history: 0/25.** Every regrouping an adjacent
diff reports is real.

`scripts/adjacent-stability.mjs` re-runs this on any repository.

---

## Snapshots

One per commit: modules and their membership, edges, constraints, violations,
active corrections, and the drift score.

**A snapshot has no timestamp of when it was taken, no run id, and no random
component.** Its id is a hash of its content. Everything else this week rests
on that: a diff is only meaningful if neither side moves on its own, and a flat
chart has to mean *nothing changed* rather than *nothing changed much*. The
only time recorded is the commit's own author date.

Stored in SQLite at schema v2, keyed on commit sha rather than snapshot id —
one snapshot per commit is the invariant the diff relies on, and keying on
content would let a single commit accumulate rows as the analyser changed,
charting the same point in history twice.

### Active corrections, as Week 6 specified

Confirmed rather than assumed, as the brief asked. Week 6's `run_outcomes`
table does record which corrections were in force per run, and snapshots now
record the same set.

This matters because **two snapshots taken under different corrections are not
comparable**. A module that appears to have changed between them may only have
been renamed by hand in between. Rather than filter those out — which would
hide a real difference — the diff carries a `comparable` flag and says which
way to read it.

### History walking

Each commit is materialised in a throwaway `git worktree`. Never a checkout
into the user's tree: that would destroy uncommitted work, and a tool that
reads a repository has no business moving its HEAD.

Labelling is mechanical throughout and intent extraction is skipped. Both need
a model, so both would be a network call per commit — slow, quota-bound, and
worse, they would make a snapshot's identity depend on what a model happened to
say that day. Names are cosmetic; membership is what a diff compares.

Constraints are therefore held constant across the window: **the chart shows the
code moving against a fixed set of rules, not the rules moving too.**

---

## Semantic diff

Architecture, not text. A commit that reformats every file produces an empty
diff; a commit that moves one import produces one entry.

| Kind | Meaning |
|---|---|
| `module-added` / `module-removed` | A module appeared or vanished entirely |
| `module-renamed` | Same module, different id or label — with the files that moved |
| `module-restructured` | The module no longer exists as a unit |
| `edge-added` / `edge-removed` | An import appeared or disappeared |
| `edge-weight-changed` | Same dependency, different number of import statements |
| `constraint-added` / `constraint-removed` | A stated rule appeared or disappeared |
| `violation-appeared` / `violation-resolved` | A rule broke, or was fixed |

Every entry carries a plain-language description and its evidence.

### Rename versus restructure: the threshold

**0.6 Jaccard overlap on file membership.**

The threshold has to exist. Cluster ids are content-derived, so adding one file
changes a module's id — without an overlap test, every commit touching a module
would read as "module deleted, different module created", and a diff would be
almost entirely phantom churn.

0.6 is the same number Week 6 uses for correction matching, because it is the
same question: *is this still the thing I was looking at?* A module can grow by
two thirds or lose 40% of its files and still be recognisably itself. Reusing
one value across the project means a user learns one rule.

**The exact value matters less than it looks here.** Adjacent commits produce
identical clusterings, so overlaps land at 1.0 or near 0 and almost nothing sits
near the boundary. The threshold is a safeguard for the rare genuine reshuffle,
not a dial deciding most outcomes.

It is not idle, though. This repository's own history contains a real borderline
case at **57%** — a module that genuinely stopped being one unit, correctly
reported as `module-restructured` rather than as a rename.

Pairing is greedy on best overlap rather than optimal assignment. With the
measured stability the two agree in every real case, and greedy is inspectable
where the Hungarian algorithm is not.

---

## Drift score

Implemented exactly as specified in `docs/ARCHITECTURE.md` — it was specified
there but had never been built:

```
driftScore = (weightedViolations / totalConstraints) * 100
weights: high 3, medium 2, low 1
```

**Deliberately not improved.** The point of the number is that a reader can
recompute it in their head from the violation counts, and every refinement that
made it more accurate would make it less checkable.

Two decisions worth stating:

- **The denominator is total constraints, not checked ones.** Dividing by the
  checked subset would let unevaluable rules quietly flatter the score — the
  same trap Week 8 avoided by counting `unchecked` separately from `satisfied`.
- **Zero constraints reports as "not measured", never as "perfect".** A
  repository that stated no rules has nothing to drift from, and a 0 that means
  "clean" and a 0 that means "unmeasured" must not look alike.

### Every point explains itself

Week 5's standard for the clustering metrics, applied to a time series: a number
nobody can interrogate is a number nobody should trust. Each point carries the
diff entries that moved it.

The chart also explains a **flat** line, which is the case that otherwise looks
like a bug. On this repository, 11 of 19 steps changed the architecture without
moving drift at all — because drift moves only when a stated rule breaks or is
fixed, and structural change with no rule broken is correctly scored as no
drift.

---

## Two bugs the real data exposed

Both were found by looking at output, not by tests passing.

### Edge identity — 700 phantom changes per commit

The first drift chart reported **640 to 756 changes per adjacent commit** on a
repository with about 500 edges. Essentially every edge read as removed and
re-added.

`build-graph` uses graphology's `addDirectedEdge`, which mints internal keys
numbered by insertion order (`_geid_412_0`). Inserting one edge renumbers every
edge after it, so across two commits almost nothing keeps its key.

Edge ids are now derived from source and target via the `encodeEdgeId` the rest
of the project already used. **The same fix repaired a second bug nobody had
hit**: the Week 8 violation overlay is keyed by edge id and the graph API emits
`encodeEdgeId` ids, so keyed on graphology's numbering it could never have
matched a single edge the UI knew about.

After the fix, adjacent diffs check out against `git log`: docs-only commits
report zero architectural change, and this repository's `c93a763` reports 18
entries matching exactly the imports in the four files it added.

### Module names that could not be told apart

Mechanical labels are the common path prefix, so a repository whose modules all
sit under `src/` produces several modules all labelled `src/`. The first diff
run said:

> Module "src/" no longer exists as a unit. Its closest survivor, "src/", shares
> only 57% of its files.

True, and useless. Modules are now qualified with the directories they occupy,
and only when that disambiguates.

---

## Verification

### Snapshot determinism

Same commit twice, byte-identical, on all three reference repositories:

| Repo | Result |
|---|---|
| requests | **PASS** |
| zod | **PASS** |
| pyright | **PASS** |

### Real adjacent commits, checked against git log

| Repo | Commit | Files touched | Entries | Verdict |
|---|---|---|---|---|
| requests | `1f6589e` bump pre-commit | `.pre-commit-config.yaml` only | 0 | correct — no code |
| zod | `912f0f5` add MCP config | `.mcp.json` only | 0 | correct — no code |
| pyright | `dde0aae` stubPath special-casing | 1 `.ts` file | 0 | **correct** — inspected by hand: the commit changed string literals and variable names inside a function, and touched no import |

That pyright row is the one worth dwelling on. A text diff shows four changed
lines; the architectural diff correctly shows nothing, because nothing about the
dependency structure moved. That is the distinction the whole week is built on.

### A commit that did change the architecture

Chosen because its message describes one: zod's
`fix(v4): break circular import between classic schemas and iso (#5275)`.

```
fbe8ad1 -> dfd8766   8 entries
  [edge-removed]        packages/zod/src/v4/classic/schemas.ts no longer imports
                        packages/zod/src/v4/classic/iso.ts.
  [edge-weight-changed] packages/zod/src/v4/classic/iso.ts imports schemas.ts through
                        2 statement(s), more than the 1 before.
```

The tool independently reports the cycle being broken in one direction and the
surviving dependency strengthening in the other — which is exactly what that
refactor looks like, described by a maintainer who had never heard of this tool.
This is the strongest evidence in the week, because the ground truth was written
by someone with no stake in the result.

### Drift chart across 20 commits

Charted on this repository. Score flat at 0.0 throughout: all three of its
stated constraints hold at every commit in the window, so there is no drift to
report — the correct answer, and the reason the chart explains flatness
explicitly.

Of 19 steps, 11 changed the architecture and 8 did not. The 8 are docs-only
commits, verifiable from their subjects.

---

## Deferred items

Recorded, not acted on. Both are small; both are worth doing properly rather
than in passing.

### 1. Preserve the zod circular-import diff as a first-class validation case

The strongest evidence this project has produced is the diff of zod's
`fix(v4): break circular import between classic schemas and iso (#5275)`:

```
fbe8ad1 -> dfd8766   8 entries
  [edge-removed]        packages/zod/src/v4/classic/schemas.ts no longer imports
                        packages/zod/src/v4/classic/iso.ts.
  [edge-weight-changed] packages/zod/src/v4/classic/iso.ts imports schemas.ts through
                        2 statement(s), more than the 1 before.
```

It is currently written up inside the verification section of this document,
which undersells it. It deserves its own place, kept **separate from the
synthetic violation tests**, because it is a different *kind* of evidence:

- The synthetic tests prove the mechanics — inject a known edge, see it
  detected. They are constructed by the same person who wrote the detector, so
  they can only ever confirm that the code does what its author intended.
- This one is ground truth written by a zod maintainer who had never heard of
  this tool, in a commit message describing the change in their own words. The
  tool independently reported the cycle broken in one direction and the
  surviving dependency strengthening in the other.

**To do:** capture the terminal output verbatim (and the timeline UI showing the
same diff), and give it a named section — "Real-world validation" — that a
reader can find without reading the whole document. Pin the commit shas so the
case can be re-run.

### 2. A fixture test for the 57% borderline restructure

`RENAME_OVERLAP_THRESHOLD` is 0.6, and this repository's own history contains
the only genuine boundary case observed anywhere: a module that scored **57%**
overlap and was correctly reported as `module-restructured` rather than as a
rename.

That matters because adjacent clusterings are otherwise identical — overlaps
land at 1.0 or near 0, so **the threshold is almost never exercised in the range
where it actually decides something**. Unit tests cover the boundary with
hand-built module sets, which is worth having but is again the author checking
their own arithmetic.

**To do:** freeze that commit pair's two snapshots as a fixture and assert the
57% case classifies as a restructure. Cheap, and it converts the one real
boundary observation into a regression test before the history grows past it.

Neither blocks Week 10.

---

## Where to see it

```bash
vibe-blueprint . --history=20     # build snapshots and print the chart
```

Opt-in because it costs a worktree and a full re-analysis per commit. Snapshots
persist, so a later run reuses them.

- **CLI** — a sparkline with the cause of every movement.
- **`GET /api/drift-history`** — the chart data.
- **`GET /api/diff?from=<commit>&to=<commit>`** — any two recorded snapshots.
  Short shas accepted; an ambiguous prefix is rejected rather than resolved to
  the first match.
- **UI** — a timeline panel; click a commit for its diff.

Both routes read what the CLI recorded and never compute snapshots on demand. A
handler that spawned a worktree and re-analysed a repository would take ninety
seconds and be called twice concurrently by a page refresh. When nothing has
been recorded they say so, with the command to fix it, rather than returning an
empty success that looks like a clean history.
