# Module clustering

Week 5. Directory prior plus Louvain community detection over the import graph.

Everything here is deterministic and mechanical. No LLM is involved: `graph/` may not
import `llm/`, and module labels are a path prefix or an index. Semantic naming is Week 6.

---

## This week has no ground truth

Weeks 1–4 were objectively checkable — the resolution rate was either 99.6% or it wasn't.
"Is this a good module grouping?" has no correct answer to measure against, so correctness
here means three properties that *can* be tested, not accuracy.

### 1. Determinism

Louvain as normally run is not deterministic. It consults a random source, and it can visit
nodes in random order, so the same repository yields different communities on every run.

Three things pin it down:

- a seeded mulberry32 PRNG (`src/graph/rng.ts`), replacing `Math.random`
- `randomWalk: false`, removing randomised traversal
- **canonicalisation** — cluster ids are derived from content, ordering clusters by their
  lexicographically smallest member, rather than from whatever integer the algorithm
  assigned

The first two fix membership. The third fixes the *ids*, which is what any comparison
between two runs actually reads: two runs can agree perfectly on grouping and still number
the communities differently.

**Measured:** the full clustering payload — modules, edges, assignments, merges — hashes
identically across 10 consecutive runs on all three repositories.

| Repo | SHA-256 (first 16) of clustering payload | 10 runs |
|---|---|---|
| requests | `B467494CC89D978B` | identical |
| zod | `8CCE894DBA77C62C` | identical |
| pyright | `F6A07164797740E1` | identical |

A tool that regroups modules on refresh is as untrustworthy as one that invents edges.

### 2. Stability across commits

Week 9 computes drift by diffing architecture between commits. If clusters churn on their
own, every diff reports change that never happened and the drift score becomes noise.

`scripts/cluster-stability.mjs` checks each commit out into a throwaway git worktree, runs
the full pipeline, and compares clusterings by **Adjusted Rand Index** — corrected for
chance, and invariant to how clusters are labelled — with Jaccard overlap alongside, because
"clusters kept 94% of their members" is directly interpretable where ARI is a statistic.

Only files present in both commits are compared. A file that was added or deleted cannot
agree or disagree about where it belongs, and counting it would report churn that is not
regrouping.

**Measured (ARI):**

| Repo | HEAD~1 | HEAD~5 | HEAD~20 |
|---|---|---|---|
| requests | 1.000 | 1.000 | 0.904 |
| zod | 1.000 | 1.000 | 1.000 |
| pyright | 1.000 | 1.000 | 0.992 |
| this repo | 1.000 | 1.000 | 0.779 |

Adjacent commits are identical everywhere. Twenty commits back, the repositories that
actually changed shape in that window move a little — the clustering tracking real change
rather than drifting. This repo moves most because 20 commits ago it was 73 files rather
than 118.

### 3. Explainability

Every file records which step placed it and a plain-language reason, reachable in the UI and
at `GET /api/module/<id>`. Explanations **compose** rather than overwrite: a file that had no
coupling and was then merged carries both halves, because that is the honest answer to "why
is this file here?".

---

## How the directory prior and coupling are combined

They conflict, and the rule for resolving it is explicit. The filesystem does not silently
win.

1. **Coupling decides.** Louvain runs on the weighted import graph and its answer stands
   wherever there is coupling to reason about.
2. **Where there is no coupling at all** — a file with no imports in either direction — there
   is no signal to overrule, so the directory groups it. Left alone, Louvain makes each such
   file its own singleton module, which is noise rather than architecture.
3. **Clusters below the size threshold** merge into whichever neighbour they are most
   strongly coupled to. If a small cluster has no coupling to anything, it falls back to its
   directory; if it has neither, it is left alone rather than given an invented home.

Each step is recorded per file as `import-coupling`, `directory-prior` or
`small-cluster-merge`.

---

## Parameters

