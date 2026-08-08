import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface GraphNodeData extends Record<string, unknown> {
  label: string;
  path: string;
  kind: 'directory' | 'file';
  fileCount: number;
  languages: Record<string, number>;
  expandable: boolean;
  expanded: boolean;
  onToggle: (path: string) => void;
}

const LANGUAGE_MARK: Record<string, string> = {
  typescript: 'TS',
  javascript: 'JS',
  python: 'PY',
};

/**
 * A directory node states how many files it stands for, so the aggregation is
 * visible rather than implied — the user can always see that one box is 40
 * files and another is 2.
 */
export function DirectoryNode({ data, selected }: NodeProps): JSX.Element {
  const node = data as GraphNodeData;
  const languages = Object.entries(node.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([language]) => LANGUAGE_MARK[language] ?? language.slice(0, 2).toUpperCase());

  return (
    <div className="node" data-kind={node.kind} data-selected={selected ? 'true' : 'false'}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="name" title={node.path}>
        {node.label}
      </div>
      <div className="meta">
        {node.kind === 'directory' && <span>{node.fileCount} files</span>}
        <span>{languages.join(' ')}</span>
        {node.expandable ? (
          <button
            type="button"
            className="expand"
            onClick={(event) => {
              event.stopPropagation();
              node.onToggle(node.path);
            }}
          >
            {node.expanded ? 'collapse' : 'expand'}
          </button>
        ) : (
          node.kind === 'directory' &&
          node.fileCount > 1 && (
            <span title="Too many files to draw individually — open the node panel for the full list">
              too large
            </span>
          )
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
