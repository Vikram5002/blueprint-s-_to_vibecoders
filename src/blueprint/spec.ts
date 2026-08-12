/**
 * Two outputs from one compiled blueprint: a human-readable spec, and the
 * machine-readable constraint set an agent (or the MCP server) consumes.
 *
 * The JSON output is deliberately just `Constraint[]`, serialised with no
 * envelope specific to "blueprint" — it is the same shape
 * `conformance/compile.ts` produces from prose, byte for byte. That is the
 * whole point of Part B: a consumer downstream of this file cannot tell an
 * authored constraint from an extracted one by its JSON shape, only by
 * `source.type`. Two different shapes would mean two systems.
 */
import type { BlueprintRejection } from './dsl.js';
import type { Constraint } from '../types/constraints.js';

const RELATION_PROSE: Readonly<Record<Constraint['relation'], (c: Constraint) => string>> = {
  'must-not-import': (c) => `**${c.subject.phrase}** must not import **${c.object.phrase}**.`,
  'may-only-import-via': (c) =>
    `**${c.subject.phrase}** may only import **${c.object.phrase}** via **${c.via?.phrase ?? '?'}**.`,
  'must-not-cycle': (c) => `**${c.subject.phrase}** must not participate in an import cycle.`,
  'must-be-layer-above': (c) => `**${c.subject.phrase}** must sit above **${c.object.phrase}** — edges may run down, never up.`,
};

/** The same shape `IntentResult.constraints` carries — pure `Constraint[]`, no envelope. */
export function blueprintConstraintsJson(constraints: readonly Constraint[]): string {
  return JSON.stringify(constraints, null, 2);
}

/**
 * A markdown spec for handing to an agent as context. Deterministic in
 * constraint order (already sorted by id from `compileBlueprint`) so the same
 * blueprint always renders the same document.
 */
export function renderBlueprintSpec(
  constraints: readonly Constraint[],
  rejected: readonly BlueprintRejection[] = [],
): string {
  const lines: string[] = [
    '# Architectural blueprint',
    '',
    'Authored constraints, compiled from the blueprint DSL. These are STATED — a',
    'human decision about how this codebase should be structured, not a fact',
    'traced from an import statement. Verify generated code against them by',
    're-running this tool; do not assume compliance from this document alone.',
    '',
  ];

  if (constraints.length === 0) {
    lines.push('_No constraints compiled from this blueprint._', '');
  } else {
    lines.push(`${constraints.length} constraint(s):`, '');
    for (const constraint of constraints) {
      const unresolved = [constraint.subject, constraint.object, constraint.via].some(
        (role) => role !== null && role.status === 'UNRESOLVED',
      );
      const prose = RELATION_PROSE[constraint.relation](constraint);
      const flag = unresolved ? ' ⚠ unresolved role — cannot be checked' : '';
      lines.push(`- ${prose}${flag}`);
      lines.push(`  \`${constraint.rawText}\` — ${constraint.source.location}:${constraint.source.line ?? '?'}`);
    }
    lines.push('');
  }

  if (rejected.length > 0) {
    lines.push(`## Lines that did not compile (${rejected.length})`, '');
    for (const rejection of rejected) {
      lines.push(`- line ${rejection.line} (\`${rejection.reason}\`): \`${rejection.text}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}
