import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GENERATION_STATUS_LABEL, type GenerationStatus } from './generation-status';
import type { DomainName } from './project-schema-types';

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
      className={`min-w-[210px] rounded-2xl border ${style.border} ${style.bg} p-3.5 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.8)] backdrop-blur transition-shadow duration-300 ease-apple hover:shadow-[0_14px_36px_-10px_rgba(0,0,0,0.9)] ${selected ? 'ring-2 ring-sky-500/70 ring-offset-2 ring-offset-slate-900' : ''}`}
      data-domain={node.domain}
      data-status={node.status}
      data-selected={selected ? 'true' : 'false'}
    >
      <Handle type="target" position={Position.Top} />

      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[15px] font-semibold tracking-tight text-slate-50">{DOMAIN_LABEL[node.domain]}</span>
        <span
          className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.text} ${style.pill}`}
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
        className="w-full rounded-lg bg-white/[0.08] px-2 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.14]"
      >
        View components
      </button>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
