import { useState, type FormEvent } from 'react';
import { Icon } from '../design/Icon';

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
      className="flex flex-shrink-0 flex-col gap-1.5 px-4 py-3"
    >
      <div className="focus-glow flex items-center gap-2 rounded-xl border border-white/[0.08] bg-black/[0.22] pl-3 pr-1.5">
        <Icon name="wand" size={14} className="flex-shrink-0 text-violet-300" />
        <input
          type="text"
          value={change}
          onChange={(event) => setChange(event.target.value)}
          placeholder="Change the plan, e.g. add a restaurant dashboard page, remove the admin panel..."
          disabled={busy || disabled}
          data-testid="plan-change-input"
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-slate-100 placeholder:text-slate-500 focus-visible:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || disabled || change.trim() === ''}
          data-testid="plan-change-submit"
          className="btn btn-secondary btn-sm"
        >
          {busy && <span className="spinner !h-3 !w-3" />}
          {busy ? 'Updating plan…' : 'Update plan'}
        </button>
      </div>
      <div className="px-1 text-[11px] leading-relaxed text-slate-500">
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
