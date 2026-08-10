/**
 * The four read-only tools an agent can call.
 *
 * ## Read-only, and structurally so
 *
 * There is no write path here — not a disabled one, not a guarded one. The
 * handlers receive an `AnalysisContext` and return plain data; none of them
 * takes a store, opens a file for writing, or reaches the corrections API.
 * Adding write access would mean adding a dependency this module does not
 * have, which is the point: it is a deliberate, visible change rather than a
 * flag someone flips.
 *
 * ## Provenance on every response (rule 2)
 *
 * Every object that leaves here is labelled. Graph nodes and edges are
 * DERIVED, constraints are STATED, and `check_import`'s verdict is a
 * COMPARISON. An agent consuming this has no other way to tell a traced import
 * from a sentence someone wrote in a README, and the whole value of the tool
 * collapses if it treats them alike.
 */
import { checkImport } from './check-import.js';
import { fileEdgesFrom } from '../conformance/graph-adapter.js';
import { buildViolationsResponse } from '../server/violations-api.js';
import { buildIntentResponse } from '../server/intent-api.js';
import type { AnalysisContext } from '../server/context.js';
import type { Severity } from '../types/violations.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Descriptions are written for a model deciding whether to call, not for a
 * human reading docs — so each says *when* to reach for it, not just what it
 * returns. `check_import` says so most loudly because it is the one that has
 * to fire before a line is written rather than after.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'check_import',
    description:
      'Check whether one module or file is allowed to import another, according to the ' +
      'architectural rules this repository states about itself. Call this BEFORE writing an ' +
      'import line, not after. Returns "allowed", "forbidden" (with the sentence that forbids ' +
      'it and where it was written), or "cannot-determine" when a path does not resolve or a ' +
      'relevant rule could not be evaluated — treat "cannot-determine" as unanswered, never as ' +
      'permission. Accepts file paths, directories, or module ids.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The importing file, directory or module.' },
        to: { type: 'string', description: 'The file, directory or module being imported.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_architecture',
    description:
      'The architecture actually derived from this repository\'s import statements: modules, ' +
      'the dependencies between them, and the files in each. Everything returned is DERIVED — ' +
      'traced to a real import in a real file — never inferred or claimed. Use it to orient ' +
      'before making a change.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['module', 'file'],
          description:
            'module (default): one node per clustered module. file: one node per source file, ' +
            'which is large on big repositories.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_violations',
    description:
      'Where the code and the documentation disagree: import edges that break a rule the ' +
      'repository states about itself. Each carries the sentence, its location, the offending ' +
      'import lines, and a severity. Optionally filter by severity.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Return only violations at this severity. Omit for all.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_constraints',
    description:
      'The architectural rules this repository states about itself, extracted from its prose ' +
      '(READMEs, CLAUDE.md/AGENTS.md, ADRs, chat logs). Everything returned is STATED — a claim ' +
      'someone wrote, which may be stale, aspirational, or wrong. Also reports how many ' +
      'architectural statements were found but are not checkable against an import graph.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export interface ToolOutcome {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError: boolean;
}

