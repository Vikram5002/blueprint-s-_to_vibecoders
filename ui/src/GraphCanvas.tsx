import { useMemo } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DirectoryNode, type GraphNodeData } from './DirectoryNode';
import type { GraphResponse } from './api-types';

const NODE_TYPES = { blueprint: DirectoryNode };

export interface GraphCanvasProps {
  graph: GraphResponse;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onToggleDirectory: (path: string) => void;
}

/**
 * Positions arrive precomputed from the server, so React Flow only draws. No
 * layout runs in the browser and nothing animates towards a resting state.
 */
export function GraphCanvas(props: GraphCanvasProps): JSX.Element {
  const { graph, selectedNodeId, selectedEdgeId } = props;

  const nodes = useMemo<Node[]>(() => {
    const expandable = new Set(graph.expandable);

    return graph.nodes.map((node) => ({
      id: node.id,
      type: 'blueprint',
      position: graph.positions[node.id] ?? { x: 0, y: 0 },
      selected: node.id === selectedNodeId,
      data: {
        label: node.label,
        path: node.path,
        kind: node.kind,
        fileCount: node.fileCount,
        languages: node.languages,
        expandable: expandable.has(node.id) || (node.kind === 'file' && node.parent !== null),
        expanded: node.kind === 'file' && node.parent !== null,
        onToggle: (path: string) => {
          props.onToggleDirectory(node.kind === 'file' ? (node.parent ?? path) : path);
        },
      } satisfies GraphNodeData,
    }));
  }, [graph, selectedNodeId, props]);

  const edges = useMemo<Edge[]>(() => {
    const heaviest = Math.max(1, ...graph.edges.map((edge) => edge.importCount));

    return graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      selected: edge.id === selectedEdgeId,
      animated: false,
      style: {
        strokeWidth: thickness(edge.importCount, heaviest),
        stroke: edge.id === selectedEdgeId ? '#6ea8fe' : '#3a4457',
      },
      label: edge.importCount > 1 ? String(edge.importCount) : undefined,
      labelStyle: { fill: '#9aa4b6', fontSize: 10 },
      labelBgStyle: { fill: '#161a22' },
    }));
  }, [graph, selectedEdgeId]);

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
      // Culls off-screen elements: the difference between smooth and unusable
      // once a repository this size is on screen.
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_event, node) => props.onSelectNode(node.id)}
      onEdgeClick={(_event, edge) => props.onSelectEdge(edge.id)}
    >
      <Background color="#222834" gap={22} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor="#2a3140" maskColor="rgba(15,17,21,0.8)" />
    </ReactFlow>
  );
}

/** Thickness reflects how many import statements the edge stands for. */
function thickness(importCount: number, heaviest: number): number {
  const ratio = Math.log(1 + importCount) / Math.log(1 + heaviest);
  return 1 + ratio * 5;
}
