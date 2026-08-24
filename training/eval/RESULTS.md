# Held-out generalization eval — results

**Checkpoint:** `run_20260822_130636` (base Qwen2.5-7B-Instruct + LoRA adapter,
91 training rows, 3 epochs, final training loss 0.90, peak VRAM 8.69GB —
trained on the borrowed desktop; see `M:\bunny_vikram\checkpoints\run_20260822_130636\summary.json`).
Generation ran on the desktop (`training/eval/generate-holdout-outputs.py`);
validation ran on LOQ against the real compiled `validateProjectSchema`
(`training/eval/validate-holdout-outputs.mjs`), same function every dataset
pair in this repo has been checked against — not a port, not a looser check.

**Why this matters:** training loss going down only tells you the model
learned the training set. This tells you whether it can produce a
structurally valid `ProjectSchema` for 10 prompts it never saw, checked
against zero near-duplicates in the training corpus (verified via
`findNearDuplicatePrompts` before the eval ran).

## 1. Pass count

**8 of 10** generated outputs are valid `ProjectSchema` JSON as-is.

## 2. Failures — exact violations

**#7 — church community scheduling app** (4 violations, all `duplicate-component-id`):
```
$.domains.database.components[0].id: duplicate-component-id
$.domains.database.components[1].id: duplicate-component-id
$.domains.database.components[2].id: duplicate-component-id
$.domains.security.components[0].id: duplicate-component-id
```
The id `"1234567890abcdef"` is reused across the "Shift Sign-Up Board"
(frontend) and "events table" (database) components; `"c9a230371767606a"`
is reused across "Event API" (backend), "shifts table" (database), and
"Admin-Only Reminder Email Guard" (security); `"6036737337373737"` is
reused across "Email Reminder Service" (backend) and "rsvps table"
(database).

**#10 — local business directory** (1 violation):
```
$.domains.security.components[0].id: duplicate-component-id
```
`"6776336776336776"` is reused across "reviews table" (database) and
"Owner-Claim Guard" (security).

## Root cause — this is bigger than 2 failures

Neither failure is a content mistake. Both are the same underlying issue:
**the model never computes a real content-derived hash for a component id
— it generates a plausible-looking hex string instead**, because doing the
real thing (`componentId()`'s actual sha256 computation over
domain+name+purpose) requires running a hash function, not predicting
tokens. Several of the "passing" outputs make this visible directly: ids
like `"7777777777777777"`, `"1234567890abcdef"`, and `"0987654321fedcba"`
are not pseudorandom hex — they're repeated digits or keyboard patterns,
not real hashes of anything.

**This means the 8/10 pass count overstates id correctness.** The real
validator only checks that an id is a non-empty string, unique *within that
one schema* — it has no way to check whether an id is the actual hash of
its own component's domain/name/purpose, because doing that check would
require recomputing the hash and comparing, which the validator (correctly,
for its purpose) doesn't do. In the 8 passing outputs, the fake ids simply
happened not to collide with each other. In the 2 failing outputs, they
did. **All 10 outputs almost certainly have wrong ids; only 2 were unlucky
enough to collide and get caught.**

**Recommendation, not a fix applied here:** this is very unlikely to
improve much with more training data, because it's not a
knowledge-of-the-task gap — it's asking a language model to do a
computation it structurally cannot perform through generation. The right
fix is architectural, not more fine-tuning: have the calling orchestrator
**recompute real ids programmatically** (call the actual `componentId()`
against the model's generated domain/name/purpose — the part it's
genuinely good at, see below) rather than trusting whatever id string the
model emits. The model should probably not be asked to emit `id` at all;
it's the one field in this schema that has a correct, checkable answer a
program can compute exactly and a language model cannot.

## A second finding: `sessionId` is memorized, not generated

Every one of the 10 outputs uses `sessionId` `"session-gold-021"` or
`"session-gold-031"` — both real training sessionIds — regardless of what
the held-out prompt actually was. Nothing about `"session-gold-021"`
relates to a journaling app, a dice roller, and a carbon tracker
simultaneously; the model is pattern-matching "this field looks like
`session-gold-0XX`" and picking one from a small memorized set, not
generating something novel. This passes validation (the field just has to
be a non-empty string) but is a second field, like `id`, that a program
should probably assign rather than ask the model to invent — a fresh
`sessionId` doesn't require any judgment the model has to exercise; it's
bookkeeping.

## 3. Quality spot-check on passing outputs

Three, chosen for range — a straightforward case, a case testing a
specific stated constraint, and a case testing whether the model avoids
over-populating domains it shouldn't.

**Journaling app** (prompt: daily entries + mood tags + trends) — coherent
and appropriately scoped: Journal Entry Form + Mood Trends View
(frontend), Entries API (backend), entries table (database), **security
correctly left empty** — a personal single-user journaling app has no
stated auth/sharing concern, and the model didn't invent one. Good.

**Whistleblower tip portal** (prompt: submissions must be completely
anonymous, no IP/account/identifying info ever stored) — this is the
strongest result in the set. The model produced a security component
named "No-Identifying-Data Guard" whose purpose text directly restates the
prompt's specific constraint ("never logs, stores, or transmits the
submitter's identity or personal data"), and the backend/database
component purposes both independently reinforce "encrypted... never raw
personal data." This isn't generic security boilerplate — it's a
constraint derived specifically from what this one prompt asked for, on a
prompt the model never saw in training. That's the real evidence of
generalization this eval was built to find.

**Offline note-taking app** (prompt: no server, no account, sync only via
manual file export) — the model correctly left **backend, database, and
security all empty**, recognizing this prompt describes a fully
client-side architecture rather than defaulting to the backend+database
pattern every other output in this set uses. This is the opposite failure
mode of what you'd expect from a small fine-tune (blindly pattern-matching
"apps have a backend") and it got it right. One minor inconsistency worth
noting: the frontend component's `dependsOn` still lists `["backend"]`
even though backend is empty — a small logical gap the validator doesn't
catch (it checks that `dependsOn` names are valid domain names, not that
the named domain is actually non-empty), but a human reading it notices
immediately.

## Overall read

**The part that matters most — deciding what a schema should contain for a
novel prompt — shows real generalization, not memorization.** The
whistleblower and offline-notes examples in particular derive
prompt-specific decisions (a targeted security constraint; correctly empty
domains) that can't be explained by copying a training example. That's the
finding this eval exists to surface, and it's a genuinely positive one for
a first training run on 91 pairs.

**The part that fails is metadata the model was never going to get right
by learning harder — ids and sessionId are computations/bookkeeping, not
judgments.** Fixing this isn't "collect more data and retrain"; it's
"stop asking the model to emit fields a program can compute correctly
every time, and have it emit only the fields that require understanding
the prompt." That's a real, actionable finding for how the orchestrator
should be built, not a verdict on whether the fine-tune is working.
