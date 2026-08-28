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
 * `sessionId` is intentionally left as the model returns it, not overridden
 * the same way. The same held-out eval showed the model frequently echoes a
 * memorized training-time session id (e.g. "session-gold-021") rather than
 * minting a new one — a real, currently-undiagnosed model-quality issue, not
 * something this module silently papers over. A caller that persists a
 * generated schema should mint its own id before storing it.
 */
import type { CompletionProvider } from '../llm/provider.js';
import { cacheKey, type LabelCache } from '../llm/cache.js';
import { type Result, ok, err } from '../types/result.js';
import { DOMAIN_NAMES, type DomainName, type ProjectSchema, componentId } from '../types/project-schema.js';
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
 * real held-out generations (training/held-out-outputs-configC.json). Asking
 * the model for anything else would be asking it to fabricate a resolution
 * it has no basis for.
 */
const UNRESOLVED_PROSE_SUBJECT_SCHEMA = {
  type: 'object',
  properties: {
    phrase: { type: 'string' },
    status: { const: 'UNRESOLVED' },
    target: { const: null },
    origin: { const: 'prose' },
    reason: { const: 'no-candidate' },
    similarity: { const: 0 },
    alternatives: { type: 'array', maxItems: 0 },
  },
  required: ['phrase', 'status', 'target', 'origin', 'reason', 'similarity', 'alternatives'],
  additionalProperties: false,
} as const;

const CONSTRAINT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    relation: { type: 'string', enum: [...CONSTRAINT_RELATIONS] },
    subject: UNRESOLVED_PROSE_SUBJECT_SCHEMA,
    object: UNRESOLVED_PROSE_SUBJECT_SCHEMA,
    via: { anyOf: [UNRESOLVED_PROSE_SUBJECT_SCHEMA, { const: null }] },
    source: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['chat-log', 'agents-md', 'readme', 'adr', 'commit-msg', 'user-authored', 'seeded-from-derived'],
        },
        location: { type: 'string' },
        line: { anyOf: [{ type: 'number' }, { const: null }] },
        timestamp: { anyOf: [{ type: 'string' }, { const: null }] },
      },
      required: ['type', 'location', 'line', 'timestamp'],
      additionalProperties: false,
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    lowConfidence: { type: 'boolean' },
    rawText: { type: 'string' },
    provenance: { const: 'STATED' },
  },
  required: ['id', 'relation', 'subject', 'object', 'via', 'source', 'confidence', 'lowConfidence', 'rawText', 'provenance'],
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
    provenance: { const: 'STATED' },
  },
  required: ['sessionId', 'title', 'originalPrompt', 'domains', 'constraints', 'provenance'],
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
  generate(prompt: string): Promise<Result<ProjectSchema, GenerateFailure>>;
}

export interface CreateProjectSchemaGeneratorOptions {
  readonly provider: CompletionProvider;
  readonly cache: LabelCache;
}

export function createProjectSchemaGenerator(options: CreateProjectSchemaGeneratorOptions): ProjectSchemaGenerator {
  return {
    generate: async (prompt: string): Promise<Result<ProjectSchema, GenerateFailure>> => {
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
        return finalize(cached.description ?? '');
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

      const result = finalize(completion.value.text);
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

function finalize(text: string): Result<ProjectSchema, GenerateFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err({ reason: 'unparseable-json', message: `response was not valid JSON: ${String(cause)}` });
  }

  const validated = validateProjectSchema(rewriteComponentIds(parsed));
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
