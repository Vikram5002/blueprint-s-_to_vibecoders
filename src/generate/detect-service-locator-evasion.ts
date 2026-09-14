/**
 * Layer 3, Item 3 (approved, see docs/GENERATION.md's "Import-graph
 * verification cannot see behavioral workarounds"): a narrow, Layer-3-only
 * check for the auth-bypass pattern found live in Milestone 3 - a component
 * removing a forbidden STATIC import while keeping the forbidden DEPENDENCY
 * alive through a runtime service-locator lookup (`req.app.get('findUserById')`),
 * which Blueprint's import-graph check cannot see by construction (it only
 * ever resolves a real module specifier to a real file - see
 * `src/parser/extract-ts.ts`'s `collectCallExpression`).
 *
 * This is deliberately NOT a Blueprint feature and NEVER produces a
 * `Violation` - see the doc's own reasoning for why a general, always-on
 * version of this check would false-positive constantly against ordinary,
 * legitimate Express code (`app.get('trust proxy')`, `app.get('view engine')`,
 * `app.get('port')`, `Map.get(key)`, DI containers, ...). What makes THIS
 * version low-false-positive is that it only ever fires when a locator call's
 * string argument spells out the exact, real name of something a stated
 * constraint just forbade this file from importing - never any locator call
 * in general.
 */
import type { GeneratedFile } from './assemble.js';
import type { Constraint } from '../types/constraints.js';
import { extractNamedExports } from './component-codegen.js';

export interface SuspectedServiceLocatorEvasion {
  /** The file containing the suspicious locator call. */
  readonly file: string;
  readonly line: number;
  /** The literal source line, for direct evidence - never paraphrased. */
  readonly snippet: string;
  /** The string literal passed to the locator call, e.g. "findUserById". */
  readonly lookupKey: string;
  /** The real, already-generated file whose real export this key matches. */
  readonly matchedExportFile: string;
  /** The constraint this lookup key's matching file is forbidden by. */
  readonly constraint: Constraint;
}

/**
 * `<anything>.get('name')` / `<anything>.set('name', ...)` - a member-call
 * shape, string-literal first argument. Deliberately permissive about the
 * receiver (`req.app.get`, `app.get`, `container.get`, ...) since the
 * receiver is not what makes this suspicious; the string argument matching a
 * real, forbidden export is. Single- or double-quoted only, matching the
 * quoting style this pipeline's own generated code actually uses - a
 * template-literal or computed key is unresolvable statically and is
 * intentionally never matched (never guess).
 */
const LOCATOR_CALL_PATTERN = /\.(?:get|set)\(\s*['"]([A-Za-z_$][\w$]*)['"]/g;

interface LocatorCall {
  readonly line: number;
  readonly snippet: string;
  readonly key: string;
}

function findLocatorCalls(source: string): readonly LocatorCall[] {
  const calls: LocatorCall[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    LOCATOR_CALL_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(LOCATOR_CALL_PATTERN)) {
      const key = match[1];
      if (key === undefined) continue;
      calls.push({ line: index + 1, snippet: line.trim(), key });
    }
  }
  return calls;
}

/**
 * A `PATH_PATTERN` target is always a glob of the exact shape
 * `<prefix>/**` (see `pathRole`/`resolveSubject`'s `looksLikePath` branch) -
 * never a general glob syntax this needs a library for. Matches the prefix
 * directory itself or anything under it.
 */
function matchesPathPattern(filePath: string, target: string): boolean {
  if (!target.endsWith('/**')) return false;
  const prefix = target.slice(0, -3);
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

/**
 * Scans every generated file against every `must-not-import` constraint
 * whose subject and object both resolved to a real path pattern (the only
 * shape this pipeline's own generated constraints ever take - see
 * `generate-project.ts`'s `compileBlueprint` call sites). For each file
 * under the constraint's subject directory, looks for a locator call whose
 * string key exactly matches a real named export (`extractNamedExports`) of
 * some file under the constraint's forbidden object directory. Other
 * relations (`must-not-cycle`, `must-be-layer-above`, `may-only-import-via`)
 * are out of scope for this narrow check - it only ever answers "did this
 * file's runtime code reference something a must-not-import rule just
 * forbade it from importing", not the more general shapes those relations
 * describe.
 */
export function detectServiceLocatorEvasion(
  files: readonly GeneratedFile[],
  constraints: readonly Constraint[],
): readonly SuspectedServiceLocatorEvasion[] {
  const findings: SuspectedServiceLocatorEvasion[] = [];

  for (const constraint of constraints) {
    if (constraint.relation !== 'must-not-import') continue;
    if (constraint.subject.status !== 'PATH_PATTERN' || constraint.object.status !== 'PATH_PATTERN') continue;
    const subjectTarget = constraint.subject.target;
    const objectTarget = constraint.object.target;
    if (subjectTarget === null || objectTarget === null) continue;

    const subjectFiles = files.filter((f) => matchesPathPattern(f.path, subjectTarget));
    const objectFiles = files.filter((f) => matchesPathPattern(f.path, objectTarget));
    if (subjectFiles.length === 0 || objectFiles.length === 0) continue;

    const forbiddenExports = new Map<string, string>();
    for (const objectFile of objectFiles) {
      for (const name of extractNamedExports(objectFile.contents)) {
        if (!forbiddenExports.has(name)) forbiddenExports.set(name, objectFile.path);
      }
    }
    if (forbiddenExports.size === 0) continue;

    for (const subjectFile of subjectFiles) {
      for (const call of findLocatorCalls(subjectFile.contents)) {
        const matchedExportFile = forbiddenExports.get(call.key);
        if (matchedExportFile === undefined) continue;
        findings.push({
          file: subjectFile.path,
          line: call.line,
          snippet: call.snippet,
          lookupKey: call.key,
          matchedExportFile,
          constraint,
        });
      }
    }
  }

  return findings;
}
