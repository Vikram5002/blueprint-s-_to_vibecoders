import { useCallback, useEffect, useState } from 'react';
import { fetchEdge, fetchGraph, fetchNode, fetchSummary } from './api';
import { GraphCanvas } from './GraphCanvas';
import { EvidencePanel } from './EvidencePanel';
import { NodePanel } from './NodePanel';
import { SummaryPanel } from './SummaryPanel';
import type {
  EdgeResponse,
  GraphResponse,
  NodeResponse,
  SummaryResponse,
  ViewLevel,
} from './api-types';

/** Past this, the file-level view stops being usable and says so. */
const FILE_LEVEL_WARNING_THRESHOLD = 800;

export function App(): JSX.Element {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [level, setLevel] = useState<ViewLevel>('directory');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeResponse | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSummary().then(setSummary).catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchGraph(level, expanded)
      .then((next) => {
        if (!cancelled) setGraph(next);
      })
      .catch((cause: unknown) => setError(String(cause)));
    return () => {
      cancelled = true;
    };
  }, [level, expanded]);

  const selectNode = useCallback((id: string) => {
    setSelectedEdge(null);
    fetchNode(id).then(setSelectedNode).catch((cause: unknown) => setError(String(cause)));
  }, []);

  const selectEdge = useCallback((id: string) => {
    setSelectedNode(null);
    fetchEdge(id).then(setSelectedEdge).catch((cause: unknown) => setError(String(cause)));
  }, []);

  const toggleDirectory = useCallback((path: string) => {
    setExpanded((current) =>
      current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path],
    );
  }, []);

  const selectedNodeId = selectedNode?.id ?? null;
  const selectedEdgeId = selectedEdge?.id ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Vibe-Code Blueprint</h1>
        <span className="root" title={summary?.root ?? ''}>
          {summary?.root ?? ''}
        </span>
        <span className="spacer" />

        {graph && (
          <span className="stat">
            <b>{graph.counts.nodes}</b> nodes · <b>{graph.counts.edges}</b> edges · from{' '}
            <b>{graph.counts.files}</b> files
          </span>
        )}
        {summary && (
          <span className="stat">
            resolved <b>{summary.resolutionRate.toFixed(1)}%</b>
          </span>
        )}

        <div className="toggle">
          <button type="button" data-active={level === 'directory'} onClick={() => setLevel('directory')}>
            Directories
          </button>
          <button type="button" data-active={level === 'file'} onClick={() => setLevel('file')}>
            Files
          </button>
        </div>
        {expanded.length > 0 && (
          <button type="button" className="link" onClick={() => setExpanded([])}>
            collapse all ({expanded.length})
          </button>
        )}
      </header>

      <div className="canvas">
        {graph === null ? (
          <div className="loading">{error ?? 'Loading graph…'}</div>
        ) : (
          <GraphCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectNode={selectNode}
            onSelectEdge={selectEdge}
            onToggleDirectory={toggleDirectory}
          />
        )}
      </div>

      <aside className="side">
        {error && <div className="banner">{error}</div>}

        {level === 'file' && graph !== null && graph.counts.nodes > FILE_LEVEL_WARNING_THRESHOLD && (
          <div className="banner">
            {graph.counts.nodes.toLocaleString()} file nodes on screen. This view is slow at
            this size — the directory view is the one built for it.
          </div>
        )}

        {selectedEdge !== null && <EvidencePanel edge={selectedEdge} />}

        {selectedEdge === null && selectedNode !== null && (
          <NodePanel node={selectedNode} onSelectEdge={selectEdge} onSelectNode={selectNode} />
        )}

        {selectedEdge === null && selectedNode === null && (
          <>
            <div className="hint" style={{ marginBottom: 14 }}>
              Click an <b>edge</b> to see the source lines that produced it. Click a{' '}
              <b>node</b> for its files and dependencies. Use <b>expand</b> on a directory to
              open it into individual files.
            </div>
            {summary !== null ? <SummaryPanel summary={summary} /> : <div className="hint">Loading…</div>}
          </>
        )}

        {(selectedEdge !== null || selectedNode !== null) && (
          <button
            type="button"
            className="link"
            style={{ marginTop: 16 }}
            onClick={() => {
              setSelectedEdge(null);
              setSelectedNode(null);
            }}
          >
            ← back to run summary
          </button>
        )}
      </aside>
    </div>
  );
}
