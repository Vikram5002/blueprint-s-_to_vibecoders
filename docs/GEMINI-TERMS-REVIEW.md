# Gemini API terms: can Gemini output be used to train the local code model?

**Status:** NOT CLEARED. Data collection (LOCAL-CODE-MODEL-PLAN.md, section 5) and Step 0 are on hold.
**Date checked:** 2026-09-18
**Gates:** open question 1 in `docs/LOCAL-CODE-MODEL-PLAN.md`

This is a reading of the published terms, not legal advice. It records what the terms say and why they don't clearly allow this plan.

## What the plan would do

Send Gemini about 2,500 code-generation requests, keep the files that build, and use them as training data for a LoRA adapter on Qwen2.5-Coder-7B-Instruct. The adapter's stated purpose is to be a **drop-in alternative to Gemini** as the code provider in this tool's **Code** dropdown.

## What the terms say (quoted)

### 1. Gemini API Additional Terms of Service

Source: https://ai.google.dev/gemini-api/terms. Last updated 2026-04-28. These terms control where they conflict with the general Google APIs terms.

> **Use Restrictions:** "You may not use the Services to develop models that compete with the Services (e.g., Gemini API or Google AI Studio)."

> "You also may not attempt to reverse engineer, extract or replicate any component of the Services, including the underlying data or models."

> **Use of Generated Content:** "Google won't claim ownership over that content."

### 2. Google APIs Terms of Service

Source: https://developers.google.com/terms. Last modified 2021-11-09. These apply underneath the Gemini terms.

> "If there is a conflict between these terms and additional terms applicable to a given API, the additional terms will control for that conflict."

> **5(e) Prohibitions on Content:** "Unless expressly permitted by the content owner or by applicable law, you will not ... do the following with content returned from the APIs: Scrape, build databases, or otherwise create permanent copies of such content ..."

### 3. Generative AI Prohibited Use Policy

Source: https://policies.google.com/terms/generative-ai/use-policy. It says nothing about training other models or about competing models.

## Why this is not cleared

1. **The competing-models clause is the main problem.** It prohibits using the Services "to develop models that compete with the Services". The terms don't define "compete". They don't limit it to commercial products, and they don't exempt personal or academic work.
   - Our model's purpose, written down in our own plan, is to **replace Gemini for one specific task inside this tool**. It sits in the same dropdown as Gemini, and success is measured as matching Gemini's pass rate.
   - A narrow reading ("compete" means a general-purpose rival to the Gemini API) would probably allow it. A plain reading ("a model built from Gemini's output to do Gemini's job") would not.
   - Nothing in the terms settles which reading applies.
2. **Collecting the data itself may be covered by 5(e).** "Build databases, or otherwise create permanent copies" of API content describes a training dataset. 5(e) allows it where "the content owner" permits. The Gemini terms say Google "won't claim ownership" of generated content, which suggests we are the owner, but that isn't the same as saying so. This part is probably fine, but it's not certain.
3. **Ownership doesn't settle the question.** Owning the output (point 2) doesn't override the separate restriction on *what the Services may be used to develop* (point 1).

**Result:** ambiguous, and on the plain reading, restricted. As instructed, this is reported back rather than worked around. The fallback of writing training data without Gemini changes the timeline and cost, so it's for you to decide separately.

## Options, for discussion (none chosen)

| Option | What it means | Main cost |
|---|---|---|
| A. Ask Google | Write to Google (AI Studio support or the terms contact) describing the exact use and ask for a written answer | Unknown wait; may get no clear answer |
| B. Legal / university advice | Ask your university's IP or legal office, or your supervisor, whether a non-commercial research adapter falls under "compete" | Usually days to weeks |
| C. Don't use Gemini output for training | Get the training code from other sources: hand-written, open-licensed code, or a model whose terms allow it (open-weight models such as Qwen itself, under their licences) | Much slower or lower quality; the timeline and cost need re-planning |
| D. Don't fine-tune for code at all | Serve plain Qwen2.5-Coder with no adapter, and use the tool's repair loop | May not reach the pass bar; measurable without any Gemini training data |

**Note on Step 0:** Step 0 only *evaluates* models. Gemini would be used there for a baseline measurement, not for training. It's less clearly affected by the competing-models clause, but you asked that it wait until question 1 is cleared, so it hasn't been run.
