import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { BlueprintNode, type BlueprintNodeData } from './BlueprintNode';
import { BlueprintSeedsPanel } from './BlueprintSeedsPanel';
import {
  fetchBlueprint,
  fetchModules,
  compileBlueprintGraph,
  saveBlueprintGraph,
} from './api';
import type {
  BlueprintGraph,
  BlueprintGraphEdge,
  BlueprintGraphNode,
  BlueprintRelation,
  BlueprintResponse,
  CompileBlueprintResponse,
  ModuleViewResponse,
} from './api-types';

const NODE_TYPES = { blueprint: BlueprintNode };

const RELATION_LABEL: Record<BlueprintRelation, string> = {
  'must-not-import': 'must not import',
  'may-only-import-via': 'may only import … via',
  'must-be-layer-above': 'must be layer above',
};

interface AuthoredPosition {
  x: number;
  y: number;
}

let nextId = 0;
/** Client-generated, stable for the node/edge's lifetime in this editor session. */
function newId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}

/**
 * Part A.3: the visual blueprint editor.
 *
 * Derived modules are shown as read-only anchors — "start from current"
 * without inventing a parallel seeding UI here (Part A.2's seeds live in
 * BlueprintSeedsPanel, reachable from the same view). Authored nodes and
 * edges are fully editable. Every edit is serialised into a `BlueprintGraph`
 * and sent to `/api/blueprint/compile`, which turns it into DSL text via the
 * exact same `graphToDsl` + `compileBlueprint` a typed `.txt` file goes
 * through (see `src/server/blueprint-api.ts`). This component never computes
 * DSL text or a `Constraint` itself — the panel below the canvas shows
 * whatever the server returned, verbatim, which is what keeps "one path" an
 * enforced fact rather than a promise: there is no client-side compiler here
 * to drift out of sync with the real one.
 *
 * Derived edges are deliberately not drawn on this canvas. They are facts,
 * not proposals, and the other two views (`ModuleCanvas`, `GraphCanvas`)
 * already show them; drawing them here read-only would add clutter without
 * adding capability, since editing them is never possible.
 */
