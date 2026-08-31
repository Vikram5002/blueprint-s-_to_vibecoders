/**
 * Layer 2: turns a natural-language project description into a validated
 * ProjectSchema.
 *
 * Two separate concerns kept apart on purpose:
 *
 * - `analyzePrompt` is a cheap, deterministic, non-LLM pre-check. It flags a
 *   prompt as short, vague, or self-contradictory using shallow keyword
 *   heuristics — not real natural-language understanding. Its job is to give
 *   a caller (eventually the UI) a signal for "maybe ask a clarifying
 *   question before spending a generation on this," never to gate or block
 *   generation itself. Treat its output as advisory.
 *
 * - `createProjectSchemaGenerator` does the real work: one `CompletionProvider`
 *   call, following the exact {system, user, schema} shape training/
 *   TRAINING-FORMAT.md documents (system is the fixed task-framing prompt
 *   below, user is the caller's prompt verbatim, schema constrains the
 *   answer). The response is never trusted on the strength of the request
 *   schema alone — `validateProjectSchema` is the real backstop, same
 *   two-tier posture TRAINING-FORMAT.md describes for provider.ts generally.
 *
 * Component ids are recomputed with `componentId()` after parsing and before
 * validation, never trusted from the model's answer as-is. project-schema.ts
 * documents ids as content-derived (same domain+name+purpose always produces
 * the same id); a held-out eval of the local checkpoint
 * (training/SWEEP-COMPARISON-20260824.md's Config C run) showed the model
 * does not reliably follow that scheme on its own — ids like
 * "1766666666666666" are decoding artifacts, not sha256 output. Recomputing
 * them here makes the contract project-schema.ts already promises actually
 * hold, regardless of what the model produced.
 *
 * Constraint ids get the same treatment, for the same reason, discovered
 * later: the local checkpoint's empty-constraints problem meant no real
 * constraint existed to expose this until a 2026-08-31 desktop session's
 * schema-injection fix finally produced one — id "c966666666666666", the
 * identical repeated-digit decoding artifact componentId() was already
 * built to correct, just never observed on a constraint before. Same
 * content-derivation scheme `constraintId` (src/conformance/compile.ts) and
 * `compiledConstraintId` (compile-constraints.ts) already use, applied a
 * third time here rather than inventing a fourth id scheme — see
 * `generatedConstraintId` below.
 *
 * `sessionId` was left as the model returned it for a while, deliberately,
 * pending diagnosis — that diagnosis is done. A 2026-08-31 desktop session
 * confirmed the memorized-training-id leak on 5/5 real generations
 * (session-gold-021, session-gold-031, session-real-023 — always a training
 * id, never fresh, regardless of prompt). Fixed the same way source.timestamp
 * already was: `fillFixedConstraintFields`'s existing `generatedAt`-gated
 * branch now also stamps a fresh `sessionId` via `randomUUID()` on a real
 * generation, left untouched on the cache-hit re-validate path — not the
 * `componentId()` content-derived pattern used for ids above, deliberately.
 * A session is an event, not content: two independent generations of the
 * same prompt are still two separate sessions and should not collapse to
 * the same id just because the prompt matched, the way two components with
 * identical domain/name/purpose genuinely are the same component.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CompletionProvider } from '../llm/provider.js';
import { cacheKey, type LabelCache } from '../llm/cache.js';
import { type Result, ok, err } from '../types/result.js';
import { DOMAIN_NAMES, type DomainName, type ValidatedProjectSchema, componentId } from '../types/project-schema.js';
import { CONSTRAINT_RELATIONS } from '../types/constraints.js';
import { validateProjectSchema, type ProjectSchemaRejection } from './validate-project-schema.js';

// ---------------------------------------------------------------------------
// Prompt analysis (no LLM call)
// ---------------------------------------------------------------------------

export type AmbiguityFlag = 'too-short' | 'vague-scope' | 'possible-contradiction';

export interface PromptAnalysis {
  readonly wordCount: number;
  readonly flags: readonly AmbiguityFlag[];
}

/** Below this many words, a prompt cannot state enough to generate from confidently. */
const TOO_SHORT_WORD_THRESHOLD = 6;

