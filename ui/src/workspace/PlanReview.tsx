import { PlanChangeBar } from './PlanChangeBar';
import type { ProjectSchema } from './project-schema-types';

const DOMAINS = ['frontend', 'backend', 'database', 'security'] as const;
const DOMAIN_LABEL: Readonly<Record<(typeof DOMAINS)[number], string>> = {
  frontend: 'Pages',
  backend: 'API',
  database: 'Data',
  security: 'Security',
};

interface PlanReviewProps {
  readonly schema: ProjectSchema;
  /** Re-plans with this change; resolves with an error message, or null once the new plan is shown. */
  readonly onRevise: (change: string) => Promise<string | null>;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
}

/**
 * Agent mode's stop between planning and building: the plan in plain words,
 * a box to change it, and the choice to build it or not. Nothing is generated
 * until "Build this plan".
 */
export function PlanReview({ schema, onRevise, onApprove, onCancel }: PlanReviewProps): JSX.Element {
  return (
    <div data-testid="agent-review" className="mt-3 overflow-hidden rounded-xl border border-sky-800/60 bg-sky-950/20">
      <div className="px-3 pt-3 text-xs font-semibold text-sky-200">Review the plan before anything is built</div>
      <div className="px-3 pb-2 pt-1 text-sm font-medium text-slate-100">{schema.title}</div>
      <dl className="space-y-1 px-3 pb-3 text-xs">
        {DOMAINS.map((domain) => (
          <div key={domain} className="flex gap-2">
            <dt className="w-16 shrink-0 text-slate-500">{DOMAIN_LABEL[domain]}</dt>
            <dd className="text-slate-300">
              {schema.domains[domain].components.length === 0 ? '-' : schema.domains[domain].components.map((component) => component.name).join(', ')}
            </dd>
          </div>
        ))}
      </dl>
      <PlanChangeBar onRevise={onRevise} readyHint="Happy with it? Build this plan. Otherwise describe a change - the plan is redone with it." />
      <div className="flex gap-2 px-3 py-2">
        <button
          type="button"
          data-testid="agent-approve"
          onClick={onApprove}
          className="rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-900/40"
        >
          Build this plan
        </button>
        <button type="button" data-testid="agent-cancel" onClick={onCancel} className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800">
          Cancel
        </button>
      </div>
    </div>
  );
}
