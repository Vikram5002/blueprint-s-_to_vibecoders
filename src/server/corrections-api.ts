/**
 * Correction endpoints.
 *
 * The only mutating surface in the product. Everything else reads a repository;
 * this writes down a decision a person made, which is the one piece of state
 * the tool cannot regenerate.
 *
 * A correction takes effect on the next run rather than immediately: it changes
 * clustering, and re-clustering mid-session would move the graph under the user
 * while they are looking at it. The response says so.
 */
import type { AnalysisContext } from './context.js';
import type { NewCorrection } from '../store/corrections-store.js';
import type { CorrectionKind, SplitSide } from '../types/corrections.js';

export interface CorrectionsResponse {
  readonly corrections: readonly {
    id: string;
    kind: CorrectionKind;
    label: string | null;
    members: readonly string[];
    sides: readonly SplitSide[];
    createdAt: string;
    /** What happened to it on the current run. */
    status: string;
    overlap: number;
    joined: readonly string[];
    left: readonly string[];
    unresolved: readonly string[];
    explanation: string;
  }[];
  readonly summary: {
    readonly total: number;
    readonly applied: number;
    readonly drifted: number;
    readonly orphaned: number;
    readonly unresolvedFiles: number;
  };
}

export function buildCorrectionsResponse(context: AnalysisContext): CorrectionsResponse {
  const outcomes = new Map(context.correctionOutcomes.map((outcome) => [outcome.correctionId, outcome]));

  const corrections = context.store.list().map((correction) => {
    const outcome = outcomes.get(correction.id);
    return {
      id: correction.id,
      kind: correction.kind,
      label: correction.label,
      members: correction.members,
      sides: correction.sides,
      createdAt: correction.createdAt,
      // A correction saved during this session has no outcome yet — it applies
      // on the next run, and saying "pending" is more honest than "applied".
      status: outcome?.status ?? 'pending',
      overlap: outcome?.overlap ?? 0,
      joined: outcome?.joined ?? [],
      left: outcome?.left ?? [],
      unresolved: outcome?.unresolved ?? [],
      explanation: outcome?.explanation ?? 'Saved. Takes effect on the next run.',
    };
  });

  return {
    corrections,
    summary: {
      total: corrections.length,
      applied: context.correctionOutcomes.filter((o) => o.status === 'applied').length,
      drifted: context.correctionOutcomes.filter((o) => o.status === 'applied-with-drift').length,
      orphaned: context.correctionOutcomes.filter((o) => o.status === 'orphaned').length,
      unresolvedFiles: context.correctionOutcomes.reduce((sum, o) => sum + o.unresolved.length, 0),
    },
  };
}

export type CorrectionRequestResult =
  | { readonly ok: true; readonly correction: NewCorrection }
  | { readonly ok: false; readonly message: string };

/**
 * Validates a correction request.
 *
 * Requests name modules; the store records files, because module ids do not
 * survive re-clustering and file paths do. Every named module must exist, and
 * a split's sides must name files that are actually in the module — a request
 * that references something absent is rejected rather than partially applied.
 */
export function parseCorrectionRequest(context: AnalysisContext, body: unknown): CorrectionRequestResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'expected an object' };
  }

  const request = body as {
    kind?: unknown;
    moduleIds?: unknown;
    label?: unknown;
    sides?: unknown;
  };

  if (request.kind !== 'rename' && request.kind !== 'merge' && request.kind !== 'split') {
    return { ok: false, message: 'kind must be rename, merge or split' };
  }

  const moduleIds = Array.isArray(request.moduleIds)
    ? request.moduleIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (moduleIds.length === 0) {
    return { ok: false, message: 'moduleIds must name at least one module' };
  }

  const members: string[] = [];
  for (const moduleId of moduleIds) {
    const module = context.clustering.modules.find((candidate) => candidate.id === moduleId);
    if (module === undefined) {
      return { ok: false, message: `unknown module: ${moduleId}` };
    }
    members.push(...module.files);
  }

  if (request.kind === 'rename' || request.kind === 'merge') {
    if (typeof request.label !== 'string' || request.label.trim() === '') {
      return { ok: false, message: `${request.kind} needs a label` };
    }
    if (request.kind === 'merge' && moduleIds.length < 2) {
      return { ok: false, message: 'merge needs at least two modules' };
    }
    return { ok: true, correction: { kind: request.kind, members, label: request.label.trim() } };
  }

  const sides = parseSides(request.sides);
  if (sides === null || sides.length < 2) {
    return { ok: false, message: 'split needs at least two sides, each with a label and a file list' };
  }

  const owned = new Set(members);
  for (const side of sides) {
    for (const file of side.files) {
      if (!owned.has(file)) {
        return { ok: false, message: `${file} is not in the module being split` };
      }
    }
  }

  return { ok: true, correction: { kind: 'split', members, sides } };
}

function parseSides(raw: unknown): SplitSide[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const sides: SplitSide[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const side = entry as { label?: unknown; files?: unknown };
    if (typeof side.label !== 'string' || side.label.trim() === '' || !Array.isArray(side.files)) {
      return null;
    }
    sides.push({
      label: side.label.trim(),
      files: side.files.filter((file): file is string => typeof file === 'string'),
    });
  }
  return sides;
}