/**
 * Curated, not exhaustive — drawn from this project's own fine-tuning corpus
 * (training/data/gold, training/data/real-project). A prompt naming none of
 * these is not necessarily vague, but one that does is meaningfully less
 * likely to be — this is a precision-over-recall list on purpose.
 */
const CONCRETE_DOMAIN_NOUNS: readonly string[] = [
  'task', 'board', 'card', 'note', 'chat', 'message', 'appointment', 'booking',
  'ticket', 'order', 'item', 'product', 'team', 'file', 'photo', 'video',
  'event', 'expense', 'invoice', 'workout', 'recipe', 'journal', 'entry',
  'mood', 'listing', 'directory', 'sighting', 'tip', 'submission', 'volunteer',
  'sensor', 'reading', 'dashboard', 'report', 'form', 'survey', 'game', 'dice',
  'library', 'inventory', 'shift', 'schedule', 'reservation', 'wildlife',
];

/**
 * Each pair names two requirements that cannot both hold for the same
 * system. Shallow keyword matching, not real contradiction detection — a
 * cheap pre-check to route a prompt toward a clarifying question, not a
 * substitute for judgment. It will both miss real contradictions phrased
 * differently and occasionally flag two requirements that are actually
 * compatible (e.g. "no server" for compute alongside "sync via a file").
 */
const CONTRADICTION_PAIRS: ReadonlyArray<{ readonly a: readonly string[]; readonly b: readonly string[] }> = [
  {
    a: ['offline', 'no server', 'no account', 'no internet', 'fully local'],
    b: ['sync to the cloud', 'shared cloud', 'central database', 'account required', 'log in', 'server'],
  },
  {
    a: ['anonymous', 'no identifying information', 'must never log', 'must never store'],
    b: ['track the user', "user's identity", 'requires login', 'stores their name'],
  },
];

export function analyzePrompt(prompt: string): PromptAnalysis {
  const normalized = prompt.trim().toLowerCase();
  const words = prompt
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const flags: AmbiguityFlag[] = [];

  if (words.length > 0 && words.length < TOO_SHORT_WORD_THRESHOLD) {
    flags.push('too-short');
  }

  const hasConcreteNoun = CONCRETE_DOMAIN_NOUNS.some((noun) => normalized.includes(noun));
  if (!hasConcreteNoun) {
    flags.push('vague-scope');
  }

  const hasContradiction = CONTRADICTION_PAIRS.some(
    (pair) => pair.a.some((term) => normalized.includes(term)) && pair.b.some((term) => normalized.includes(term)),
  );
  if (hasContradiction) {
    flags.push('possible-contradiction');
  }

  return { wordCount: words.length, flags };
}

// ---------------------------------------------------------------------------
// Generated-pair analysis (no LLM call)
// ---------------------------------------------------------------------------

export type SyntheticPairFlag = 'suspicious-empty-constraints';

export interface SyntheticPairAnalysis {
  readonly flags: readonly SyntheticPairFlag[];
}

/**
 * Curated, not exhaustive, same precision-over-recall posture as
 * CONCRETE_DOMAIN_NOUNS and CONTRADICTION_PAIRS above - a prompt naming
 * none of these is not necessarily free of an architectural rule, but one
 * that does is meaningfully more likely to imply one.
 */
const ACCESS_CONTROL_TERMS: readonly string[] = ['role', 'permission', 'must not', 'only', 'access', 'layer', 'via'];

/**
 * Advisory pre-check for a generated (prompt, constraints) pair, meant for
 * synthetic-generation curation before a pair is accepted into the dataset —
 * not part of createProjectSchemaGenerator's own generate() path, and never
 * a gate on it, same posture as analyzePrompt above: a signal for a human
 * reviewer, never something that blocks or rejects on its own.
 *
 * Exists because of a specific, confirmed problem with this project's
 * baseline checkpoint (run_20260822_130636), not a generic quality check:
 * a 2026-08-31 desktop session found a 5/5 empty-`constraints` rate across
 * real generations (including a verbatim training prompt whose own training
 * target has a real constraint), and the checkpoint's own training data
 * already carries a 73.6% empty-constraint skew (67 of 91 rows). Since
 * `synthetic` pairs are meant to be bootstrapped from "a first fine-tune"
 * (training/data/METHODOLOGY.md) — this checkpoint, or one like it —
 * accepting its empty-constraint output at face value risks quietly
 * amplifying the exact bias already diagnosed, rather than correcting it.
 * `validateProjectSchema` cannot catch this: an empty `constraints` array
 * is fully valid shape, zero rejections, zero warnings.
 *
 * Deliberately narrow: only flags a prompt that plausibly implies an
 * architectural rule (per ACCESS_CONTROL_TERMS) paired with an empty result.
 * A prompt with no such language and empty constraints is not the failure
 * pattern being caught here - most real prompts genuinely imply no
 * constraint at all (73.6% of this project's own hand-written/real-project
 * corpus does), and flagging those too would bury the signal this exists to
 * surface in noise.
 */