export function callTool(
  context: AnalysisContext,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ToolOutcome {
  switch (name) {
    case 'check_import':
      return handleCheckImport(context, args);
    case 'get_architecture':
      return handleArchitecture(context, args);
    case 'get_violations':
      return handleViolations(context, args);
    case 'get_constraints':
      return handleConstraints(context);
    default:
      return error(`unknown tool "${name}"`);
  }
}

// ---------------------------------------------------------------- handlers

function handleCheckImport(
  context: AnalysisContext,
  args: Readonly<Record<string, unknown>>,
): ToolOutcome {
  const from = args['from'];
  const to = args['to'];
  if (typeof from !== 'string' || typeof to !== 'string') {
    return error('check_import requires string "from" and "to" arguments');
  }

  return ok(
    checkImport({
      from,
      to,
      constraints: context.intent.constraints,
      clustering: context.clustering,
      fileEdges: fileEdgesFrom(context.graph),
      /**
       * Passed, never defaulted. If extraction was degraded or a document
       * failed, "no rule forbids this" is a statement about documents nobody
       * read, and the checker downgrades it to cannot-determine.
       */
      extraction: {
        degraded: context.intent.summary.degraded,
        failures: context.intent.failures.length,
        incompleteDocuments: context.intent.summary.incompleteDocuments,
      },
    }),
  );
}

function handleArchitecture(
  context: AnalysisContext,
  args: Readonly<Record<string, unknown>>,
): ToolOutcome {
  const requested = args['level'];
  if (requested !== undefined && requested !== 'module' && requested !== 'file') {
    return error('get_architecture "level" must be "module" or "file"');
  }
  const level = requested ?? 'module';

  if (level === 'file') {
    return ok({
      level,
      provenance: 'DERIVED',
      files: context.clustering.assignments.map((assignment) => ({
        file: assignment.file,
        module: assignment.moduleId,
        directory: assignment.directory,
      })),
      edges: fileEdgesFrom(context.graph).map((edge) => ({
        from: edge.from,
        to: edge.to,
        importCount: edge.importCount,
        /**
         * Rule 3, held across the MCP boundary. An edge that arrives at an
         * agent without the file and line behind it is an assertion the agent
         * has no way to check, which is the exact failure this project exists
         * to avoid.
         */
        evidence: edge.evidence.map((entry) => ({
          file: entry.file,
          line: entry.line,
          snippet: entry.snippet,
        })),
        provenance: 'DERIVED',
      })),
    });
  }

  return ok({
    level,
    provenance: 'DERIVED',
    modules: context.clustering.modules.map((module) => ({
      id: module.id,
      label: context.labels.labels.get(module.id)?.label ?? module.label,
      /** Where the name came from — a model's guess is not a derived fact. */
      labelSource: context.labels.labels.get(module.id)?.source ?? 'mechanical',
      files: module.files,
      directories: module.directories,
      provenance: 'DERIVED',
    })),
    edges: context.clustering.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      weight: edge.weight,
      importCount: edge.importCount,
      provenance: 'DERIVED',
    })),
    summary: {
      modules: context.clustering.summary.moduleCount,
      files: context.graph.graph.order,
      fileEdges: context.graph.graph.size,
    },
  });
}

function handleViolations(
  context: AnalysisContext,
  args: Readonly<Record<string, unknown>>,
): ToolOutcome {
  const requested = args['severity'];
  if (requested !== undefined && !['high', 'medium', 'low'].includes(String(requested))) {
    return error('get_violations "severity" must be "high", "medium" or "low"');
  }

  const response = buildViolationsResponse(context);
  const violations =
    requested === undefined
      ? response.violations
      : response.violations.filter((violation) => violation.severity === (requested as Severity));

  return ok({
    violations,
    summary: response.summary,
    /**
     * Carried through unchanged. Zero violations because nothing was stated
     * and zero because everything passed are opposite findings, and an agent
     * that cannot tell them apart will read an unmeasured repository as a
     * clean one.
     */
    emptyReason: response.emptyReason,
    unchecked: response.unchecked,
    drift: response.drift,
    filteredBy: requested ?? null,
    provenance: 'COMPARISON',
  });
}

function handleConstraints(context: AnalysisContext): ToolOutcome {
  const response = buildIntentResponse(context);
  return ok({
    constraints: response.constraints,
    emptyReason: response.emptyReason,
    degraded: response.degraded,
    /**
     * Surfaced rather than buried in the summary. This repository's own
     * documents produce roughly twenty architectural statements that cannot be
     * checked for every one that can, and an agent told only about the
     * checkable few would badly misjudge how much of the stated architecture
     * this tool actually covers.
     */
    uncheckable: {
      total: response.summary.uncheckable,
      byReason: response.summary.byUncheckableReason,
      note:
        'These are architectural statements that no import graph can decide — style ' +
        'preferences, process rules, runtime behaviour. They are counted, not enforced.',
    },
    incompleteDocuments: response.summary.incompleteDocuments,
    provenance: 'STATED',
  });
}

// ---------------------------------------------------------------- shaping

function ok(payload: unknown): ToolOutcome {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false };
}

function error(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}
