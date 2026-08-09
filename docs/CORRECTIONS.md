# User corrections

The clustering is an opinion. It is a defensible opinion drawn from real import
edges, but it is still an opinion, and on any real repository some of it will be
wrong. The design bet stated in CLAUDE.md is that a wrong-but-close diagram the
user can argue with beats a blank canvas — which only pays off if arguing with it
is cheap and if the argument survives to the next run.

A correction is a user's disagreement with the grouping or the naming. Three
kinds:

| Kind | What it says |
|---|---|
| `rename` | This module is real, but that is not what it is called. |
| `merge` | These modules are one thing. |
| `split` | This module is two things, and here is which files go where. |

Corrections outrank both the algorithm and the model. They are applied after
clustering and before cluster ids are assigned, so the ids stay derived from the
corrected content rather than from the algorithm's first guess.

---

## The hard problem: what does a correction attach to?

A correction is made against a module that existed on Monday. It has to be
reapplied on Friday, against a repository that has changed. So the correction
needs a key — something that survives a re-run and still identifies "that
module".

Every available key is wrong in a different way:

**Cluster id.** Ids are content-derived: they are a hash of the module's
membership, which is exactly what makes them stable and reproducible. It is also
what makes them useless here — adding one file changes the id, so every
correction is orphaned by the next commit. Rejected.

**Module label.** Names are not unique, and the label is frequently the thing
being corrected. A rename would immediately break its own key. Rejected.

**A rule the user writes** ("everything under `src/auth/`"). Re-evaluable, and
never ambiguous. But it makes the user write a query language to rename a box,
which defeats the point, and rules go stale silently — a rule matching nothing
looks the same as a rule that is satisfied. Rejected.

**The member set.** What the user was actually looking at when they decided. Not
exact — membership changes — so it needs a similarity measure rather than an
equality test. This is what is implemented.

### The trade-off being accepted

Matching on membership means a correction is anchored to a snapshot, so it
degrades as the repository moves. That is a real cost, and it is the right one to
pay, because the alternative failure is worse: an exact key silently drops
corrections, and a rule silently applies them to the wrong thing. Membership
matching fails *loudly*, and every failure mode has a name the user can see.

Similarity is Jaccard overlap — shared members over combined members — reusing
`jaccardSets` from the Week 5 stability machinery. Same statistic already used to
measure whether clustering is stable between commits, so the number reads against
a scale the project already reports.

### Matching against the union, not the best module

A stored member set is compared against **every module that currently holds at
least one of its members, taken together** — not against whichever single module
matches best.

This matters for `merge`. A merge exists precisely to span several modules. If it
were matched against one best module, all the members living in the others would
be reported as having *left*, and a correction working exactly as intended would
report drift on every run. Taking the union makes one rule correct for all three
kinds.

Ties break on module id, so the result does not depend on iteration order.

---

## The three outcomes

Every correction reports one of these on every run. There is no fourth state and
no silent path.

### `applied`

Overlap is at or above the threshold and membership is unchanged. The correction
is reapplied exactly.

### `applied-with-drift`

Overlap is at or above the threshold, but membership has moved. The correction
**is** reapplied — the user's judgement still holds for a module that gained or
lost a few files — and the outcome names every file that joined and every file
that left.

Naming them, rather than counting them, is the point. "3 files changed" tells the
user nothing they can act on; `packages/treeshake/example.ts` tells them whether
the correction still means what they meant.

### `orphaned`

Overlap is below the threshold. Nothing that currently exists sufficiently
resembles what the user corrected, so the correction is **not** reapplied. The
module keeps its mechanical name and the correction is surfaced for review.

Not reapplying is the whole design. Guessing here would put a user's name on a
module they never saw, which is worse than showing them a derived name — a wrong
name that claims to be theirs is a lie about provenance, and rule 2 exists to
prevent exactly that.

An orphaned correction is never deleted. It is kept and shown, because the user
may want to remake it, and because deleting someone's work on the grounds that
the code moved is not the tool's decision.

