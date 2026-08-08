import type { NodeResponse } from './api-types';

export interface NodePanelProps {
  node: NodeResponse;
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (id: string) => void;
}

export function NodePanel({ node, onSelectEdge, onSelectNode }: NodePanelProps): JSX.Element {
  return (
    <div>
      <h2>
        {node.kind === 'directory' ? 'Directory' : 'File'}
        <span className="provenance">DERIVED</span>
      </h2>
      <div className="hint mono" style={{ marginBottom: 10, wordBreak: 'break-all' }}>
        {node.id}
      </div>

      <h3>
        Depends on ({node.outbound.length})
      </h3>
      <Neighbours items={node.outbound} onSelectEdge={onSelectEdge} onSelectNode={onSelectNode} />

      <h3>
        Depended on by ({node.inbound.length})
      </h3>
      <Neighbours items={node.inbound} onSelectEdge={onSelectEdge} onSelectNode={onSelectNode} />

      {node.externals.length > 0 && (
        <>
          <h3>External packages ({node.externals.length})</h3>
          <div className="rows">
            {node.externals.map((external) => (
              <div className="row" key={external.name}>
                <span className="k mono">{external.name}</span>
                <span className="v">{external.count}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>Files ({node.files.length})</h3>
      <div className="rows">
        {node.files.map((file) => (
          <div className="row" key={file}>
            <button type="button" className="link" onClick={() => onSelectNode(file)} title={file}>
              {file}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Neighbours({
  items,
  onSelectEdge,
  onSelectNode,
}: {
  items: NodeResponse['inbound'];
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (id: string) => void;
}): JSX.Element {
  if (items.length === 0) {
    return <div className="hint">None.</div>;
  }

  return (
    <div className="rows">
      {items.map((item) => (
        <div className="row" key={item.edgeId}>
          <button type="button" className="link" onClick={() => onSelectNode(item.id)} title={item.id}>
            {item.id}
          </button>
          <button
            type="button"
            className="link v"
            onClick={() => onSelectEdge(item.edgeId)}
            title="Show the source lines behind this dependency"
          >
            {item.importCount} ›
          </button>
        </div>
      ))}
    </div>
  );
}