export function analyzeGeneratedPair(prompt: string, constraints: readonly unknown[]): SyntheticPairAnalysis {
  const normalized = prompt.trim().toLowerCase();
  const flags: SyntheticPairFlag[] = [];

  const impliesAccessControl = ACCESS_CONTROL_TERMS.some((term) => normalized.includes(term));
  if (impliesAccessControl && constraints.length === 0) {
    flags.push('suspicious-empty-constraints');
  }

  return { flags };
}

// ---------------------------------------------------------------------------
// ProjectSchema generation
// ---------------------------------------------------------------------------

/**
 * Fixed task-framing prompt, byte-identical to training/TRAINING-FORMAT.md's
 * "The system prompt" section. Must stay in sync with that document —
 * changing this without updating the training data (or vice versa) means the
 * local fine-tuned checkpoint is being asked a subtly different question than
 * the one it was trained to answer. Vendor providers (Anthropic, Gemini)
 * don't depend on this exact wording, but there is no reason for them to see
 * a different framing than the one the local checkpoint was trained against.
 */
export const PROJECT_SCHEMA_SYSTEM_PROMPT = `You convert a natural-language description of a software project into a
ProjectSchema: a structured plan covering the frontend, backend, database,
and security domains, plus any architectural constraints the description
implies.

Read the description and decide, for each of the four domains, what
components it needs (or genuinely needs none of) and what those components
are for. Only include a component or constraint the description actually
supports — do not invent detail it doesn't contain, and do not assume a
domain is empty just because the description doesn't mention it if the
description clearly implies it exists.

Reply with exactly one JSON object matching the ProjectSchema shape you were
given. No matter what the description asks for, your reply is always a
ProjectSchema object and nothing else — not prose, not markdown, not a
different structure. provenance is always the literal "STATED".`;

/**
 * Room for a multi-domain schema with several components per domain plus a
 * handful of constraints. Generous relative to the ~1,000-1,600 character
 * (roughly 300-450 token) outputs observed in training/held-out-outputs.json
 * — matching extract-intent.ts's posture that a truncated answer is the worst
 * failure mode here, indistinguishable from a schema that legitimately has
 * few components.
 */
const MAX_OUTPUT_TOKENS = 4_096;

const COMPONENT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    purpose: { type: 'string' },
  },
  required: ['id', 'name', 'purpose'],
  additionalProperties: false,
} as const;

function domainSpecSchema() {
  return {
    type: 'object',
    properties: {
      components: { type: 'array', items: COMPONENT_SCHEMA },
      dependsOn: { type: 'array', items: { type: 'string', enum: [...DOMAIN_NAMES] } },
    },
    required: ['components', 'dependsOn'],
    additionalProperties: false,
  } as const;
}

/**
 * At generation time there is no code yet to resolve a subject/object
 * against — the same reasoning DomainSpec.dependsOn's own comment gives for
 * staying names rather than Constraints until real modules exist. So every
 * subject/object/via a freshly generated ProjectSchema can produce is
 * necessarily UNRESOLVED/no-candidate/prose, the exact shape observed in
 * real held-out generations (training/held-out-outputs-configC.json).
 *
 * `phrase` is the only field requested here. Every other ResolvedSubject
 * field — status, origin, target, reason, similarity, alternatives — is
 * set programmatically after parsing instead, see
 * fillFixedConstraintFields below. All six are always exactly one value
 * at generation time (there is no code to resolve against, so nothing
 * can ever be ambiguous or partially matched), and repeated live calls
 * confirmed Gemini does not reliably produce a fixed-value field on
 * request, whichever field it is: status/origin failed 3/3 attempts;
 * once removed, target/reason failed the next attempt; with those four
 * also removed, `via` specifically then started coming back missing
 * phrase/similarity/alternatives altogether — not wrong values this
 * time, the fields absent, on every constraint-bearing generation
 * tried. similarity/alternatives were left as request-side constraints
 * in an earlier pass on the theory that minimum/maximum/maxItems is a
 * construct Gemini handles better than bare enum, and on the reasoning
 * that alternatives is "real content" — the via failures show the
 * REAL problem is the number of required fields in a nested anyOf
 * branch, not the mechanism used to constrain each one, and disprove
 * the "real content" framing: alternatives can never be non-empty at
 * generation time either, same as target/reason. Reducing the required
 * set to just phrase removes that pressure entirely.
 */
