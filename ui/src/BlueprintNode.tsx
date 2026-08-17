import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface BlueprintNodeData extends Record<string, unknown> {
  phrase: string;
  /** DERIVED nodes are real modules, read-only. STATED nodes are authored, editable. */
  kind: 'derived' | 'authored';
  mustNotCycle?: boolean;
  onRename?: (id: string, phrase: string) => void;
  onRemove?: (id: string) => void;
  onToggleCycle?: (id: string) => void;
}

/**
 * The one node type this canvas draws, in two provenance skins.
 *
 * A DERIVED node is a real module — its box is not draggable, not
 * connectable as a target for renaming, and carries no controls: "a user
 * cannot drag a derived edge, derived facts are read-only, always" applies
 * to the node's identity too, not only to edges. An authored node is fully
 * editable in place, so a person can always see and change the exact phrase
 * that will appear in the compiled DSL line.
 */
export function BlueprintNode({ id, data, selected }: NodeProps): JSX.Element {
  const node = data as BlueprintNodeData;
  const editable = node.kind === 'authored';

  return (
    <div
      className="node blueprint-node"
      data-kind="blueprint"
      data-provenance={node.kind === 'derived' ? 'DERIVED' : 'STATED'}
      data-selected={selected ? 'true' : 'false'}
    >
      <Handle type="target" position={Position.Left} />
      <div className="meta" style={{ marginBottom: 4 }}>
        <span
          className={node.kind === 'derived' ? 'provenance' : 'provenance stated-chip'}
          title={node.kind === 'derived' ? 'A real module, traced from imports.' : 'Authored by you.'}
        >
          {node.kind === 'derived' ? 'DERIVED' : 'STATED'}
        </span>
      </div>

      {editable ? (
        <input
          className="name blueprint-phrase-input"
          value={node.phrase}
          onChange={(event) => node.onRename?.(id, event.target.value)}
          placeholder="phrase"
          title="The DSL subject/object phrase this node stands for."
        />
      ) : (
        <div className="name" title={node.phrase}>
          {node.phrase}
        </div>
      )}

      <div className="meta">
        <label className="mustnotcycle" title="Add 'must not cycle' for this node">
          <input
            type="checkbox"
            checked={node.mustNotCycle === true}
            disabled={!editable}
            onChange={() => node.onToggleCycle?.(id)}
          />
          no cycle
        </label>
        {editable && (
          <button type="button" className="link" onClick={() => node.onRemove?.(id)} title="Remove this node">
            remove
          </button>
        )}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
