import { useMemo } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { ModuleNode, type ModuleNodeData } from './ModuleNode';
import type { ModuleViewResponse } from './api-types';

const NODE_TYPES = { module: ModuleNode };

export interface ModuleCanvasProps {
  view: ModuleViewResponse;
  selectedModuleId: string | null;
  selectedEdgeId: string | null;
  onSelectModule: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

/** Same drawing rules as the directory canvas, so the two are comparable. */
export function ModuleCanvas(props: ModuleCanvasProps): JSX.Element {
  const { view, selectedModuleId, selectedEdgeId } = props;

  const nodes = useMemo<Node[]>(
    () =>
      view.nodes.map((node) => ({
        id: node.id,
        type: 'module',
        position: view.positions[node.id] ?? { x: 0, y: 0 },
        selected: node.id === selectedModuleId,
        data: {
          label: node.label,
          moduleId: node.id,
          fileCount: node.fileCount,
          directoryCount: node.directories.length,
          disagreeingFiles: node.disagreeingFiles,
        } satisfies ModuleNodeData,
      })),
    [view, selectedModuleId],
  );

  const edges = useMemo<Edge[]>(() => {
    const heaviest = Math.max(1, ...view.edges.map((edge) => edge.importCount));

    return view.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      selected: edge.id === selectedEdgeId,
      animated: false,
      interactionWidth: 24,
      style: {
        strokeWidth: 1 + (Math.log(1 + edge.importCount) / Math.log(1 + heaviest)) * 5,
        stroke: edge.id === selectedEdgeId ? '#6ea8fe' : '#4a5568',
      },
      label: edge.importCount > 1 ? String(edge.importCount) : undefined,
      labelStyle: { fill: '#9aa4b6', fontSize: 10 },
      labelBgStyle: { fill: '#161a22' },
    }));
  }, [view, selectedEdgeId]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      minZoom={0.05}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_event, node) => props.onSelectModule(node.id)}
      onEdgeClick={(_event, edge) => props.onSelectEdge(edge.id)}
    >
      <Background color="#222834" gap={22} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor="#4a5568"
        nodeStrokeWidth={0}
        maskColor="rgba(15,17,21,0.75)"
        bgColor="#11141a"
        style={{ border: '1px solid #2a3140', borderRadius: 6 }}
      />
    </ReactFlow>
  );
}
