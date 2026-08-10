import { useCallback, useEffect, useState } from 'react';
import {
  deleteCorrection,
  fetchCorrections,
  fetchEdge,
  fetchGraph,
  fetchIntent,
  fetchViolations,
  fetchModule,
  fetchModuleEdge,
  fetchModules,
  fetchNode,
  fetchSummary,
  saveCorrection,
  type NewCorrectionRequest,
} from './api';
import { CorrectionsPanel } from './CorrectionsPanel';
import { IntentPanel } from './IntentPanel';
import { ViolationsPanel } from './ViolationsPanel';
import { TimelinePanel } from './TimelinePanel';
import { GraphCanvas } from './GraphCanvas';
import { ModuleCanvas } from './ModuleCanvas';
import { EvidencePanel } from './EvidencePanel';
import { NodePanel } from './NodePanel';
import { ModulePanel } from './ModulePanel';
import { SummaryPanel } from './SummaryPanel';
import type {
  CorrectionsResponse,
  EdgeResponse,
  GraphResponse,
  IntentResponse,
  ViolationsResponse,
  ModuleDetailResponse,
  ModuleViewResponse,
  NodeResponse,
  SummaryResponse,
  ViewLevel,
} from './api-types';

/** Past this, the file-level view stops being usable and says so. */
const FILE_LEVEL_WARNING_THRESHOLD = 800;

/**
 * Grouping mode. Directories stay the default: it is the view that always
 * matches what the developer sees on disk, so it is the honest starting point.
 * Modules are the derived opinion, offered alongside rather than in place of it.
 */
type Grouping = 'directory' | 'module';

