/**
 * Proposes a reworked version of ONE existing source file - what the VS Code
 * extension shows as a diff the person keeps or undoes.
 *
 * The model only proposes. What the proposal is checked against is decided
 * here, deterministically: every violating import the analysis found in the
 * file (its exact line and target) is looked for again in the proposed text,
 * so the extension can say "fixed" or "still there" per violation instead of
 * trusting the model's word. That is a quick check on one file; the full
 * Blueprint re-check happens the next time the project is analysed.
 */
import type { CompletionProvider } from '../llm/provider.js';
import { type Result, ok, err } from '../types/result.js';
import { extractCode } from './component-codegen.js';

/** One stated rule this file breaks, with the import lines that break it. */
export interface ReworkViolation {
  readonly ruleText: string;
  readonly explanation: string;
  readonly evidence: readonly { readonly line: number; readonly snippet: string }[];
}

export interface ReworkRequest {
  /** Repo-relative, posix separators. */
  readonly path: string;
  readonly source: string;
  readonly violations: readonly ReworkViolation[];
  /** Every stated rule of the project (raw text), so the rework does not break a different one. */
  readonly rules: readonly string[];
  /** What the person asked for, if anything beyond fixing the violations. */
  readonly instruction?: string;
}

export interface ReworkCheck {
  readonly ruleText: string;
  readonly line: number;
  readonly snippet: string;
  /** What was looked for in the proposal: the import specifier, or the whole line when none could be read. */
  readonly lookedFor: string;
  readonly stillPresent: boolean;
}

export interface ReworkResult {
  readonly proposed: string;
  readonly checks: readonly ReworkCheck[];
  /** True when the proposal is the original text (ignoring trailing whitespace). */
  readonly unchanged: boolean;
}

export type ReworkFailure =
  | { readonly reason: 'nothing-to-do'; readonly message: string }
  | { readonly reason: 'too-large'; readonly message: string }
  | { readonly reason: 'provider-error'; readonly message: string }
  | { readonly reason: 'unparseable-json' | 'empty-code'; readonly message: string };

/** Longer files do not fit in one answer (8k output tokens) and would come back cut off. */
export const MAX_REWORK_SOURCE_CHARS = 40_000;
const MAX_RULES_IN_PROMPT = 40;

export const REWORK_SYSTEM_PROMPT = `You rewrite ONE existing source file of a real project so that it follows the
project's stated architecture rules, and any instruction the developer adds.

Rules for your answer:
- Keep the file's behaviour, its exported names and signatures, and its style.
- Change as little as possible. Do not reformat lines you do not need to touch.
- Remove every import or call listed as a violation; get what it provided another
  way that the rules allow (move the logic, accept it as a parameter, or call a
  module the rules permit). Never import the forbidden module under another name
  or path, and never reach it through a runtime lookup.
- Do not invent modules or files that the developer has not mentioned.
- Answer with JSON only: {"code": "<the complete new file>"}.`;

const REWORK_JSON_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string' } },
  required: ['code'],
  additionalProperties: false,
} as const;

export async function reworkFile(
  provider: CompletionProvider,
  request: ReworkRequest,
): Promise<Result<ReworkResult, ReworkFailure>> {
  const instruction = request.instruction?.trim() ?? '';
  if (request.violations.length === 0 && instruction === '') {
    return err({ reason: 'nothing-to-do', message: 'this file breaks no stated rule; say what should change' });
  }
  if (request.source.length > MAX_REWORK_SOURCE_CHARS) {
    return err({
      reason: 'too-large',
      message: `the file is ${request.source.length} characters; at most ${MAX_REWORK_SOURCE_CHARS} fit in one rework`,
    });
  }

  const completion = await provider.complete({
    system: REWORK_SYSTEM_PROMPT,
    user: buildReworkPrompt(request),
    maxOutputTokens: 8_192,
    schema: REWORK_JSON_SCHEMA,
    temperature: 0,
    effort: 'medium',
  });
  if (!completion.ok) return err({ reason: 'provider-error', message: completion.error.message });

  const extracted = extractCode(completion.value.text);
  if (!extracted.ok) return err({ reason: extracted.error.reason, message: extracted.error.message });

  const proposed = extracted.value;
  return ok({
    proposed,
    checks: checkProposal(request.violations, proposed),
    unchanged: proposed.trimEnd() === request.source.trimEnd(),
  });
}

export function buildReworkPrompt(request: ReworkRequest): string {
  const lines: string[] = [`File: ${request.path}`, ''];
  if (request.violations.length > 0) {
    lines.push('Architecture rules this file breaks (found by static analysis of the real import lines):');
    for (const violation of request.violations) {
      lines.push(`- Rule: ${violation.ruleText}`, `  Why: ${violation.explanation}`);
      for (const e of violation.evidence) lines.push(`  ${request.path}:${e.line}: ${e.snippet}`);
    }
  } else {
    lines.push('Architecture rules this file breaks: none found.');
  }
  const rules = request.rules.slice(0, MAX_RULES_IN_PROMPT);
  lines.push('', rules.length > 0 ? 'All stated rules of this project (do not break any of them):' : 'Stated rules of this project: none.');
  for (const rule of rules) lines.push(`- ${rule}`);
  const instruction = request.instruction?.trim() ?? '';
  if (instruction !== '') lines.push('', `The developer also asks: ${instruction}`);
  lines.push('', 'The current file:', '-----', request.source, '-----');
  return lines.join('\n');
}

/** Each violating import, looked for again in the proposal. */
export function checkProposal(violations: readonly ReworkViolation[], proposed: string): ReworkCheck[] {
  const proposedImports = new Set(importSpecifiers(proposed));
  const proposedLines = new Set(proposed.split(/\r?\n/).map((line) => line.trim()));
  return violations.flatMap((violation) =>
    violation.evidence.map((e) => {
      const specifier = importSpecifiers(e.snippet)[0];
      const lookedFor = specifier ?? e.snippet.trim();
      return {
        ruleText: violation.ruleText,
        line: e.line,
        snippet: e.snippet,
        lookedFor,
        stillPresent: specifier !== undefined ? proposedImports.has(specifier) : proposedLines.has(lookedFor),
      };
    }),
  );
}

const JS_IMPORT = /(?:\bimport\s[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s[^'"]*?\bfrom\s*)['"]([^'"]+)['"]/g;
// Python imports never quote the module, so a quoted line is a JS/TS import, already read above.
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+))[^'"\n]*$/gm;
const PHP_USE = /^\s*use\s+([\w\\]+)/gm;

/** Module specifiers named by import/require/from lines, in order. */
export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(JS_IMPORT)) if (match[1] !== undefined) found.push(match[1]);
  for (const match of source.matchAll(PY_IMPORT)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) found.push(name);
  }
  for (const match of source.matchAll(PHP_USE)) if (match[1] !== undefined) found.push(match[1]);
  return found;
}
