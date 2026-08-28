import type { Constraint, ConformanceResult } from './verification-types';
import {
  deriveOutcome,
  type UnverifiableReason,
  type VerificationInput,
} from './verification-outcome';

export interface VerificationResultPanelProps {
  readonly code: string;
  readonly input: VerificationInput;
}

/**
 * The three-outcome verification display. This is the one component in the
 * whole workspace that must never blur a distinction the rest of the shell
 * can afford to be loose about — see verification-outcome.ts's header
 * comment for how "unverifiable rendering as verified" is made a type error,
 * not a discipline.
 *
 * This switch is the entire contract: each `case` renders a completely
 * separate subtree with its own colour, its own copy, and its own props —
 * there is no shared "isGood: boolean" or "score: number" threaded through
 * all three that a future edit could point at the wrong colour. Getting the
 * wrong branch requires editing this switch, which is a change a reviewer
 * can see, not a runtime value that could drift.
 */
export function VerificationResultPanel(props: VerificationResultPanelProps): JSX.Element {
  const outcome = deriveOutcome(props.input);

  switch (outcome.kind) {
    case 'verified':
      return <VerifiedResult code={props.code} checked={outcome.checked} />;
    case 'violated':
      return <ViolatedResult code={props.code} violations={outcome.violations} />;
    case 'unverifiable':
      return <UnverifiableResult code={props.code} reason={outcome.reason} />;
    default: {
      // Exhaustiveness: adding a fourth VerificationOutcome kind without a
      // case here is a compile error, not a silent fallthrough.
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function CodeBlock({
  code,
  highlightedLines,
}: {
  code: string;
  highlightedLines?: ReadonlySet<number>;
}): JSX.Element {
  const lines = code.split('\n');
  return (
    <pre className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-relaxed">
      <code>
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const isHighlighted = highlightedLines?.has(lineNumber) ?? false;
          return (
            <div
              key={lineNumber}
              className={`-mx-2 flex gap-3 px-2 ${
                isHighlighted ? 'border-l-2 border-red-500 bg-red-500/20' : ''
              }`}
            >
              <span className="w-8 flex-shrink-0 select-none text-right text-slate-600">
                {lineNumber}
              </span>
              <span className="whitespace-pre text-slate-200">{line}</span>
            </div>
          );
        })}
      </code>
    </pre>
  );
}

function StatedChip(): JSX.Element {
  return (
    <span className="rounded border border-violet-500 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
      Stated
    </span>
  );
}

function DerivedChip(): JSX.Element {
  return (
    <span className="rounded border border-sky-500 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
      Derived
    </span>
  );
}

/**
 * VERIFIED: green. Never rendered without the explicit list of what was
 * checked — `checked` is a required prop, and `deriveOutcome` only ever
 * produces this branch with a non-empty list (a zero-checked result routes
 * to `unverifiable` instead). The empty-list branch below is an assertion
 * against that invariant breaking, not a real code path.
 */