const UNRESOLVED_PROSE_SUBJECT_SCHEMA = {
  type: 'object',
  properties: {
    phrase: { type: 'string' },
  },
  required: ['phrase'],
  additionalProperties: false,
} as const;

const CONSTRAINT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    relation: { type: 'string', enum: [...CONSTRAINT_RELATIONS] },
    subject: UNRESOLVED_PROSE_SUBJECT_SCHEMA,
    object: UNRESOLVED_PROSE_SUBJECT_SCHEMA,
    via: { anyOf: [UNRESOLVED_PROSE_SUBJECT_SCHEMA, { enum: [null] }] },
    // line and timestamp are not requested here, for the same reason
    // subject/object/via's status and origin are not (see
    // UNRESOLVED_PROSE_SUBJECT_SCHEMA's docstring above). Neither is
    // genuine model output for a schema generated from a bare prompt:
    // line has no natural value (a one-paragraph prompt has no lines to
    // reference — every real chat-log-sourced fixture in this codebase
    // already carries line: null), and the model has no way to know the
    // real wall-clock time of its own inference. Both are set by
    // fillFixedConstraintFields after parsing instead. type and location
    // ARE still requested: which kind of source this is, and where
    // within it, is a judgement call the model has to make, not a fixed
    // constant.
    source: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['chat-log', 'agents-md', 'readme', 'adr', 'commit-msg', 'user-authored', 'seeded-from-derived'],
        },
        location: { type: 'string' },
      },
      required: ['type', 'location'],
      additionalProperties: false,
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    lowConfidence: { type: 'boolean' },
    rawText: { type: 'string' },
    // provenance not requested - see UNRESOLVED_PROSE_SUBJECT_SCHEMA's
    // docstring. A Constraint's provenance is always 'STATED', never
    // DERIVED (project-schema.ts: "no code path that sets this to
    // DERIVED"), so this is the same class of enum-locked single value
    // as status/origin/target/reason. Set by fillFixedConstraintFields.
  },
  required: ['id', 'relation', 'subject', 'object', 'via', 'source', 'confidence', 'lowConfidence', 'rawText'],
  additionalProperties: false,
} as const;

export const PROJECT_SCHEMA_JSON_SCHEMA = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    title: { type: 'string' },
    originalPrompt: { type: 'string' },
    domains: {
      type: 'object',
      properties: {
        frontend: domainSpecSchema(),
        backend: domainSpecSchema(),
        database: domainSpecSchema(),
        security: domainSpecSchema(),
      },
      required: [...DOMAIN_NAMES],
      additionalProperties: false,
    },
    constraints: { type: 'array', items: CONSTRAINT_SCHEMA },
    // provenance not requested - a ProjectSchema is always 'STATED' per
    // its own type ("no code path can produce the other value"). Same
    // enum-locked-single-value class handled programmatically throughout
    // this file; set on the top-level object in fillFixedConstraintFields.
  },
  required: ['sessionId', 'title', 'originalPrompt', 'domains', 'constraints'],
  additionalProperties: false,
} as const;

const SCHEMA_FINGERPRINT = JSON.stringify(PROJECT_SCHEMA_JSON_SCHEMA);

export type GenerateFailure =
  /** The provider itself failed — network, refusal, truncation. */
  | { readonly reason: 'provider-error'; readonly message: string }
  /** The provider's text did not even parse as JSON. */
  | { readonly reason: 'unparseable-json'; readonly message: string }
  /** Parsed, but validateProjectSchema rejected it. Never cached. */
  | { readonly reason: 'schema-violation'; readonly message: string; readonly rejections: readonly ProjectSchemaRejection[] };

