# Labelling

Week 6 is the first time this tool consults a language model. Everything before
it — parsing, resolution, graph construction, clustering — is deterministic, and
stays that way.

The model does exactly one thing: it gives a cluster a better name than
`packages/zod/src/v4/`. It never creates a node, never creates an edge, never
moves a file between modules. Rule 1 in CLAUDE.md is the reason: a single
hallucinated dependency edge destroys trust in every edge the tool ever draws,
and there is no way to earn that back.

---

## Where the boundary is enforced

`parser/` and `graph/` do not import from `llm/`. The composition root is
`src/pipeline/label-repository.ts` — the one file that decides whether a model is
consulted at all. Clustering is finished before it runs, and is passed through
untouched.

Labels live in a side table keyed by module id. `ClusteringResult` is never
mutated. This is what makes the guarantee testable rather than aspirational:

> `labels are cosmetic > produces identical ids, membership and edges either way`

Turning labelling on and off produces byte-identical structure. If that test ever
fails, the boundary has been breached.

---

## Three label sources

Rule 2 applied to names. Every module's label carries where it came from, and the
UI shows all three distinctly.

| Source | Meaning | Badge |
|---|---|---|
| `mechanical` | Derived from the common path prefix. No model involved. | `derived`, solid green |
| `llm` | A model wrote it. It may be wrong. | `~ ai`, dashed amber |
| `user` | A correction. Outranks both. | `✓ yours`, solid blue |

The three differ in colour, in border style and in wording, so the distinction
survives greyscale and colour-blindness rather than depending on hue.

A module the user has already named is never sent to a model. It is not worth
paying to rename something the user has settled.

---

## The no-key path is the default path

With no `ANTHROPIC_API_KEY`, the tool runs completely and labels every module
mechanically. It does not warn, does not degrade loudly, and does not nag. The
Anthropic SDK is loaded through a dynamic `import()`, so a key-less run never
pays the 6.5 MB load cost.

The run reports `degraded: true` — meaning "no model was consulted", not "this
failed".

Verified on all three reference repositories:

| Repo | Files | Modules | Labelled | Cost | Wall clock |
|---|---|---|---|---|---|
| requests | 37 | 6 | 6 mechanical | $0 | 0.9 s |
| zod | 406 | 19 | 19 mechanical | $0 | 2.7 s |
| pyright | 1,917 | 46 | 46 mechanical | $0 | 11.2 s |

A model failure mid-run behaves the same way. Mechanical names are assigned
first, always, so every module has a name before anything is asked — which means
a failure part-way through degrades to a complete result rather than a partial
one.

---

## Cost

The rule is *send the graph, not the code*. A cluster is described by its file
paths, its most-used exported symbols, and two or three short snippets. Never
file contents. Per-cluster caps are in `src/llm/prompt.ts`; the effect is that a
1,274-file module costs the same to describe as a 4-file one.

Measured by building the real prompts for each repository and counting them —
these are the actual payloads, not an estimate of their size:

| Repo | Modules | Input tokens | Output tokens | Haiku 4.5 | Sonnet 5 | Opus 5 |
|---|---|---|---|---|---|---|
| requests | 6 | 860 | 240 | **$0.0021** | $0.0062 | $0.0103 |
| zod | 406 files → 19 | 6,732 | 760 | **$0.0105** | $0.0316 | $0.0527 |
| pyright | 1,917 files → 46 | 10,303 | 1,840 | **$0.0195** | $0.0585 | $0.0975 |

Pyright's 1,917 files compress to about 10k input tokens. That is the compression
rule working: cost tracks module count, which is roughly flat, not file count,
which is not.

Week 14 runs this across 50–100 repositories. At pyright's size that is $1–2 on
Haiku against $5–10 on Opus.

---

## Model default

`claude-haiku-4-5`. Naming a cluster from paths and symbols is a short, shallow
task, and it is run many thousands of times. $1/$5 per MTok against Opus 5's
$5/$25.

