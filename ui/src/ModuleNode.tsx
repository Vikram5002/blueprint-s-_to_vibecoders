import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ProvenanceBadge } from './ProvenanceBadge';
import type { LabelSource } from './api-types';

export interface ModuleNodeData extends Record<string, unknown> {
  label: string;
  moduleId: string;
  fileCount: number;
  directoryCount: number;
  disagreeingFiles: number;
  labelSource: LabelSource;
}

/**
 * A module node states its file count, how many directories it spans, and how
 * many of its files disagree with the file tree.
 *
 * The disagreement is on the node itself rather than buried in a panel: a
 * module drawn from three folders is the thing a developer cannot see from the
 * file tree, and it should be visible before anything is clicked.
 */
export function ModuleNode({ data, selected }: NodeProps): JSX.Element {
  const node = data as ModuleNodeData;
  const spans = node.directoryCount > 1;

  return (
    <div
      className="node"
      data-kind="module"
      data-selected={selected ? 'true' : 'false'}
      data-disagrees={spans ? 'true' : 'false'}
      data-label-source={node.labelSource}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="name" title={`${node.moduleId} — ${node.label}`}>
        {node.label}
      </div>
      <div className="meta">
        <ProvenanceBadge source={node.labelSource} />
        <span>{node.fileCount} files</span>
        {spans && (
          <span className="tag-disagree" title="This module's files come from more than one folder">
            {node.directoryCount} dirs
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
