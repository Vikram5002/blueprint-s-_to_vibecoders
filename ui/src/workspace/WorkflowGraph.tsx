import { useMemo, useState } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { WorkflowNode, type WorkflowNodeData } from './WorkflowNode';
import { ComponentListModal } from './ComponentListModal';
import { computeLayout, deriveEdges, type WorkflowEdge } from './workflow-layout';
import {
  GENERATION_STATUSES,
  GENERATION_STATUS_LABEL,
  type GenerationStatus,
} from './generation-status';
import type { DomainName, ProjectSchema } from './project-schema-types';

const NODE_TYPES = { workflow: WorkflowNode };

const DOMAIN_LABEL: Readonly<Record<DomainName, string>> = {
  frontend: 'Frontend',
  backend: 'Backend',
  database: 'Database',
  security: 'Security',
};

const RELATION_LABEL: Readonly<Record<string, string>> = {
  'must-not-import': 'must not import',
  'may-only-import-via': 'may only import … via',
  'must-not-cycle': 'must not cycle',
  'must-be-layer-above': 'must be layer above',
};

export interface WorkflowGraphProps {
  readonly schema: ProjectSchema;
}

/**
 * The workflow graph: four fixed domain nodes at deterministic positions
 * (computeLayout — see workflow-layout.ts for why this is a pure function,
 * never a physics simulation), directed edges from `dependsOn`, weighted by
 * the dependent domain's component count. Clicking an edge shows the exact
 * `Constraint` it represents, if any was stated — never a fabricated one.
 *
 * Per-node generation status is local UI state here (GenerationStatus is
 * not part of ProjectSchema — see generation-status.ts), demo-controllable
 * below the canvas so all six states can be seen at once without a real
 * orchestrator driving them.
 */
export function WorkflowGraph({ schema }: WorkflowGraphProps): JSX.Element {
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [viewingDomain, setViewingDomain] = useState<DomainName | null>(null);
  const [statuses, setStatuses] = useState<Record<DomainName, GenerationStatus>>({
    frontend: 'not-started',
    backend: 'not-started',
    database: 'not-started',
    security: 'not-started',
  });

  const layout = useMemo(() => computeLayout(schema), [schema]);
  const edges = useMemo(() => deriveEdges(schema), [schema]);
  const maxWeight = useMemo(() => Math.max(1, ...edges.map((e) => e.weight)), [edges]);

  const flowNodes = useMemo<Node[]>(
    () =>
      (Object.keys(schema.domains) as DomainName[]).map((domain) => ({
        id: domain,
        type: 'workflow',
        position: layout[domain],
        draggable: false,
        connectable: false,
        data: {
          domain,
          componentCount: schema.domains[domain].components.length,
          status: statuses[domain],
          onViewComponents: setViewingDomain,
        } satisfies WorkflowNodeData,
      })),
    [schema, layout, statuses],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        selected: edge.id === selectedEdgeId,
        style: {
          strokeWidth: 1 + (edge.weight / maxWeight) * 6,
          stroke:
            edge.id === selectedEdgeId
              ? '#b98cff'
              : edge.constraint !== null
                ? '#7a5aa8'
                : '#4a5568',
        },
        label: edge.constraint !== null ? 'rule stated' : undefined,
        labelStyle: { fill: '#e2d4ff', fontSize: 10, pointerEvents: 'none' },
        // pointerEvents: 'none' so the label's background rect never
        // intercepts a click meant for the edge underneath it — found while
        // browser-testing edge inspection: the label sits, by React Flow's
        // own default, in a layer above the edge's interaction hit-path, and
        // captures the click instead of passing it through.
        labelBgStyle: { fill: '#241a38', pointerEvents: 'none' },
      })),
    [edges, selectedEdgeId, maxWeight],
  );

  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const viewingSpec = viewingDomain === null ? null : schema.domains[viewingDomain];

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            fitView
            minZoom={0.2}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            onEdgeClick={(_event, edge) => setSelectedEdgeId(edge.id)}
            onPaneClick={() => setSelectedEdgeId(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1c212b" gap={22} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor="#4a5568"
              nodeStrokeWidth={0}
              maskColor="rgba(15,17,21,0.75)"
              bgColor="#11141a"
            />
          </ReactFlow>
        </div>

        <aside className="w-72 flex-shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-950 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Edge inspection
          </h3>
          {selectedEdge === null ? (
            <p className="text-xs text-slate-500">Click an edge to see the rule it represents.</p>
          ) : (
            <EdgeInspection edge={selectedEdge} />
          )}

          <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Node status (demo controls)
          </h3>
          <div className="space-y-2">
            {(Object.keys(schema.domains) as DomainName[]).map((domain) => (
              <div key={domain} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-300">{DOMAIN_LABEL[domain]}</span>
                <select
                  value={statuses[domain]}
                  onChange={(event) =>
                    setStatuses((current) => ({
                      ...current,
                      [domain]: event.target.value as GenerationStatus,
                    }))
                  }
                  className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-200"
                >
                  {GENERATION_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {GENERATION_STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {viewingDomain !== null && viewingSpec !== null && (
        <ComponentListModal
          domain={viewingDomain}
          spec={viewingSpec}
          onClose={() => setViewingDomain(null)}
        />
      )}
    </div>
  );
}

function EdgeInspection({ edge }: { edge: WorkflowEdge }): JSX.Element {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs">
      <div className="mb-2 text-slate-300">
        <span className="font-semibold">{DOMAIN_LABEL[edge.from]}</span> depends on{' '}
        <span className="font-semibold">{DOMAIN_LABEL[edge.to]}</span>
      </div>

      {edge.constraint === null ? (
        <p className="text-slate-500">No rule is stated for this dependency yet.</p>
      ) : (
        <div className="rounded border border-violet-700/50 bg-violet-950/20 p-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded border border-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-300">
              Stated
            </span>
            <span className="text-[10px] text-slate-500">
              {RELATION_LABEL[edge.constraint.relation] ?? edge.constraint.relation}
            </span>
          </div>
          <p className="text-slate-200">&quot;{edge.constraint.rawText}&quot;</p>
        </div>
      )}
    </div>
  );
}
