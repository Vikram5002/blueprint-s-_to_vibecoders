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
  Record<GenerationStatus, { border: string; bg: string; text: string; dot: string }>
> = {
  'not-started': {
    border: 'border-slate-600',
    bg: 'bg-slate-800',
    text: 'text-slate-400',
    dot: 'bg-slate-500',
  },
  'layout-selected': {
    border: 'border-sky-500',
    bg: 'bg-sky-950',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
  },
  generating: {
    border: 'border-amber-500',
    bg: 'bg-amber-950',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
  },
  generated: {
    border: 'border-indigo-500',
    bg: 'bg-indigo-950',
    text: 'text-indigo-300',
    dot: 'bg-indigo-400',
  },
  verified: {
    border: 'border-emerald-600',
    bg: 'bg-emerald-950',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
  },
  'violation-detected': {
    border: 'border-red-600',
    bg: 'bg-red-950',
    text: 'text-red-300',
    dot: 'bg-red-400',
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
      className={`min-w-[200px] rounded-xl border-2 ${style.border} ${style.bg} p-3 shadow-lg`}
      data-domain={node.domain}
      data-status={node.status}
      data-selected={selected ? 'true' : 'false'}
    >
      <Handle type="target" position={Position.Top} />

      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-100">{DOMAIN_LABEL[node.domain]}</span>
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.text}`}
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
        className="w-full rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
      >
        View components
      </button>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
