/**
 * Layer 3, Milestone 1: turns one ProjectSchema `Component` into one real
 * TypeScript source file.
 *
 * Same shape as `workflow/generate-project-schema.ts`'s generator — one
 * `CompletionProvider.complete()` call, a fixed system prompt, a cache keyed
 * by exact input, a `Result<T, Failure>` return, and (originally) the plan
 * was to skip `schema` entirely and ask for a fenced code block instead,
 * since the answer here is source code, not data.
 *
 * That plan did not survive contact with a real call: `llm/gemini.ts` sets
 * `responseMimeType: 'application/json'` unconditionally, schema or not (see
 * its `complete()`), so an unschema'd request still gets forced into JSON —
 * a live Milestone 1 run got back `{"code": "import ..."}` with no fence at
 * all. Rather than special-case Gemini, this asks for the same single-field
 * JSON object every provider can produce reliably: `{ "code": "<file
 * contents>" }`, constrained by COMPONENT_CODE_JSON_SCHEMA below. Anthropic
 * (schema optional) and Gemini (schema effectively mandatory) both end up
 * doing the same thing this way, and the ProjectSchema pattern of
 * "constrain the shape, then still validate what comes back" applies here
 * unchanged.
 */
import type { CompletionProvider } from '../llm/provider.js';
import { cacheKey, type LabelCache } from '../llm/cache.js';
import { type Result, ok, err } from '../types/result.js';
import type { Component, DomainName } from '../types/project-schema.js';
import type { Constraint } from '../types/constraints.js';

/**
 * Fixed task-framing prompt, the code-generation sibling of
 * PROJECT_SCHEMA_SYSTEM_PROMPT. Stays separate from that constant rather than
 * being derived from it — the two ask for structurally different answers
 * (a ProjectSchema object vs. one source file) and have no shared wording
 * worth factoring out.
 */
export const COMPONENT_CODE_SYSTEM_PROMPT = `You write one real TypeScript source file implementing a single component of
a software project already planned as a ProjectSchema. You are given the
component's name, its purpose, its domain, the file it must be written to,
which other files (if any) it is allowed to import from, and any
architectural constraints already declared for this project.

Follow the component's stated purpose exactly - implement what it says, not
more. Import only from the paths you are explicitly told you may import
from, plus the npm packages already named as available. Do not invent new
npm dependencies, do not add authentication, logging, retry logic, or error
handling beyond what the purpose itself describes, and do not scaffold
anything for a domain other than the one this component belongs to.

Always use named exports. Never use a default export, under any
circumstances - not "export default function", not "export default" on its
own line, nothing. Every file this project generates is written by a
separate, independent request exactly like this one, so a default export
gives a consuming file nothing to check its guess against; a named export
fails loudly and specifically (a missing- or wrong-named-export compiler
error naming the exact identifier) if a consuming file gets it wrong, which
is far more debuggable than a default-export shape mismatch. If you are told
which other files you may import from, you will also be told each one's
REAL exported names - use exactly those identifiers, never a name you
invent or guess.

Reply with exactly one JSON object matching the schema you were given: a
single "code" field whose string value is the complete, literal contents of
the file - real newlines and indentation as they would appear on disk, not
markdown, not a fenced code block, and no text outside that one field.`;

/**
 * Room for one component file. Originally 2,048 - generous for the small
 * router/middleware files Milestone 1 tested, but a real Milestone 3 scale
 * run truncated a frontend page combining two fetch calls with
 * grouping/rendering logic ("the answer was cut off at the output token
 * limit"), a real generation failure, not a design flaw. Raised to 4,096 to
 * match `workflow/generate-project-schema.ts`'s own budget for a whole
 * multi-domain ProjectSchema - one moderately complex page or route should
 * comfortably fit in what that module allows for an entire schema.
 */
const MAX_OUTPUT_TOKENS = 4_096;

const COMPONENT_CODE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
  },
  required: ['code'],
  additionalProperties: false,
} as const;