export function BlueprintCanvas(): JSX.Element {
  const [modules, setModules] = useState<ModuleViewResponse | null>(null);
  const [saved, setSaved] = useState<BlueprintResponse | null>(null);
  const [authoredNodes, setAuthoredNodes] = useState<BlueprintGraphNode[]>([]);
  const [authoredPositions, setAuthoredPositions] = useState<Record<string, AuthoredPosition>>({});
  const [edges, setEdges] = useState<BlueprintGraphEdge[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CompileBlueprintResponse | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchModules().then(setModules).catch((cause: unknown) => setError(String(cause)));
    fetchBlueprint().then(setSaved).catch((cause: unknown) => setError(String(cause)));
  }, []);

  const touchedDerivedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of edges) {
      ids.add(edge.from);
      ids.add(edge.to);
      if (edge.via !== undefined) ids.add(edge.via);
    }
    return ids;
  }, [edges]);

  const graph = useMemo<BlueprintGraph>(() => {
    const derivedTouched = (modules?.nodes ?? [])
      .filter((module) => touchedDerivedIds.has(module.id))
      .map((module) => ({ id: module.id, phrase: module.label }));
    return { nodes: [...authoredNodes, ...derivedTouched], edges };
  }, [authoredNodes, edges, modules, touchedDerivedIds]);

  // Debounced live preview: every edit re-asks the server, never computes
  // DSL text locally.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (graph.nodes.length === 0 && graph.edges.length === 0) {
      setPreview(null);
      return;
    }
    setPreviewPending(true);
    debounceRef.current = setTimeout(() => {
      compileBlueprintGraph(graph)
        .then(setPreview)
        .catch((cause: unknown) => setError(String(cause)))
        .finally(() => setPreviewPending(false));
    }, 350);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const addNode = useCallback(() => {
    const id = newId('n');
    setAuthoredNodes((current) => [...current, { id, phrase: 'new-module' }]);
    setAuthoredPositions((current) => ({
      ...current,
      [id]: { x: 80 + (Object.keys(current).length % 5) * 190, y: 80 + Math.floor(Object.keys(current).length / 5) * 140 },
    }));
  }, []);

  const renameNode = useCallback((id: string, phrase: string) => {
    setAuthoredNodes((current) => current.map((node) => (node.id === id ? { ...node, phrase } : node)));
  }, []);

  const removeNode = useCallback((id: string) => {
    setAuthoredNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.from !== id && edge.to !== id && edge.via !== id));
    setAuthoredPositions((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const toggleCycle = useCallback((id: string) => {
    setAuthoredNodes((current) =>
      current.map((node) => (node.id === id ? { ...node, mustNotCycle: node.mustNotCycle !== true } : node)),
    );
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null) return;
    const id = newId('e');
    setEdges((current) => [
      ...current,
      { id, from: connection.source as string, to: connection.target as string, relation: 'must-not-import' },
    ]);
    setSelectedEdgeId(id);
  }, []);

  const setEdgeRelation = useCallback((id: string, relation: BlueprintRelation) => {
    setEdges((current) =>
      current.map((edge) => {
        if (edge.id !== id) return edge;
        if (relation === 'may-only-import-via') {
          return { ...edge, relation };
        }
        // exactOptionalPropertyTypes: clearing `via` means omitting the key,
        // not setting it to undefined.
        const { via: _via, ...rest } = edge;
        return { ...rest, relation };
      }),
    );
  }, []);

  const setEdgeVia = useCallback((id: string, via: string) => {
    setEdges((current) => current.map((edge) => (edge.id === id ? { ...edge, via } : edge)));
  }, []);

  const removeEdge = useCallback((id: string) => {
    setEdges((current) => current.filter((edge) => edge.id !== id));
    setSelectedEdgeId((current) => (current === id ? null : current));
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position !== undefined) {
        setAuthoredPositions((current) =>
          current[change.id] === undefined ? current : { ...current, [change.id]: change.position as AuthoredPosition },
        );
      }
    }
  }, []);

  const save = useCallback(() => {
    setSaving(true);
    setNotice(null);
    saveBlueprintGraph(graph)
      .then((result) => {
        setNotice(
          `Saved ${result.constraints.length} constraint(s)` +
            (result.rejected.length > 0 ? `, ${result.rejected.length} line(s) rejected` : '') +
            '. Applies to the next run — CLI, JSON, and any --mcp session.',
        );
        return fetchBlueprint().then(setSaved);
      })
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setSaving(false));
  }, [graph]);

  const flowNodes = useMemo<Node[]>(() => {
    const derived: Node[] = (modules?.nodes ?? [])
      .filter((module) => touchedDerivedIds.has(module.id))
      .map((module) => ({
        id: module.id,
        type: 'blueprint',
        position: modules?.positions[module.id] ?? { x: 0, y: 0 },
        draggable: false,
        connectable: true,
        data: { phrase: module.label, kind: 'derived' } satisfies BlueprintNodeData,
      }));

    const authored: Node[] = authoredNodes.map((node, index) => ({
      id: node.id,
      type: 'blueprint',
      position: authoredPositions[node.id] ?? { x: 80, y: 80 + index * 100 },
      draggable: true,
      connectable: true,
      data: {
        phrase: node.phrase,
        kind: 'authored',
        mustNotCycle: node.mustNotCycle === true,
        onRename: renameNode,
        onRemove: removeNode,
        onToggleCycle: toggleCycle,
      } satisfies BlueprintNodeData,
    }));

    return [...derived, ...authored];
  }, [modules, touchedDerivedIds, authoredNodes, authoredPositions, renameNode, removeNode, toggleCycle]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        selected: edge.id === selectedEdgeId,
        label: RELATION_LABEL[edge.relation],
        labelStyle: { fill: '#e2d4ff', fontSize: 10 },
        labelBgStyle: { fill: '#241a38' },
        style: { stroke: edge.id === selectedEdgeId ? '#b98cff' : '#7a5aa8', strokeWidth: 2 },
      })),
    [edges, selectedEdgeId],
  );

  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const allNodeChoices = [
    ...authoredNodes.map((n) => ({ id: n.id, phrase: n.phrase })),
    ...(modules?.nodes ?? []).filter((m) => touchedDerivedIds.has(m.id)).map((m) => ({ id: m.id, phrase: m.label })),
  ];

  return (
    <Fragment>
      <div className="canvas blueprint-canvas-wrapper">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onEdgeClick={(_event, edge) => setSelectedEdgeId(edge.id)}
          onPaneClick={() => setSelectedEdgeId(null)}
          fitView
          minZoom={0.1}
          maxZoom={2}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#241a38" gap={22} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="#7a5aa8" nodeStrokeWidth={0} maskColor="rgba(15,17,21,0.75)" bgColor="#11141a" />
        </ReactFlow>
      </div>

      <aside className="side">
        <BlueprintSeedsPanel />

        {error !== null && <div className="banner">{error}</div>}
        {notice !== null && (
          <div className="banner" data-tone="stated">
            {notice}{' '}
            <button type="button" className="link" onClick={() => setNotice(null)}>
              dismiss
            </button>
          </div>
        )}

        <div className="hint" style={{ marginBottom: 10 }}>
          Drag from a node's edge to another to draw a rule. DERIVED boxes are
          real modules and are read-only; add a STATED box to name something
          that is not one. Every edit compiles below through the same DSL
          compiler a typed file uses.
        </div>

        <button type="button" onClick={addNode} style={{ marginBottom: 12 }}>
          + add node
        </button>

        {selectedEdge !== null && (
          <div className="evidence-group constraint" style={{ marginBottom: 14 }}>
            <header>
              <span className="provenance stated-chip">editing edge</span>
            </header>
            <div className="rows">
              <div className="row">
                <span className="k">relation</span>
                <select
                  className="v"
                  value={selectedEdge.relation}
                  onChange={(event) => setEdgeRelation(selectedEdge.id, event.target.value as BlueprintRelation)}
                >
                  <option value="must-not-import">must not import</option>
                  <option value="may-only-import-via">may only import … via</option>
                  <option value="must-be-layer-above">must be layer above</option>
                </select>
              </div>
              {selectedEdge.relation === 'may-only-import-via' && (
                <div className="row">
                  <span className="k">via</span>
                  <select
                    className="v"
                    value={selectedEdge.via ?? ''}
                    onChange={(event) => setEdgeVia(selectedEdge.id, event.target.value)}
                  >
                    <option value="" disabled>
                      choose a node
                    </option>
                    {allNodeChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.phrase}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <button type="button" className="link" style={{ marginTop: 8 }} onClick={() => removeEdge(selectedEdge.id)}>
              delete edge
            </button>
          </div>
        )}

        <h3>
          DSL
          {previewPending && <span className="hint"> compiling…</span>}
        </h3>
        <pre className="quote" style={{ whiteSpace: 'pre-wrap', minHeight: 20 }}>
          {preview !== null && preview.dsl !== '' ? preview.dsl : '(nothing drawn yet)'}
        </pre>

        {preview !== null && preview.rejected.length > 0 && (
          <div className="banner">
            {preview.rejected.length} line(s) did not compile — a `may only
            import via` edge probably needs its via node chosen.
          </div>
        )}

        {preview !== null && preview.constraints.length > 0 && (
          <>
            <h3>Compiles to ({preview.constraints.length})</h3>
            <div className="rows">
              {preview.constraints.map((constraint) => (
                <div className="row" key={constraint.id} style={{ display: 'block' }}>
                  <div style={{ fontSize: 11 }}>“{constraint.rawText}”</div>
                  {!constraint.evaluable && (
                    <span className="tag-status tag-orphaned">not checkable — a phrase did not resolve</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <button
          type="button"
          onClick={save}
          disabled={saving || graph.edges.length === 0}
          style={{ marginTop: 14, marginBottom: 18 }}
        >
          {saving ? 'saving…' : 'save blueprint'}
        </button>

        {saved !== null && saved.constraints.length > 0 && (
          <>
            <h3>Saved blueprint ({saved.constraints.length})</h3>
            <div className="hint" style={{ marginBottom: 6 }}>
              What the next run — CLI, JSON, or an --mcp session — will check
              against. Editing above does not change this until you save.
            </div>
            <div className="rows">
              {saved.constraints.map((constraint) => (
                <div className="row" key={constraint.id} style={{ display: 'block' }}>
                  <div style={{ fontSize: 11 }}>
                    <span className="provenance stated-chip">{constraint.source.type}</span> “{constraint.rawText}”
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </Fragment>
  );
}