export interface ProjectSchemaGenerator {
  generate(prompt: string): Promise<Result<ValidatedProjectSchema, GenerateFailure>>;
}

export interface CreateProjectSchemaGeneratorOptions {
  readonly provider: CompletionProvider;
  readonly cache: LabelCache;
  /**
   * Called exactly when fillResolvedSubjectFixedFields decides to discard a
   * via for a missing/invalid phrase - once per firing, synchronously,
   * before generate() resolves. Optional and side-channel only: omitting
   * it changes nothing about generate()'s behavior or return shape.
   *
   * Exists because a logged `via: null` is otherwise structurally
   * indistinguishable from "the model correctly said there was no via" -
   * both produce the same final value. This is the one place that
   * actually knows which one happened, so a caller that needs to tell
   * them apart (scripts/pipe-schema-to-compiler.mjs) has to observe it
   * here, not infer it from the result afterward.
   */
  readonly onViaFallback?: () => void;
}

export function createProjectSchemaGenerator(options: CreateProjectSchemaGeneratorOptions): ProjectSchemaGenerator {
  return {
    generate: async (prompt: string): Promise<Result<ValidatedProjectSchema, GenerateFailure>> => {
      const key = cacheKey({
        model: options.provider.model,
        system: PROJECT_SCHEMA_SYSTEM_PROMPT,
        user: prompt,
        schema: SCHEMA_FINGERPRINT,
      });

      const cached = options.cache.get(key);
      if (cached !== undefined) {
        // The cache holds only answers that already passed validation (see
        // below), but re-validate anyway rather than trust the file on disk
        // blindly — a hand-edited or corrupted cache entry must fail the
        // same way a bad model answer would, not bypass the gate that exists
        // specifically to keep an invalid ProjectSchema from ever being
        // returned.
        return finalize(cached.description ?? '', null, options.onViaFallback);
      }

      const completion = await options.provider.complete({
        system: PROJECT_SCHEMA_SYSTEM_PROMPT,
        user: prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        schema: PROJECT_SCHEMA_JSON_SCHEMA,
        // 0 for the same reproducibility reason extract-intent.ts sets it:
        // not a substitute for the cache, but repeated runs against a
        // provider that ignores the cache (or a fresh cache) should not
        // disagree about what the same prompt implies.
        temperature: 0,
        // Deciding what an application needs across four domains from one
        // paragraph is a judgement call, not a lookup — same tier
        // extract-intent.ts uses for reading obligations out of prose.
        effort: 'medium',
      });

      if (!completion.ok) {
        return err({ reason: 'provider-error', message: completion.error.message });
      }

      const result = finalize(completion.value.text, new Date().toISOString(), options.onViaFallback);
      if (result.ok) {
        // Only a validated answer is cached. Caching a rejected one would
        // make a bad answer sticky forever — every future call with the same
        // prompt would replay the same rejection instead of getting a fresh
        // attempt.
        options.cache.set(key, {
          label: 'project-schema',
          description: JSON.stringify(result.value),
          model: completion.value.model,
          promptTokens: completion.value.usage.promptTokens,
          completionTokens: completion.value.usage.completionTokens,
          createdAt: new Date().toISOString(),
        });
      }
      return result;
    },
  };
}

/**
 * `generatedAt` is null on the cache-hit re-validate path (see the two
 * call sites) and a real ISO timestamp on a fresh completion, captured
 * once before the result is ever cached. Passing null on cache hit is
 * what keeps repeated calls with the same prompt byte-identical -
 * fillFixedConstraintFields leaves an already-embedded timestamp alone
 * rather than overwriting it with "now" on every re-validation.
 */
function finalize(
  text: string,
  generatedAt: string | null,
  onViaFallback?: () => void,
): Result<ValidatedProjectSchema, GenerateFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err({ reason: 'unparseable-json', message: `response was not valid JSON: ${String(cause)}` });
  }

  const withFixedFields = fillFixedConstraintFields(rewriteComponentIds(parsed), generatedAt, onViaFallback);
  const withConstraintIds = rewriteConstraintIds(withFixedFields);
  const validated = validateProjectSchema(withConstraintIds);
  if (!validated.ok) {
    return err({
      reason: 'schema-violation',
      message: `${validated.error.length} rejection(s), starting with ${validated.error[0]?.path}: ${validated.error[0]?.reason}`,
      rejections: validated.error,
    });
  }
  return ok(validated.value);
}