---

## The threshold: 0.6

A module can grow by roughly two-thirds, or lose roughly 40% of its files, and
still be recognised as the same module.

**Why not higher.** At 0.8 a module that absorbs a new subdirectory — an ordinary
refactor — orphans its correction. Users would lose work for doing normal things.

**Why not lower.** At 0.3 two modules that merely share a utility file start to
look like each other, and the correction lands on something the user did not
mean. Below about 0.5, "resembles" stops being a fair description.

**Why the exact value matters less than it appears.** The threshold does not
decide whether the user is told. It decides which of two *loud* outcomes they
get. Above it, `applied-with-drift` names every file that moved; below it,
`orphaned` says so outright. There is no setting at which a correction is quietly
misapplied, which is what makes 0.6 a comfortable choice rather than a critical
one.

Override per call via `DEFAULT_MATCH_THRESHOLD` in `src/graph/corrections.ts`.

### Where it is weakest: small modules

Jaccard is coarse on small sets. A 3-file module that gains one file scores 0.75;
gaining two scores 0.6 and sits exactly on the boundary. So small modules orphan
faster than large ones for the same absolute change.

This is a known limitation and is not currently corrected for. A size-aware
threshold was considered and rejected for now: it makes the reported number
harder to interpret ("60%, but for this module the bar was 45%") in exchange for
better behaviour on the modules where a correction is cheapest to remake anyway.

### Second-order movement is normal

Measured on zod: deleting 27 of a module's 81 files produced an overlap of 0.551,
not the 0.667 the deletion alone implies. Removing files re-routes the imports of
the files that remain, so a module loses members it never lost directly.

Clustering moves more than the diff does. This is the strongest argument for
reporting drift by name rather than trusting the ratio to be intuitive — the
ratio is not intuitive, even when you know what was deleted.

---

## Split needs care

A split stores an **explicit file list for each side**. Not a rule, not a
predicate — the actual paths the user ticked.

The consequence is deliberate. When the module later contains a file that is on
neither list, there is no correct answer: the user never expressed an opinion
about it, because it did not exist when they decided.

That file is **assigned nowhere** and reported as an `unresolved` split
assignment. It is not guessed at, not put with the majority, and not silently
placed on the first side.

This is the one place where storing a rule would genuinely have been more capable
— a rule would classify the new file. It would also be wrong without saying so.
An unresolved assignment is a question the tool asks the user; a rule is an
answer the tool invents. Given that the entire product is a claim about knowing
the difference between derived and stated, inventing here would be
self-defeating.

The UI says this on the split form, before the user saves, so the behaviour is
not a surprise discovered three commits later.

---

## Determinism

Corrections are part of the deterministic half of the pipeline. With the same
repository and the same corrections, output is byte-identical:

- Corrections are applied in a fixed order, sorted by correction id.
- Correction ids are a hash of kind plus sorted members, so the same correction
  made twice has the same id, and the order the user made them in does not
  matter.
- Member lists are sorted on save.
- Ties in matching break on module id.

Covered by `determinism with corrections` in `src/graph/cluster-corrections.test.ts`.

---

## Run provenance

Each run records which corrections were active and what happened to each, in the
`runs` and `run_outcomes` tables.

This is for Week 9. A snapshot diff that ignored corrections would report the
user's own rename as an architectural change. Knowing which corrections were in
force when each snapshot was taken is what lets two snapshots be compared like
with like.

---

## Acceptance

Demonstrated end to end on a real repository (zod, 406 files, 19 modules) by
correcting three modules, deleting real files from two of them, and re-running
the full pipeline:

```
[applied]             "Kept Intact"              overlap 1.000
[applied-with-drift]  "Loses A Few Files"        overlap 0.840   13 files left, named
[orphaned]            "Loses Almost Everything"  overlap 0.179   not reapplied
```

The orphan's label was confirmed absent from the run's user-labelled modules, and
both runs were recorded in the store.