export interface ComponentGenerationContext {
  readonly schemaTitle: string;
  readonly component: Component;
  readonly domain: DomainName;
  /** Repo-relative path (posix separators) this file will be written to. */
  readonly targetPath: string;
  /**
   * Repo-relative paths (posix separators) this component may import from,
   * already resolved from its domain's real `dependsOn` — never bare domain
   * names, since there is no domain-named module for a component to import.
   */
  readonly allowedImportPaths: readonly string[];
  /**
   * Real backend HTTP routes this component may call over the network - not
   * a file to import. Frontend components never receive `allowedImportPaths`
   * across the frontend/backend boundary (a browser bundle cannot import an
   * Express Router object), so this is how a frontend component is told the
   * REAL, already-generated route to call instead of guessing one. Empty
   * for every non-frontend domain in Milestone 2, and empty for a frontend
   * component whose schema declares no backend dependency.
   */
  readonly httpEndpoints?: readonly string[];
  /** npm packages already in the generated package.json, available to import. */
  readonly availablePackages: readonly string[];
  /** One line of guidance on the required export shape, e.g. "export default an Express Router". */
  readonly exportContract: string;
  /**
   * Constraints whose subject or object phrase plausibly names this
   * component's domain — see selectRelevantConstraints. Included so the
   * model can be checked for consistency with what the project already
   * promised, even though nothing here enforces it; enforcement is
   * Blueprint's job, run after the file exists (Milestone 1 §4).
   */
  readonly relevantConstraints: readonly Constraint[];
  /**
   * The REAL exported identifiers of each file named in `allowedImportPaths`,
   * extracted from that file's actual generated content (see
   * `extractNamedExports` below) - never a guess, never the domain's generic
   * export-shape contract restated. This is the fix for the cross-file
   * export-convention mismatch found live (see docs/GENERATION.md): before
   * this field existed, a component was told WHICH file it could import but
   * never WHAT that file actually exported, so two independently-generated
   * files could each guess a different, incompatible shape for the other.
   * Empty or omitted for a component with no allowed imports, or when the
   * dependency file has not been generated yet (should not happen given the
   * fixed domain processing order, but never assumed).
   */
  readonly dependencyExports?: readonly DependencyExportInfo[];
  /**
   * Milestone 3's auto-regeneration retry: present only on the one retried
   * call for a component whose first attempt violated a constraint,
   * verified for real against the actually-written file (never on the
   * first attempt for any component - a component with no prior violation
   * has nothing to correct). Carries the exact evidence Blueprint found,
   * not a paraphrase, so the model sees precisely what it did wrong -
   * "your previous attempt did this, which violates this stated rule" per
   * the approved design, not a vague "try again."
   */
  readonly priorViolation?: PriorViolationContext;
}

export interface DependencyExportInfo {
  /** The exact import specifier the consuming file was told it may use, e.g. "../db/recipe-store". */
  readonly importPath: string;
  /** Every named export `extractNamedExports` found in that file's real, already-generated content. */
  readonly exportedNames: readonly string[];
}

export interface PriorViolationContext {
  /** The exact constraint sentence violated, verbatim - same rawText a fresh generation already sees. */
  readonly ruleText: string;
  /** Blueprint's own plain-language explanation of the violation. */
  readonly explanation: string;
  /** The real offending line(s) from the previous attempt, file + line + literal snippet - never paraphrased. */
  readonly evidence: readonly { readonly file: string; readonly line: number; readonly snippet: string }[];
}

export type ComponentCodeFailure =
  | { readonly reason: 'provider-error'; readonly message: string; readonly retryable?: boolean }
  /** The provider's reply had no fenced code block to extract at all. */
  | { readonly reason: 'unparseable-json'; readonly message: string }
  /** Parsed, but `code` was missing, non-string, or empty after trimming. */
  | { readonly reason: 'empty-code'; readonly message: string };

export interface ComponentCodeGenerator {
  generate(context: ComponentGenerationContext): Promise<Result<string, ComponentCodeFailure>>;
}

export interface CreateComponentCodeGeneratorOptions {
  readonly provider: CompletionProvider;
  readonly cache: LabelCache;
}

const CODE_CACHE_FINGERPRINT = JSON.stringify(COMPONENT_CODE_JSON_SCHEMA);