/**
 * Recomputes every component's id via componentId(domain, name, purpose),
 * discarding whatever id the model produced. Defensive about shape — this
 * runs before validateProjectSchema, on an unknown value, so anything that
 * doesn't look like a well-formed domain/component is left untouched and
 * reported by the real validator instead of guessed at here.
 */
function rewriteComponentIds(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null) return candidate;
  const obj = candidate as Record<string, unknown>;
  const domains = obj['domains'];
  if (typeof domains !== 'object' || domains === null) return candidate;

  const domainsObj = domains as Record<string, unknown>;
  const nextDomains: Record<string, unknown> = { ...domainsObj };

  for (const domainName of DOMAIN_NAMES) {
    const spec = domainsObj[domainName];
    if (typeof spec !== 'object' || spec === null) continue;
    const specObj = spec as Record<string, unknown>;
    const components = specObj['components'];
    if (!Array.isArray(components)) continue;

    const nextComponents = components.map((component) => rewriteOneComponentId(domainName, component));
    nextDomains[domainName] = { ...specObj, components: nextComponents };
  }

  return { ...obj, domains: nextDomains };
}

function rewriteOneComponentId(domainName: DomainName, component: unknown): unknown {
  if (typeof component !== 'object' || component === null) return component;
  const c = component as Record<string, unknown>;
  if (typeof c['name'] !== 'string' || typeof c['purpose'] !== 'string') return component;
  return { ...c, id: componentId(domainName, c['name'], c['purpose']) };
}

/**
 * Overwrites every enum-locked single-value field this schema would
 * otherwise ask the model to echo back, discarding whatever the model
 * produced there: status/origin/target/reason on every constraint's
 * subject/object/non-null via, provenance on every constraint and on
 * the top-level schema, line/(when generatedAt is real) timestamp on
 * every constraint's source, and (when generatedAt is real) the
 * top-level sessionId.
 *
 * sessionId is not enum-locked like the others - it belongs here anyway
 * because the same underlying problem applies: the model has no way to
 * mint a genuinely fresh id for a session it has no knowledge of outside
 * training, and reliably echoes a memorized training-time id instead
 * (session-gold-021 and others - see this file's top docstring). Stamped
 * with randomUUID(), not derived from prompt content the way componentId()
 * and generatedConstraintId() are - a session is an event, not content,
 * so determinism-by-content would be the wrong property here. Gated on
 * generatedAt for the same reason source.timestamp already is: left
 * untouched on a cache-hit re-validate path, so a cached answer's id
 * does not change on every replay.
 *
 * None of these are genuine model judgment for a schema generated from
 * a bare prompt with no code to resolve against - each has exactly one
 * correct answer, always the same one, regardless of what the
 * constraint says. Confirmed by two rounds of live Gemini calls: the
 * general pattern is that Gemini does not reliably echo a fixed-value
 * enum field back correctly, not a defect specific to any one field.
 * status/origin failed 3/3 live attempts; once removed from the request
 * schema, target/reason failed on the very next attempt instead.
 * Removing every field of this shape from the request schema and
 * setting them all here is the fix, rather than continuing to
 * whack-a-mole one field at a time.
 *
 * - status is always 'UNRESOLVED', origin is always 'prose' - see
 *   UNRESOLVED_PROSE_SUBJECT_SCHEMA's docstring.
 * - target is always null and reason is always 'no-candidate' - same
 *   docstring; there is no code yet to resolve a subject against, so
 *   nothing can ever be a real target and there is no reason to report
 *   other than "no-candidate".
 * - provenance is always the literal 'STATED', on every Constraint and
 *   on the ProjectSchema itself - see project-schema.ts and
 *   constraints.ts, both documented as having no code path that ever
 *   produces the other value.
 * - source.line is always null: a one-paragraph prompt has no line to
 *   reference, the same way every real chat-log-sourced fixture in this
 *   codebase already carries line: null for exactly this reason.
 * - source.timestamp is the moment this schema was generated - real,
 *   knowable information the calling code has and the model does not
 *   (it has no access to the actual wall-clock time of its own
 *   inference). Only overwritten when generatedAt is a real timestamp;
 *   left untouched (null argument) on the cache-hit re-validate path, so
 *   a cached answer's already-embedded generation timestamp is never
 *   replaced with the time of a later, unrelated cache hit - see
 *   finalize()'s own doc comment for why that distinction is load-
 *   bearing for this module's determinism guarantee.
 * - similarity is always 0 and alternatives is always [] on
 *   subject/object/via: no candidates were ever compared (there is no
 *   code to resolve against), so there is nothing to score and nothing
 *   to list as a runner-up. Folded in here rather than left as a
 *   request-side constraint after live evidence showed asking Gemini
 *   for them anyway was part of the problem, not a harmless extra ask
 *   — see this file's UNRESOLVED_PROSE_SUBJECT_SCHEMA docstring.
 *
 * `via` gets one further step beyond subject/object: if, after every
 * fixed field above is filled in, `phrase` still is not a usable
 * string, the whole role is replaced with `null` rather than kept as a
 * ResolvedSubject with no real content. This is not inventing a value —
 * `via: null` is already the type's own documented "no via" state
 * (`ResolvedSubject | null`, "Only meaningful for may-only-import-via.
 * Null otherwise."), and it is what Gemini's answer means in practice
 * when it returns an object with none of the one field it was actually
 * asked to generate: a via nobody actually produced. subject/object get
 * no equivalent fallback — both are required, non-nullable content with
 * no "empty but valid" state, so a missing phrase there stays a real
 * validateProjectSchema rejection instead of being silently discarded.
 *
 * Defensive about shape, like rewriteComponentIds: this runs on an
 * unknown value before validateProjectSchema, so anything that doesn't
 * look like a well-formed constraint/subject/source is left untouched
 * and reported by the real validator instead of guessed at here.
 */