export function App(): JSX.Element {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [modules, setModules] = useState<ModuleViewResponse | null>(null);
  const [selectedModule, setSelectedModule] = useState<ModuleDetailResponse | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsResponse | null>(null);
  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [violations, setViolations] = useState<ViolationsResponse | null>(null);
  /**
   * Files implicated by the violation the user last clicked. Lives here rather
   * than in the panel because the graph is a sibling, not a child — the whole
   * point is that a violation can point at something outside its own panel.
   */
  const [implicated, setImplicated] = useState<readonly string[]>([]);
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<Grouping>('directory');
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

  useEffect(() => {
    if (grouping !== 'module' || modules !== null) {
      return;
    }
    fetchModules().then(setModules).catch((cause: unknown) => setError(String(cause)));
  }, [grouping, modules]);

  const reloadCorrections = useCallback(() => {
    fetchCorrections().then(setCorrections).catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(() => {
    reloadCorrections();
  }, [reloadCorrections]);

  useEffect(() => {
    fetchIntent().then(setIntent).catch((cause: unknown) => setError(String(cause)));
    fetchViolations().then(setViolations).catch((cause: unknown) => setError(String(cause)));
  }, []);

  const saveCorrectionAndRefresh = useCallback(
    (request: NewCorrectionRequest) => {
      setSavingCorrection(true);
      setNotice(null);
      saveCorrection(request)
        .then(() => {
          // Deliberately not re-clustered here: the graph would move under the
          // user mid-session. Say when it takes effect instead.
          setNotice(`Saved. Your ${request.kind} applies the next time you run the tool.`);
          reloadCorrections();
        })
        .catch((cause: unknown) => setError(String(cause)))
        .finally(() => setSavingCorrection(false));
    },
    [reloadCorrections],
  );

  const forgetCorrection = useCallback(
    (id: string) => {
      deleteCorrection(id)
        .then(() => {
          setNotice('Correction removed. The next run will not reapply it.');
          reloadCorrections();
        })
        .catch((cause: unknown) => setError(String(cause)));
    },
    [reloadCorrections],
  );

  const clearSelection = useCallback(() => {
    setSelectedEdge(null);
    setSelectedNode(null);
    setSelectedModule(null);
  }, []);

  const selectNode = useCallback((id: string) => {
    setSelectedEdge(null);
    setSelectedModule(null);
    fetchNode(id).then(setSelectedNode).catch((cause: unknown) => setError(String(cause)));
  }, []);

  const selectEdge = useCallback((id: string) => {
    setSelectedNode(null);
    setSelectedModule(null);
    fetchEdge(id).then(setSelectedEdge).catch((cause: unknown) => setError(String(cause)));
  }, []);

  const selectModule = useCallback((id: string) => {
    setSelectedEdge(null);
    setSelectedNode(null);
    fetchModule(id).then(setSelectedModule).catch((cause: unknown) => setError(String(cause)));
  }, []);

  const selectModuleEdge = useCallback((id: string) => {
    setSelectedNode(null);
    setSelectedModule(null);
    fetchModuleEdge(id).then(setSelectedEdge).catch((cause: unknown) => setError(String(cause)));
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

        {grouping === 'directory' && graph && (
          <span className="stat">
            <b>{graph.counts.nodes}</b> nodes · <b>{graph.counts.edges}</b> edges · from{' '}
            <b>{graph.counts.files}</b> files
          </span>
        )}
        {grouping === 'module' && modules && (
          <span className="stat">
            <b>{modules.counts.nodes}</b> modules · <b>{modules.counts.edges}</b> edges ·{' '}
            <b>{modules.summary.disagreementRate.toFixed(1)}%</b> disagree with folders
          </span>
        )}
        {summary && (
          <span className="stat">
            resolved <b>{summary.resolutionRate.toFixed(1)}%</b>
          </span>
        )}

        <div className="toggle" title="Group by folder, or by import coupling">
          <button
            type="button"
            data-active={grouping === 'directory'}
            onClick={() => {
              setGrouping('directory');
              clearSelection();
            }}
          >
            Folders
          </button>
          <button
            type="button"
            data-active={grouping === 'module'}
            onClick={() => {
              setGrouping('module');
              clearSelection();
            }}
          >
            Modules
          </button>
        </div>

        {grouping === 'directory' && (
          <div className="toggle">
            <button type="button" data-active={level === 'directory'} onClick={() => setLevel('directory')}>
              Grouped
            </button>
            <button type="button" data-active={level === 'file'} onClick={() => setLevel('file')}>
              Files
            </button>
          </div>
        )}
        {grouping === 'directory' && expanded.length > 0 && (
          <button type="button" className="link" onClick={() => setExpanded([])}>
            collapse all ({expanded.length})
          </button>
        )}
      </header>

      <div className="canvas">
        {grouping === 'module' ? (
          modules === null ? (
            <div className="loading">{error ?? 'Clustering…'}</div>
          ) : (
            <ModuleCanvas
              view={modules}
              selectedModuleId={selectedModule?.id ?? null}
              selectedEdgeId={selectedEdgeId}
              onSelectModule={selectModule}
              onSelectEdge={selectModuleEdge}
            />
          )
        ) : graph === null ? (
          <div className="loading">{error ?? 'Loading graph…'}</div>
        ) : (
          <GraphCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectNode={selectNode}
            onSelectEdge={selectEdge}
            onToggleDirectory={toggleDirectory}
            implicatedFiles={implicated}
          />
        )}
      </div>

      <aside className="side">
        {error && <div className="banner">{error}</div>}
        {notice !== null && (
          <div className="banner" data-tone="info">
            {notice}{' '}
            <button type="button" className="link" onClick={() => setNotice(null)}>
              dismiss
            </button>
          </div>
        )}

        {level === 'file' && graph !== null && graph.counts.nodes > FILE_LEVEL_WARNING_THRESHOLD && (
          <div className="banner">
            {graph.counts.nodes.toLocaleString()} file nodes on screen. This view is slow at
            this size — the directory view is the one built for it.
          </div>
        )}

        {selectedEdge !== null && <EvidencePanel edge={selectedEdge} />}

        {selectedEdge === null && selectedModule !== null && (
          <ModulePanel
            module={selectedModule}
            onSelectEdge={selectModuleEdge}
            labelSource={modules?.nodes.find((n) => n.id === selectedModule.id)?.labelSource ?? 'mechanical'}
            mechanicalLabel={
              modules?.nodes.find((n) => n.id === selectedModule.id)?.mechanicalLabel ?? selectedModule.label
            }
            description={modules?.nodes.find((n) => n.id === selectedModule.id)?.description ?? null}
            allModules={modules?.nodes ?? []}
            onSaveCorrection={saveCorrectionAndRefresh}
            savingCorrection={savingCorrection}
          />
        )}

        {selectedEdge === null && selectedModule === null && selectedNode !== null && (
          <NodePanel node={selectedNode} onSelectEdge={selectEdge} onSelectNode={selectNode} />
        )}

        {selectedEdge === null && selectedNode === null && selectedModule === null && (
          <>
            <div className="hint" style={{ marginBottom: 14 }}>
              {grouping === 'module' ? (
                <>
                  Modules are derived from <b>import coupling</b>, not from folders. Nodes marked{' '}
                  <span className="tag-disagree">n dirs</span> span more than one folder — that
                  disagreement is the point. Click a module for the reason each file is in it.
                </>
              ) : (
                <>
                  Click an <b>edge</b> to see the source lines that produced it. Click a{' '}
                  <b>node</b> for its files and dependencies. Use <b>expand</b> on a directory to
                  open it into individual files.
                </>
              )}
            </div>
            {corrections !== null && corrections.corrections.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <CorrectionsPanel corrections={corrections} onDelete={forgetCorrection} />
              </div>
            )}
            {violations !== null && (
              <div style={{ marginBottom: 18 }}>
                <ViolationsPanel
                  violations={violations}
                  onHighlight={setImplicated}
                  highlighted={implicated}
                />
              </div>
            )}
            {intent !== null && (
              <div style={{ marginBottom: 18 }}>
                <IntentPanel intent={intent} />
              </div>
            )}
            <div style={{ marginBottom: 18 }}>
              <TimelinePanel />
            </div>
            {summary !== null ? <SummaryPanel summary={summary} /> : <div className="hint">Loading…</div>}
          </>
        )}

        {(selectedEdge !== null || selectedNode !== null || selectedModule !== null) && (
          <button type="button" className="link" style={{ marginTop: 16 }} onClick={clearSelection}>
            ← back to run summary
          </button>
        )}
      </aside>
    </div>
  );
}
