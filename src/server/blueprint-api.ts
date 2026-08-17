/**
 * Type-1 authoring endpoints: Parts A.2 (seed from current) and A.3 (visual
 * editor). The mutating surface is small and deliberate — see context.ts's
 * comment on `blueprintStore` for what these routes are and are not allowed
 * to touch.
 *
 * Every route that produces a `Constraint` funnels through
 * `compileBlueprintText`, which is `compileBlueprint` (dsl.ts) with request
 * plumbing around it — never a second compiler. A visual-editor request
 * carries a `BlueprintGraph`; it is turned into the exact same DSL text a
 * `.txt` file would contain (`graphToDsl`, graph-to-dsl.ts) before compiling,
 * so the compiler never even knows whether a rule was typed or dragged.
 */
import { compileBlueprint, type CompileBlueprintResult } from '../blueprint/dsl.js';
import { graphToDsl, type BlueprintGraph } from '../blueprint/graph-to-dsl.js';
import { seedConstraintsFromDerived } from '../blueprint/seed.js';
import { candidatesFrom } from '../pipeline/intent.js';
import type { AnalysisContext } from './context.js';
import type { Constraint } from '../types/constraints.js';
import type { ConstraintResponse } from './intent-api.js';

const BLUEPRINT_LOCATION = 'blueprint-editor';

export interface BlueprintResponse {
  readonly constraints: readonly ConstraintResponse[];
}

/** The currently-persisted blueprint — whatever the last `--blueprint` run or `save` call left. */
export function buildBlueprintResponse(context: AnalysisContext): BlueprintResponse {
  return { constraints: context.blueprintStore.list().map(toConstraintResponse) };
}

export interface SeedsResponse {
  readonly candidates: readonly ConstraintResponse[];
}

/**
 * Computed fresh from the current clustering on every call, never persisted.
 * A candidate exists only in this response until a client explicitly names
 * its id back through `/api/blueprint/accept-seeds` — see seed.ts's header
 * comment for why that boundary matters.
 */
export function buildSeedsResponse(context: AnalysisContext): SeedsResponse {
  return { candidates: seedConstraintsFromDerived(context.clustering).map(toConstraintResponse) };
}

export type AcceptSeedsResult =
  | { readonly ok: true; readonly accepted: readonly Constraint[] }
  | { readonly ok: false; readonly message: string };

/**
 * Re-derives seeds (never trusts a client-supplied `Constraint` body — the
 * request names only ids) and appends the ones whose id was named. An id
 * naming nothing currently seedable is silently not present in `accepted`
 * rather than rejected outright: the candidate list is inherently a snapshot
 * of a moving graph, and a client racing a re-cluster should not get an
 * error for asking about a candidate that just stopped existing.
 */
export function acceptSeeds(context: AnalysisContext, body: unknown): AcceptSeedsResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'expected an object' };
  }
  const request = body as { ids?: unknown };
  if (!Array.isArray(request.ids) || request.ids.some((id) => typeof id !== 'string')) {
    return { ok: false, message: 'ids must be an array of strings' };
  }

  const requested = new Set(request.ids as string[]);
  if (requested.size === 0) {
    return { ok: false, message: 'ids must name at least one seed' };
  }

  const accepted = seedConstraintsFromDerived(context.clustering).filter((seed) => requested.has(seed.id));
  context.blueprintStore.append(accepted);
  return { ok: true, accepted };
}

export interface CompileRequestResult {
  readonly ok: true;
  readonly dsl: string;
  readonly compiled: CompileBlueprintResult;
}
export interface CompileRequestFailure {
  readonly ok: false;
  readonly message: string;
}

/**
 * Accepts either `{ dsl: string }` (typed authoring) or `{ graph: BlueprintGraph }`
 * (the visual editor). Both paths call the identical `compileBlueprintText`
 * below on the identical text — this function's only job is turning whichever
 * shape arrived into that one string.
 */
export function compileRequest(
  context: AnalysisContext,
  body: unknown,
): CompileRequestResult | CompileRequestFailure {
  const text = requestText(body);
  if (text === null) {
    return { ok: false, message: 'expected { dsl: string } or { graph: BlueprintGraph }' };
  }
  return { ok: true, dsl: text, compiled: compileBlueprintText(context, text) };
}

function requestText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const request = body as { dsl?: unknown; graph?: unknown };

  if (typeof request.dsl === 'string') {
    return request.dsl;
  }
  if (typeof request.graph === 'object' && request.graph !== null) {
    return graphToDsl(request.graph as BlueprintGraph);
  }
  return null;
}

/** The one call site that reaches `compileBlueprint` from the server — see this file's header. */
function compileBlueprintText(context: AnalysisContext, text: string): CompileBlueprintResult {
  const directories = [...new Set(context.clustering.modules.flatMap((module) => module.directories))].sort();
  return compileBlueprint({
    text,
    location: BLUEPRINT_LOCATION,
    modules: candidatesFrom(context.clustering, context.labels),
    directories,
  });
}

export interface SaveResponse {
  readonly ok: true;
  readonly dsl: string;
  readonly constraints: readonly ConstraintResponse[];
  readonly rejected: CompileBlueprintResult['rejected'];
}

/**
 * Compiles and persists in one step — `save` always REPLACES the whole
 * stored blueprint, the same semantics `--blueprint=<file>` has. The visual
 * editor session is the file, as far as this endpoint is concerned.
 */
export function saveRequest(context: AnalysisContext, body: unknown): SaveResponse | CompileRequestFailure {
  const parsed = compileRequest(context, body);
  if (!parsed.ok) {
    return parsed;
  }
  context.blueprintStore.replace(parsed.compiled.constraints);
  return {
    ok: true,
    dsl: parsed.dsl,
    constraints: parsed.compiled.constraints.map(toConstraintResponse),
    rejected: parsed.compiled.rejected,
  };
}

function toConstraintResponse(constraint: Constraint): ConstraintResponse {
  const roles = [constraint.subject, constraint.object, ...(constraint.via === null ? [] : [constraint.via])];
  return {
    id: constraint.id,
    relation: constraint.relation,
    subject: role(constraint.subject),
    object: role(constraint.object),
    via: constraint.via === null ? null : role(constraint.via),
    confidence: constraint.confidence,
    lowConfidence: constraint.lowConfidence,
    evaluable: roles.every((r) => r.status !== 'UNRESOLVED'),
    rawText: constraint.rawText,
    source: {
      type: constraint.source.type,
      location: constraint.source.location,
      line: constraint.source.line,
      timestamp: constraint.source.timestamp,
    },
    provenance: 'STATED',
  };
}

function role(resolved: Constraint['subject']): ConstraintResponse['subject'] {
  return {
    phrase: resolved.phrase,
    status: resolved.status,
    target: resolved.target,
    reason: resolved.reason,
    similarity: resolved.similarity,
  };
}