function fillFixedConstraintFields(
  candidate: unknown,
  generatedAt: string | null,
  onViaFallback?: () => void,
): unknown {
  if (typeof candidate !== 'object' || candidate === null) return candidate;
  const obj = candidate as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...obj,
    provenance: 'STATED',
    ...(generatedAt === null ? {} : { sessionId: randomUUID() }),
  };

  const constraints = obj['constraints'];
  if (Array.isArray(constraints)) {
    next['constraints'] = constraints.map((constraint) =>
      fillOneConstraintFixedFields(constraint, generatedAt, onViaFallback),
    );
  }

  return next;
}

function fillOneConstraintFixedFields(
  constraint: unknown,
  generatedAt: string | null,
  onViaFallback?: () => void,
): unknown {
  if (typeof constraint !== 'object' || constraint === null) return constraint;
  const c = constraint as Record<string, unknown>;
  const next: Record<string, unknown> = { ...c, provenance: 'STATED' };

  for (const role of ['subject', 'object', 'via'] as const) {
    next[role] = fillResolvedSubjectFixedFields(c[role], role === 'via', role === 'via' ? onViaFallback : undefined);
  }

  const source = c['source'];
  if (typeof source === 'object' && source !== null) {
    const sourceObj = source as Record<string, unknown>;
    next['source'] =
      generatedAt === null
        ? { ...sourceObj, line: null }
        : { ...sourceObj, line: null, timestamp: generatedAt };
  }

  return next;
}

function fillResolvedSubjectFixedFields(
  roleValue: unknown,
  canFallBackToNull: boolean,
  onFallback?: () => void,
): unknown {
  if (typeof roleValue !== 'object' || roleValue === null) return roleValue;
  const filled: Record<string, unknown> = {
    ...(roleValue as Record<string, unknown>),
    status: 'UNRESOLVED',
    target: null,
    origin: 'prose',
    reason: 'no-candidate',
    similarity: 0,
    alternatives: [],
  };

  if (canFallBackToNull && !isNonEmptyString(filled['phrase'])) {
    // The exact point the via-null-fallback decision is made - see
    // CreateProjectSchemaGeneratorOptions.onViaFallback's own doc comment
    // for why this needs to be observed here rather than inferred later.
    onFallback?.();
    return null;
  }

  return filled;
}