| Parameter | Default | Why |
|---|---|---|
| `resolution` | `1` | The textbook Newman value. Higher splits into more, smaller communities. **Deliberately not tuned** — see below. |
| `minClusterSize` | `3` | Below this a "module" is not a useful unit of architecture. Configurable. |
| `seed` | `0x5eed1e55` | Any fixed value works; what matters is that it is fixed. |

### Why the resolution default is not tuned

Modularity is reported as a **diagnostic, not a quality claim**, and the default is left at
the textbook value on purpose.

With no ground truth, tuning the resolution until modularity looked good would be optimising
the measurement rather than the grouping. A higher modularity score does not mean better
modules; it means the partition divides the graph more sharply, which a sufficiently
aggressive resolution will always achieve. The number is printed so a reader can see how
sharply this particular graph divides — pyright's 0.376 says its subsystems are far more
entangled than zod's 0.697 — and for nothing else.

---

## Disagreement between coupling and folders

This is the most interesting output, not an error to smooth over.

| Repo | Files | Modules | Modularity | Disagreement | Modules spanning folders | Folders split across modules |
|---|---|---|---|---|---|---|
| requests | 37 | 6 | 0.214 | 29.7% | 4 | 2 |
| zod | 406 | 19 | 0.697 | 30.3% | 11 | 14 |
| pyright | 1,917 | 46 | 0.376 | 9.8% | 10 | 14 |

A file "disagrees" when the module it lands in is mostly made of some other directory.

### pyright, inspected against its documented package structure

pyright documents three packages: `pyright` (a thin CLI wrapper), `pyright-internal` (the
implementation), and `vscode-pyright` (the extension). Within `pyright-internal/src` it
separates `analyzer`, `parser`, `common`, `languageService`, `commands`, `typeServer` and
`tests`.

What the clustering agrees with:

- **`packages/pyright` is cleanly its own module** (3 files, 1 directory) — the CLI wrapper
  really is separable, as documented.
- **The analyzer holds together.** module-003 is 73 files, 50 of them `src/analyzer`.
- **Test fixture data separates completely.** `tests/samples` (1,274 files) and
  `tests/fourslash` (263) are each a single module, because they are Python and fourslash
  fixtures with no imports at all — placed by the directory prior, not by coupling.

Where coupling disagrees with the folder layout:

- **`common/` is a gravity well.** The disagreement is dominated by one pattern: 29 files
  from `analyzer`, 28 from `tests`, 18 from `languageService`, 13 from `src`, 6 from
  `commands` and 6 from `parser` are all pulled into the module centred on
  `common`. Every subsystem couples to the shared utility layer more strongly than to its
  own siblings. The folder tree presents `common` as one peer among seven; the import graph
  says it is the hub the rest hangs from.
- **Tests belong to what they test.** The folder layout puts every test under `src/tests`;
  coupling redistributes them to the subsystem they exercise — 8 to `analyzer`, 28 to
  `common`, and `tests/typeServer` lands with `typeServer` itself.
- **`typeServer` is a real subsystem and the layout nearly says so.** module-006 gathers
  `typeServer` (20 files), `typeServer/protocol` (3) and `tests/typeServer` (3) into one
  unit — implementation, wire protocol and tests together.

None of this says pyright is organised wrongly. It says the file tree and the import graph
are answering different questions, and the second one is not visible from the first.

---

## Known limitations

- **A single-directory module of 1,274 files is a "module" only in the trivial sense.**
  pyright's `tests/samples` has no imports at all, so there is no coupling to cluster by and
  the directory prior groups it wholesale. That is the honest answer, but it is not
  architecture.
- **Small-cluster merging cascades on tiny repositories.** On a 7-file fixture where every
  cluster is below the threshold, everything collapses into one module. Correct, but not
  useful; the threshold assumes a repository large enough to have modules.
- **Modularity is not comparable across repositories** except very loosely. It depends on
  graph size and density as well as on how cleanly the code divides.
