import { PlanChangeBar } from './PlanChangeBar';
import { Icon, type IconName } from '../design/Icon';
import type { ProjectSchema } from './project-schema-types';

const DOMAINS: readonly { readonly id: 'frontend' | 'backend' | 'database' | 'security'; readonly label: string; readonly icon: IconName; readonly tone: string }[] = [
  { id: 'frontend', label: 'Pages', icon: 'pages', tone: 'bg-sky-500/[0.14] text-sky-300' },
  { id: 'backend', label: 'API', icon: 'server', tone: 'bg-violet-500/[0.14] text-violet-300' },
  { id: 'database', label: 'Data', icon: 'database', tone: 'bg-emerald-500/[0.14] text-emerald-300' },
  { id: 'security', label: 'Security', icon: 'lock', tone: 'bg-amber-500/[0.14] text-amber-300' },
];

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
    <div data-testid="agent-review" className="anim-view overflow-hidden rounded-2xl border border-violet-400/[0.18] bg-gradient-to-b from-violet-500/[0.07] via-white/[0.015] to-transparent">
      <div className="flex items-center gap-2.5 px-4 pt-4">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-500/[0.18] text-violet-200">
          <Icon name="wand" size={13} />
        </span>
        <span className="text-[12.5px] font-medium text-violet-200">Review the plan before anything is built</span>
      </div>
      <div className="px-4 pb-1 pt-2.5 text-[18px] font-semibold tracking-[-0.02em] text-slate-50">{schema.title}</div>

      <div className="grid gap-2 px-4 py-3 sm:grid-cols-2">
        {DOMAINS.map((domain) => {
          const components = schema.domains[domain.id].components;
          return (
            <div key={domain.id} className="rounded-xl border border-white/[0.06] bg-black/[0.18] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-300">
                <span className={`flex h-6 w-6 items-center justify-center rounded-lg ${domain.tone}`}>
                  <Icon name={domain.icon} size={13} />
                </span>
                {domain.label}
                <span className="ml-auto tabular-nums text-slate-500">{components.length}</span>
              </div>
              {components.length === 0 ? (
                <span className="text-[11.5px] text-slate-500">None planned</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {components.map((component) => (
                    <span key={component.id} title={component.purpose} className="rounded-md border border-white/[0.05] bg-white/[0.045] px-2 py-0.5 text-[11.5px] text-slate-300">
                      {component.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <PlanChangeBar onRevise={onRevise} readyHint="Happy with it? Build this plan. Otherwise describe a change - the plan is redone with it." />

      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <button type="button" data-testid="agent-approve" onClick={onApprove} className="btn btn-primary">
          <Icon name="play" size={13} className="fill-current" />
          Build this plan
        </button>
        <button type="button" data-testid="agent-cancel" onClick={onCancel} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </div>
  );
}