export function createComponentCodeGenerator(options: CreateComponentCodeGeneratorOptions): ComponentCodeGenerator {
  return {
    generate: async (context: ComponentGenerationContext): Promise<Result<string, ComponentCodeFailure>> => {
      const user = buildUserPrompt(context);
      const key = cacheKey({
        model: options.provider.model,
        system: COMPONENT_CODE_SYSTEM_PROMPT,
        user,
        schema: CODE_CACHE_FINGERPRINT,
      });

      const cached = options.cache.get(key);
      if (cached !== undefined && cached.description !== null) {
        return ok(cached.description);
      }

      const completion = await options.provider.complete({
        system: COMPONENT_CODE_SYSTEM_PROMPT,
        user,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        schema: COMPONENT_CODE_JSON_SCHEMA,
        temperature: 0,
        // Writing one file from a stated purpose is a judgement call about
        // what the purpose implies, the same tier createProjectSchemaGenerator
        // uses for deciding what a whole project needs across four domains.
        effort: 'medium',
      });

      if (!completion.ok) {
        return err({
          reason: 'provider-error',
          message: completion.error.message,
          ...(completion.error.kind === 'unavailable' && completion.error.retryable !== undefined
            ? { retryable: completion.error.retryable }
            : {}),
        });
      }

      const extracted = extractCode(completion.value.text);
      if (!extracted.ok) return extracted;

      options.cache.set(key, {
        label: 'component-code',
        description: extracted.value,
        model: completion.value.model,
        promptTokens: completion.value.usage.promptTokens,
        completionTokens: completion.value.usage.completionTokens,
        createdAt: new Date().toISOString(),
      });

      return ok(extracted.value);
    },
  };
}

/**
 * Structured, not free prose - every field the model needs is its own
 * labelled line, the same posture PROJECT_SCHEMA_SYSTEM_PROMPT's caller takes
 * with `user` being the caller's prompt verbatim: here the "prompt" is
 * assembled by this function from typed fields, so it is built the same way
 * on every call for the same component, which is what makes the cache key
 * meaningful.
 */
function buildUserPrompt(context: ComponentGenerationContext): string {
  const lines: string[] = [
    `Project: ${context.schemaTitle}`,
    `Component: ${context.component.name}`,
    `Domain: ${context.domain}`,
    `Purpose: ${context.component.purpose}`,
    `Target file: ${context.targetPath}`,
    `Required export shape: ${context.exportContract}`,
    `Available npm packages: ${context.availablePackages.length > 0 ? context.availablePackages.join(', ') : '(none)'}`,
    context.allowedImportPaths.length > 0
      ? `Allowed local imports: ${context.allowedImportPaths.join(', ')}`
      : 'Allowed local imports: none - this file must have no local (relative) imports',
  ];

  if (context.dependencyExports !== undefined && context.dependencyExports.length > 0) {
    lines.push(
      'Each allowed import path above already exists on disk - these are its REAL exported names, ' +
        'extracted directly from the real file, not a guess. Import only these exact identifiers as named ' +
        'imports; never assume a default export, never invent a name that is not listed:',
    );
    for (const dep of context.dependencyExports) {
      lines.push(
        dep.exportedNames.length > 0
          ? `- ${dep.importPath} exports: ${dep.exportedNames.join(', ')}`
          : `- ${dep.importPath} exports: (none found - do not import anything from this file)`,
      );
    }
  }

  if (context.httpEndpoints !== undefined && context.httpEndpoints.length > 0) {
    lines.push(
      `Real backend HTTP endpoints you may call over the network (fetch by URL, never import as a file): ${context.httpEndpoints.join(', ')}`,
    );
  }

  if (context.relevantConstraints.length > 0) {
    lines.push('Architectural constraints already declared for this project (do not violate these):');
    for (const constraint of context.relevantConstraints) {
      lines.push(`- ${constraint.rawText}`);
    }
  } else {
    lines.push('Architectural constraints already declared for this project: none.');
  }

  if (context.priorViolation !== undefined) {
    lines.push(
      '',
      'CORRECTION REQUIRED - your previous attempt at this exact file was already written to disk and ' +
        'checked against the project\'s real architecture. It violated a stated rule:',
      `  Rule violated: ${context.priorViolation.ruleText}`,
      `  What happened: ${context.priorViolation.explanation}`,
      'The exact offending line(s) from your previous attempt:',
      ...context.priorViolation.evidence.map((e) => `  ${e.file}:${e.line}: ${e.snippet}`),
      'Write a new version of this file that still fulfils the purpose above WITHOUT that import or call. ' +
        'Do not repeat the offending line(s) shown above in any form.',
    );
  }

  return lines.join('\n');
}

