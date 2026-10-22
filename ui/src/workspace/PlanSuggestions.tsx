import { useState } from 'react';
import { Icon } from '../design/Icon';
import { fetchFeatureSuggestions, type FeatureSuggestion } from './workflow-api-client';

interface PlanSuggestionsProps {
  /** The saved plan the suggestions are for. */
  readonly sessionId: string;
  /** Re-plans with this change; resolves with an error message, or null once the new plan is shown. */
  readonly onRevise: (change: string) => Promise<string | null>;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly suggestions: readonly FeatureSuggestion[] }
  | { readonly kind: 'error'; readonly message: string };

/** One plan change for every ticked suggestion - the same words src/workflow/suggest-features.ts joins. */
function changeFor(chosen: readonly FeatureSuggestion[]): string {
  return `${chosen.map((s) => s.change.replace(/[.\s]+$/, '')).join('. ')}.`;
}

/**
 * "Suggest more features" - shown under a plan before its application is
 * generated. The planner's model proposes features a real app of this kind
 * usually has beyond what was asked; a person ticks the ones they want and
 * they are added through the ordinary plan change. Nothing is added unticked.
 */
export function PlanSuggestions({ sessionId, onRevise }: PlanSuggestionsProps): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    setState({ kind: 'loading' });
    setChosen(new Set());
    try {
      setState({ kind: 'ready', suggestions: await fetchFeatureSuggestions(sessionId) });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function add(suggestions: readonly FeatureSuggestion[]): Promise<void> {
    setBusy(true);
    const failure = await onRevise(changeFor(suggestions.filter((_, index) => chosen.has(index))));
    setBusy(false);
    if (failure === null) setState({ kind: 'idle' });
    else setState({ kind: 'error', message: failure });
  }

  const toggle = (index: number): void =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div data-testid="plan-suggestions" className="flex flex-col gap-2 px-4 py-3">
      {state.kind !== 'ready' && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={state.kind === 'loading'}
            data-testid="plan-suggestions-load"
            className="btn btn-secondary btn-sm"
          >
            {state.kind === 'loading' ? <span className="spinner !h-3 !w-3" /> : <Icon name="sparkles" size={13} />}
            {state.kind === 'loading' ? 'Thinking of features…' : 'Suggest more features'}
          </button>
          <span className="text-[11px] text-slate-500">
            {state.kind === 'error'
              ? <span className="text-red-300">No suggestions: {state.message}</span>
              : 'Ideas a real app of this kind usually has. You choose what to add.'}
          </span>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          <div className="text-[12px] font-medium text-slate-300">Suggested features - tick the ones to add</div>
          <ul className="flex flex-col gap-1.5">
            {state.suggestions.map((suggestion, index) => (
              <li key={suggestion.title}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-black/[0.18] px-3 py-2">
                  <input
                    type="checkbox"
                    checked={chosen.has(index)}
                    onChange={() => toggle(index)}
                    disabled={busy}
                    data-testid="plan-suggestion-option"
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    <span className="text-[13px] text-slate-100">{suggestion.title}</span>
                    <span className="text-[11px] leading-relaxed text-slate-400">{suggestion.why}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void add(state.suggestions)}
              disabled={busy || chosen.size === 0}
              data-testid="plan-suggestions-add"
              className="btn btn-primary btn-sm"
            >
              {busy && <span className="spinner !h-3 !w-3" />}
              {busy ? 'Updating plan…' : `Add ${chosen.size || ''} to the plan`.replace('  ', ' ')}
            </button>
            <button type="button" onClick={() => setState({ kind: 'idle' })} disabled={busy} className="btn btn-ghost btn-sm">
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