/**
 * Recomputes every constraint's id via generatedConstraintId(...), discarding
 * whatever id the model produced — the same pattern as rewriteComponentIds
 * above, for the same reason: a fine-tuned model does not reliably follow
 * project-schema.ts's content-derived-id contract on its own, and a real
 * generation exposed this on a constraint for the first time on 2026-08-31
 * (id "c966666666666666", the identical repeated-digit artifact already
 * documented for component ids — see this file's top docstring).
 *
 * Runs LAST, after fillFixedConstraintFields, deliberately — not merged into
 * the same pass as rewriteComponentIds up front. generatedConstraintId's
 * inputs include source.line, and fillFixedConstraintFields is what
 * guarantees source.line is the real, normalized value (always null for a
 * bare-prompt generation) rather than whatever raw, possibly-absent value
 * the model happened to produce. Computing the id before that normalization
 * would hash an intermediate value nothing else in the codebase ever
 * computes an id from — compile.ts's constraintId and compile-constraints.ts's
 * compiledConstraintId both run only on a fully-formed Constraint. Running
 * last here matches that: by this point subject.phrase/object.phrase/rawText/
 * source.location/source.line are all in their final form, so the id is
 * stable across two generations of the same prompt the same way component
 * ids already are — confirmed directly: source.timestamp (not part of the id
 * formula) is the only field observed to differ between two real, independent
 * generations of the same prompt.
 *
 * Defensive about shape, like rewriteComponentIds and fillFixedConstraintFields:
 * this runs on an unknown value before validateProjectSchema, so a
 * constraint that doesn't look well-formed enough to hash is left with
 * whatever id it already had and reported by the real validator instead of
 * guessed at here.
 */
function rewriteConstraintIds(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null) return candidate;
  const obj = candidate as Record<string, unknown>;
  const constraints = obj['constraints'];
  if (!Array.isArray(constraints)) return candidate;

  return { ...obj, constraints: constraints.map(rewriteOneConstraintId) };
}

function rewriteOneConstraintId(constraint: unknown): unknown {
  if (typeof constraint !== 'object' || constraint === null) return constraint;
  const c = constraint as Record<string, unknown>;

  const relation = c['relation'];
  const rawText = c['rawText'];
  const subject = c['subject'];
  const object = c['object'];
  const source = c['source'];

  if (
    typeof relation !== 'string' ||
    typeof rawText !== 'string' ||
    typeof subject !== 'object' ||
    subject === null ||
    typeof object !== 'object' ||
    object === null ||
    typeof source !== 'object' ||
    source === null
  ) {
    return constraint;
  }

  const subjectPhrase = (subject as Record<string, unknown>)['phrase'];
  const objectPhrase = (object as Record<string, unknown>)['phrase'];
  const location = (source as Record<string, unknown>)['location'];
  const line = (source as Record<string, unknown>)['line'];

  if (typeof subjectPhrase !== 'string' || typeof objectPhrase !== 'string' || typeof location !== 'string') {
    return constraint;
  }

  return {
    ...c,
    id: generatedConstraintId(relation, subjectPhrase, objectPhrase, rawText, location, line),
  };
}

/**
 * Same content-derivation scheme constraintId (src/conformance/compile.ts)
 * and compiledConstraintId (compile-constraints.ts) both already follow,
 * applied a third time rather than inventing a fourth id scheme: sha256 over
 * the fields that determine identity, NUL-joined, truncated to 16 hex
 * characters — matching both functions' choices exactly, so all three
 * origins of a Constraint (extracted from a document, compiled from a
 * workflow graph, or generated from a prompt) produce comparable ids for
 * comparable content.
 *
 * `relation` is typed as `string`, not `ConstraintRelation`, unlike the other
 * two functions' signatures — deliberately looser. Both of those run only on
 * a relation already confirmed valid by their own pipeline; this one runs
 * defensively, before validateProjectSchema, on a relation that has not been
 * checked yet. Hashing an invalid relation string is harmless (the real
 * validator rejects it regardless of what id it carries) and keeps this
 * function's defensiveness consistent with rewriteOneConstraintId's own
 * unknown-shaped input above it.
 */
function generatedConstraintId(
  relation: string,
  subject: string,
  object: string,
  rawText: string,
  location: string,
  line: unknown,
): string {
  return createHash('sha256')
    .update([relation, subject.toLowerCase(), object.toLowerCase(), rawText, location, String(line)].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