/** How much of an unusable response to surface in a failure message - enough to diagnose, not the whole payload. */
const SNIPPET_LENGTH = 300;

/**
 * A generated file may itself legitimately contain a stray fenced-code-block
 * marker in a string literal or comment - so this parses the JSON envelope
 * COMPONENT_CODE_JSON_SCHEMA constrains the answer to, the same
 * trust-nothing posture generate-project-schema.ts's finalize() takes with
 * its own JSON.parse, rather than regex-scraping the raw text for a fence
 * that a schema-constrained response is not expected to contain at all.
 */
function extractCode(text: string): Result<string, ComponentCodeFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err({
      reason: 'unparseable-json',
      message: `response was not valid JSON (${String(cause)}); first ${SNIPPET_LENGTH} chars: ${text.slice(0, SNIPPET_LENGTH)}`,
    });
  }

  const code = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['code'] : undefined;
  if (typeof code !== 'string' || code.trim() === '') {
    return err({ reason: 'empty-code', message: `"code" field was missing, non-string, or empty: ${JSON.stringify(parsed).slice(0, SNIPPET_LENGTH)}` });
  }
  return ok(code.endsWith('\n') ? code : `${code}\n`);
}

/**
 * Selects the constraints a component's generation should see: those whose
 * subject or object phrase plausibly names one of the given keywords - the
 * component's domain name plus the real directory name(s) that domain's
 * files live under. Directory names matter alongside the domain name because
 * a constraint is phrased in terms of real, resolvable paths (see
 * generate-project.ts's BACKEND_MIDDLEWARE_MUST_NOT_IMPORT_ROUTES), not bare
 * domain words - a constraint whose subject is "backend/src/middleware" has
 * no "security" substring even though it is exactly the constraint the
 * security domain's components need to see.
 *
 * Naive substring match, deliberately - a false positive costs nothing (the
 * model just sees an irrelevant constraint), a false negative means a
 * component generates with no awareness of a rule that does apply to it,
 * which is the worse failure per the same precision-over-recall reasoning
 * generate-project-schema.ts already uses for its own heuristics.
 */
/**
 * Regex-based extraction of a TypeScript file's named exports - deliberately
 * not a real parse: this project already vendors `web-tree-sitter` for its
 * own measurement pipeline, but pulling that into a code-generation helper
 * for "what identifiers does this one file export" is a real dependency for
 * a narrow, good-enough job regex already does, given every file this runs
 * against is itself generated to the single named-exports-only convention
 * `COMPONENT_CODE_SYSTEM_PROMPT` now mandates. Covers `export function`,
 * `export async function`, `export const/let/var`, `export class`, `export
 * interface`, `export type`, and `export { a, b as c }` (including a `type`
 * modifier inside the braces). Does not attempt to parse a multi-declarator
 * statement (`export const a = 1, b = 2`) beyond its first identifier - an
 * accepted gap the same "false negative is worse than false positive"
 * reasoning `selectRelevantConstraints` already documents does not apply
 * here in reverse, since a generated file is expected to declare one export
 * per statement anyway, per this project's own generation prompt.
 */
export function extractNamedExports(source: string): readonly string[] {
  const names = new Set<string>();

  const declarationPatterns = [
    /export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /export\s+type\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of declarationPatterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }

  const braceExportPattern = /export\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(braceExportPattern)) {
    const body = match[1] ?? '';
    for (const rawItem of body.split(',')) {
      const item = rawItem.trim().replace(/^type\s+/, '');
      if (item === '') continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(item);
      if (asMatch?.[2] !== undefined) {
        names.add(asMatch[2]);
        continue;
      }
      const identifierMatch = /^[A-Za-z_$][\w$]*$/.exec(item);
      if (identifierMatch !== null) names.add(item);
    }
  }

  return [...names].sort();
}

export function selectRelevantConstraints(
  constraints: readonly Constraint[],
  keywords: readonly string[],
): readonly Constraint[] {
  const needles = keywords.map((keyword) => keyword.toLowerCase());
  return constraints.filter((constraint) =>
    needles.some(
      (needle) =>
        constraint.subject.phrase.toLowerCase().includes(needle) ||
        constraint.object.phrase.toLowerCase().includes(needle),
    ),
  );
}