function VerifiedResult({
  code,
  checked,
}: {
  code: string;
  checked: readonly Constraint[];
}): JSX.Element {
  return (
    <div
      className="rounded-xl border-2 border-emerald-600 bg-emerald-950/20 p-4"
      data-outcome="verified"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
          Verified
        </span>
        <span className="text-sm text-emerald-300">
          {checked.length} constraint{checked.length === 1 ? '' : 's'} checked and held
        </span>
      </div>

      <CodeBlock code={code} />

      <div className="mt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-400">
          Constraints checked ({checked.length})
        </h3>
        {checked.length === 0 ? (
          <p className="rounded border border-red-600 bg-red-950/40 p-2 text-sm text-red-300">
            Internal error: a &quot;verified&quot; result must never carry an empty checked list.
            This indicates a bug in deriveOutcome, not a real result — please report it.
          </p>
        ) : (
          <ul className="space-y-2">
            {checked.map((constraint) => (
              <li
                key={constraint.id}
                className="rounded-lg border border-violet-700/50 bg-violet-950/20 p-2 text-sm"
              >
                <div className="mb-1 flex items-center gap-2">
                  <StatedChip />
                  <span className="text-xs text-slate-500">
                    {constraint.source.location} · {(constraint.confidence * 100).toFixed(0)}%
                    confidence
                  </span>
                </div>
                <span className="text-slate-200">&quot;{constraint.rawText}&quot;</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * VIOLATION DETECTED: red. Always wins over "unverifiable" — a stated rule
 * that resolved and broke is a stronger fact than "some other rule could
 * not be checked", so this branch renders regardless of what else is true
 * about the result.
 */
function ViolatedResult({
  code,
  violations,
}: {
  code: string;
  violations: ConformanceResult['violations'];
}): JSX.Element {
  const highlightedLines = new Set<number>();
  for (const violation of violations) {
    for (const edge of violation.edges) {
      for (const entry of edge.evidence) {
        highlightedLines.add(entry.line);
      }
    }
  }

  return (
    <div className="rounded-xl border-2 border-red-600 bg-red-950/20 p-4" data-outcome="violated">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-red-600 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
          Violation Detected
        </span>
        <span className="text-sm text-red-300">
          {violations.length} rule{violations.length === 1 ? '' : 's'} broken
        </span>
      </div>

      <CodeBlock code={code} highlightedLines={highlightedLines} />

      <div className="mt-4 space-y-3">
        {violations.map((violation) => (
          <div key={violation.id} className="rounded-lg border border-red-700/60 bg-red-950/30 p-3">
            <div className="mb-2 flex items-center gap-2">
              <StatedChip />
              <span className="text-sm text-slate-200">
                &quot;{violation.constraint.rawText}&quot;
              </span>
            </div>
            <p className="mb-2 text-xs text-slate-400">{violation.explanation}</p>

            <div className="space-y-1">
              {violation.edges.flatMap((edge) =>
                edge.evidence.map((entry, index) => (
                  <div
                    key={`${edge.edgeId}-${index}`}
                    className="flex flex-wrap items-center gap-2 rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs"
                  >
                    <DerivedChip />
                    <span className="text-slate-500">
                      {entry.file}:{entry.line}
                    </span>
                    <code className="text-slate-200">{entry.snippet}</code>
                  </div>
                )),
              )}
            </div>

            <button
              type="button"
              disabled
              title="Not wired up yet"
              className="mt-3 rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Regenerate
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * UNVERIFIABLE: amber, never green, never carrying a checkmark or "held"
 * language anywhere in this branch. The reason text is Layer 4's own
 * distinction (no-constraints vs all-unchecked) surfaced, not recomputed —
 * see verification-outcome.ts.
 */
function UnverifiableResult({
  code,
  reason,
}: {
  code: string;
  reason: UnverifiableReason;
}): JSX.Element {
  const reasonText =
    reason === 'no-constraints'
      ? 'No architectural rules are stated for this codebase, so there was nothing to check this code against. This is not a pass — it is an absence of measurement.'
      : 'Rules were stated, but none could be matched to anything in this codebase, so none could be evaluated against this code.';

  return (
    <div
      className="rounded-xl border-2 border-amber-500 bg-amber-950/20 p-4"
      data-outcome="unverifiable"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber-500 px-3 py-1 text-xs font-bold uppercase tracking-wide text-slate-950">
          Unverified
        </span>
        <span className="text-sm text-amber-300">
          {reason === 'no-constraints' ? 'No rules stated' : 'Rules stated, none checkable'}
        </span>
      </div>

      <CodeBlock code={code} />

      <div className="mt-4 rounded-lg border border-amber-600/60 bg-amber-950/30 p-3 text-sm text-amber-200">
        <p className="mb-1 font-semibold">This code was not verified against anything.</p>
        <p>{reasonText}</p>
      </div>
    </div>
  );
}
