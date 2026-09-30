import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GENERATION_STATUS_LABEL, type GenerationStatus } from './generation-status';
import type { DomainName } from './project-schema-types';
import { Icon, type IconName } from '../design/Icon';

export interface WorkflowNodeData extends Record<string, unknown> {
  readonly domain: DomainName;
  readonly componentCount: number;
  readonly status: GenerationStatus;
  readonly onViewComponents: (domain: DomainName) => void;
}

/**
 * Six visually distinct status treatments — colour, border, AND a text
 * label, so the distinction survives colour-blindness and a greyscale
 * screenshot (same three-signal discipline as this project's provenance
 * badges). 'generating' additionally pulses, since it is the one state that
 * describes something in progress rather than a settled outcome.
 */
const STATUS_STYLE: Readonly<
  Record<GenerationStatus, { border: string; bg: string; text: string; dot: string; pill: string }>
> = {
  'not-started': {
    border: 'border-white/[0.12]',
    bg: 'bg-slate-800/90',
    text: 'text-slate-400',
    dot: 'bg-slate-500',
    pill: 'bg-white/[0.06]',
  },
  'layout-selected': {
    border: 'border-sky-500/50',
    bg: 'bg-sky-950/80',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
    pill: 'bg-sky-500/[0.14]',
  },
  generating: {
    border: 'border-amber-500/50',
    bg: 'bg-amber-950/80',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
    pill: 'bg-amber-500/[0.14]',
  },
  generated: {
    border: 'border-indigo-500/50',
    bg: 'bg-indigo-950/80',
    text: 'text-indigo-300',
    dot: 'bg-indigo-400',
    pill: 'bg-indigo-500/[0.14]',
  },
  verified: {
    border: 'border-emerald-500/50',
    bg: 'bg-emerald-950/80',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
    pill: 'bg-emerald-500/[0.14]',
  },
  'violation-detected': {
    border: 'border-red-500/60',
    bg: 'bg-red-950/80',
    text: 'text-red-300',
    dot: 'bg-red-400',
    pill: 'bg-red-500/[0.14]',
  },
};

const DOMAIN_LABEL: Readonly<Record<DomainName, string>> = {
  frontend: 'Frontend',
  backend: 'Backend',
  database: 'Database',
  security: 'Security',
};

/** Each layer keeps one icon and one colour everywhere it appears (this graph, the plan review, the project report). */
const DOMAIN_MARK: Readonly<
  Record<DomainName, { readonly icon: IconName; readonly tone: string }>
> = {
  frontend: { icon: 'pages', tone: 'bg-sky-500/[0.16] text-sky-300' },
  backend: { icon: 'server', tone: 'bg-violet-500/[0.16] text-violet-300' },
  database: { icon: 'database', tone: 'bg-emerald-500/[0.16] text-emerald-300' },
  security: { icon: 'lock', tone: 'bg-amber-500/[0.16] text-amber-300' },
};

/**
 * Not draggable (`draggable: false` set by WorkflowGraph on every node) —
 * position comes only from `computeLayout`, and letting a user drag a node
 * would mean the on-screen layout no longer matches what that deterministic
 * function produces, defeating the point of computing it at all.
 *
 * Handles are React Flow's default size — no custom CSS shrinks or hides
 * them the way the old dashboard's global stylesheet used to (see
 * BlueprintCanvas.tsx's history with that bug). Verified clickable in a
 * real browser at fit-to-view; see the PR description for how.
 */
export function WorkflowNode({ data, selected }: NodeProps): JSX.Element {
  const node = data as WorkflowNodeData;
  const style = STATUS_STYLE[node.status];

  return (
    <div
      className={`min-w-[220px] rounded-2xl border ${style.border} ${style.bg} p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_16px_40px_-18px_rgba(0,0,0,0.9)] backdrop-blur transition-[box-shadow,transform] duration-300 ease-apple hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_22px_48px_-18px_rgba(0,0,0,0.95)] ${selected ? 'ring-2 ring-violet-400/70 ring-offset-2 ring-offset-[#0c0c0e]' : ''}`}
      data-domain={node.domain}
      data-status={node.status}
      data-selected={selected ? 'true' : 'false'}
    >
      <Handle type="target" position={Position.Top} />

      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-lg ${DOMAIN_MARK[node.domain].tone}`}
          >
            <Icon name={DOMAIN_MARK[node.domain].icon} size={14} />
          </span>
          <span className="text-[14px] font-semibold tracking-tight text-slate-50">
            {DOMAIN_LABEL[node.domain]}
          </span>
        </span>
        <span
          className={`flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.text} ${style.pill}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${style.dot} ${node.status === 'generating' ? 'animate-pulse' : ''}`}
          />
          {GENERATION_STATUS_LABEL[node.status]}
        </span>
      </div>

      <div className="mb-2 text-xs text-slate-400">
        {node.componentCount} component{node.componentCount === 1 ? '' : 's'}
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          node.onViewComponents(node.domain);
        }}
        className="w-full rounded-lg border border-white/[0.06] bg-white/[0.05] px-2 py-1.5 text-xs font-medium text-slate-300 hover:border-white/[0.12] hover:bg-white/[0.1] hover:text-slate-100"
      >
        View components
      </button>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
