import { useCallback, useMemo, useState } from 'react';
import type { Node, NodeChange } from '@xyflow/react';

type Size = { readonly width: number; readonly height: number };

/**
 * Feeds React Flow's own measured node sizes back into nodes that are
 * controlled from outside (built with useMemo, never through
 * useNodesState).
 *
 * Without this, React Flow measures every node and reports the sizes through
 * `onNodesChange`, but a controlled graph that ignores those changes keeps
 * handing back nodes with no size, and the MiniMap - which draws only nodes
 * whose size is known - renders an empty box. Found live twice: the
 * workspace's workflow graph (fixed there on 2026-09-16) and the dashboard's
 * folder and module graphs.
 */
export function useMeasuredNodes(nodes: readonly Node[]): {
  readonly nodes: Node[];
  readonly onNodesChange: (changes: NodeChange[]) => void;
} {
  const [sizes, setSizes] = useState<Readonly<Record<string, Size>>>({});

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const measured = changes.filter(
      (change): change is Extract<NodeChange, { type: 'dimensions' }> =>
        change.type === 'dimensions' && change.dimensions !== undefined,
    );
    if (measured.length === 0) return;
    setSizes((current) => {
      let next = current;
      for (const change of measured) {
        if (change.dimensions === undefined) continue;
        const { width, height } = change.dimensions;
        const existing = next[change.id];
        if (existing?.width === width && existing?.height === height) continue;
        next = next === current ? { ...current } : next;
        (next as Record<string, Size>)[change.id] = { width, height };
      }
      return next;
    });
  }, []);

  const withSizes = useMemo(
    () =>
      nodes.map((node) => {
        const size = sizes[node.id];
        return size === undefined ? node : { ...node, measured: size };
      }),
    [nodes, sizes],
  );

  return { nodes: withSizes, onNodesChange };
}
