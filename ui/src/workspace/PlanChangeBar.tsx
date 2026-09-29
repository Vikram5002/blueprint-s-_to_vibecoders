import { useState, type FormEvent } from 'react';

interface PlanChangeBarProps {
  /** Re-plans with this change; resolves with an error message, or null once the new plan is shown. */
  readonly onRevise: (change: string) => Promise<string | null>;
  readonly disabled?: boolean;
  /** What to do when the plan is right, shown while nothing is being changed. */
  readonly readyHint?: string;
}

/**
 * "Change the plan" - shown under a plan before its application is
 * generated. A person asks for a change in words; the plan is generated
 * again from the prompt plus that change (src/workflow/revise-plan-prompt.ts)
 * and replaces this one in place. Generating the application stays a
 * separate, deliberate click.
 */
export function PlanChangeBar({
  onRevise,
  disabled = false,
  readyHint = 'Happy with the plan? Generate the application below. Otherwise describe a change here.',
}: PlanChangeBarProps): JSX.Element {
  const [change, setChange] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (change.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onRevise(change);
    setBusy(false);
    if (failure === null) setChange('');
    else setError(failure);
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="plan-change-bar"
      className="flex flex-shrink-0 flex-col gap-1 border-t border-slate-800 bg-slate-950 px-4 py-2"
    >
      <div className="flex gap-2">
        <input
          type="text"
          value={change}
          onChange={(event) => setChange(event.target.value)}
          placeholder="Change the plan, e.g. add a restaurant dashboard page, remove the admin panel..."
          disabled={busy || disabled}
          data-testid="plan-change-input"
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
        />
        <button
          type="submit"
          disabled={busy || disabled || change.trim() === ''}
          data-testid="plan-change-submit"
          className="rounded-lg border border-sky-700 bg-sky-900/40 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-800/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Updating plan…' : 'Update plan'}
        </button>
      </div>
      <div className="text-[11px] text-slate-500">
        {error !== null ? (
          <span className="text-red-300">Plan not changed: {error}</span>
        ) : busy ? (
          'Re-planning with your change - the current plan stays until the new one is ready.'
        ) : (
          readyHint
        )}
      </div>
    </form>
  );
}