Override with `VIBE_LLM_MODEL`.

> **Unverified.** The brief made this switch conditional on comparing Haiku's and
> Sonnet's labels side by side on a real repository. No Anthropic credentials
> exist in this environment, so **that comparison has not been run** and the
> default is a cost argument, not a measured one.
>
> `scripts/compare-label-models.mjs` runs it in one command. It gives each model
> an isolated cache directory so a warm cache cannot answer for the model under
> test, and reports labels side by side against the mechanical name plus mean
> words per label and distinct-label count — vaguer naming shows up as shorter,
> more repetitive names.
>
> If Haiku's names turn out to be meaningfully vaguer, change `DEFAULT_MODEL` in
> `src/llm/anthropic.ts` back to a Sonnet tier. The cost table above says what
> that costs.

### Temperature

Not sent. Opus 5, Opus 4.8/4.7 and Sonnet 5 reject the parameter outright with a
400; Haiku 4.5 and the Sonnet 4.x tiers still accept it. Rather than branch on
model family, it is omitted.

Reproducibility does not depend on it. The response cache is the reproducibility
guarantee: an unchanged repository re-run does not call the model at all, so
there is no sampling to be reproducible about.

---

## The cache

Keyed on SHA-256 of model, system prompt, user prompt and output schema — every
input that could change the answer. Stored at `.vibe/label-cache.json`.

Only validated answers are cached. Something the tool refused is never stored.

The cache is flushed even on a partial run, so work already paid for is not paid
for twice.

**Acceptance — 100% hit rate on an unchanged re-run**, with the cache reloaded
from disk between runs rather than reused in memory:

| Repo | Modules | Run 1 | Run 2 |
|---|---|---|---|
| requests | 6 | 6 misses, 6 calls | **6 hits, 0 calls, $0** |
| zod | 19 | 19 misses, 19 calls | **19 hits, 0 calls, $0** |
| pyright | 46 | 46 misses, 46 calls | **46 hits, 0 calls, $0** |

Run with a stub provider standing in for the network — the real prompt builder,
the real key derivation, the real on-disk cache and the real labeller, only the
HTTP call substituted.

---

## Prompt injection

Everything from the repository is attacker-controlled. Paths, symbol names,
snippets. `IGNORE-PREVIOUS-INSTRUCTIONS.ts` is a legal filename, and a
vibe-coded repository is precisely the kind of place a hostile string ends up
without anyone intending it.

Three layers, in increasing order of how much they are actually relied on:

1. **System-prompt framing.** The model is told the payload is data, and that
   instructions inside it are content to describe rather than obey. Weakest.
   Listed first because it shapes behaviour rather than containing it.
2. **Fencing.** Repository content sits inside a delimiter, and any occurrence of
   that delimiter in the content is neutralised, so a payload cannot close its
   own fence and continue as prose.
3. **Output validation.** A label is a short string checked against a strict
   shape. This is the layer that holds. The worst a successful injection achieves
   is a rejected label and a module that keeps its mechanical name.

### Stated plainly

**These are mitigation, not prevention.** Layers 1 and 2 can be defeated; that is
the nature of prompt injection, and nothing here is a solution to it. There is no
claim otherwise.

What makes the risk acceptable *this week* is not the defences — it is the blast
radius. Labels are cosmetic. Structure is derived before the model is consulted
and cannot be altered by anything it returns. A fully successful injection
changes a name.

**Week 7 raises the stakes considerably.** Reading intent from README files,
commit messages and chat logs means ingesting prose written to be persuasive, in
volume, and using it to decide whether the architecture conforms. The payload
gets larger and much more injectable, and the output stops being cosmetic —
a manipulated intent extraction changes what the tool reports as a violation,
which is the thing users would act on.

Layer 3 is the one that will still be load-bearing then, and it will need to be
stronger than a string-shape check. That is a Week 7 design problem, and it
should be treated as the main one.
