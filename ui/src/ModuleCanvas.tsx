import { useMemo } from 'react';
import { useMeasuredNodes } from './useMeasuredNodes';
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

  const builtNodes = useMemo<Node[]>(
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
          labelSource: node.labelSource,
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
        stroke: edge.id === selectedEdgeId ? '#0a84ff' : 'rgba(235, 235, 245, 0.24)',
      },
      label: edge.importCount > 1 ? String(edge.importCount) : undefined,
      labelStyle: { fill: 'rgba(235, 235, 245, 0.62)', fontSize: 10 },
      labelBgStyle: { fill: '#151517' },
    }));
  }, [view, selectedEdgeId]);

  const measured = useMeasuredNodes(builtNodes);

  return (
    <ReactFlow
      colorMode="dark"
      nodes={measured.nodes}
      onNodesChange={measured.onNodesChange}
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
      <Background color="#2a2a2e" gap={22} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor="#48484a"
        nodeStrokeWidth={0}
        maskColor="rgba(12, 12, 14, 0.72)"
        bgColor="#151517"
      />
    </ReactFlow>
  );
}
