import { CorrectionControls } from './CorrectionControls';
import { ProvenanceBadge } from './ProvenanceBadge';
import type { LabelSource, ModuleDetailResponse, ModuleNodeSummary } from './api-types';
import type { NewCorrectionRequest } from './api';

export interface ModulePanelProps {
  module: ModuleDetailResponse;
  onSelectEdge: (edgeId: string) => void;
  /** Where this module's name came from, and what it would be without a model. */
  labelSource: LabelSource;
  mechanicalLabel: string;
  description: string | null;
  allModules: readonly ModuleNodeSummary[];
  onSaveCorrection: (request: NewCorrectionRequest) => void;
  savingCorrection: boolean;
}

const REASON_LABEL: Record<string, string> = {
  'import-coupling': 'coupling',
  'directory-prior': 'directory',
  'small-cluster-merge': 'merged',
};

/**
 * Module detail, built around property 3 of the week: for any file, answer
 * "why is it in this module?". Every file carries its reason and the sentence
 * behind it, and files whose folder disagrees with the grouping are called out
 * rather than blended in — that disagreement is the finding.
 */
export function ModulePanel(props: ModulePanelProps): JSX.Element {
  const { module, onSelectEdge, labelSource, mechanicalLabel, description } = props;
  const disagreeing = module.files.filter((file) => file.disagrees);

  return (
    <div>
      <h2>
        Module
        {/* The grouping is always DERIVED; only the name can come from elsewhere. */}
        <span className="provenance" title="The grouping is derived from real import edges.">
          DERIVED
        </span>
      </h2>
      <div className="hint mono" style={{ marginBottom: 4, wordBreak: 'break-all' }}>
        <ProvenanceBadge source={labelSource} />
        {module.label}
      </div>

      {description !== null && (
        <div className="hint" style={{ marginBottom: 6, fontStyle: 'italic' }}>
          {description}
        </div>
      )}

      {labelSource !== 'mechanical' && (
        <div className="hint" style={{ marginBottom: 6, fontSize: 10 }}>
          derived name was <span className="mono">{mechanicalLabel}</span>
        </div>
      )}

      <div className="hint" style={{ marginBottom: 10 }}>
        {module.id} · {module.files.length} files · {module.directories.length}{' '}
        {module.directories.length === 1 ? 'directory' : 'directories'}
      </div>

      {disagreeing.length > 0 && (
        <div className="banner">
          {disagreeing.length} of {module.files.length} files sit in a different folder from the
          rest of this module. Import coupling groups them here; the file tree does not.
        </div>
      )}

      <h3>Directories ({module.directories.length})</h3>
      <div className="rows">
        {module.directories.map((directory) => (
          <div className="row" key={directory}>
            <span className="k mono">{directory}</span>
          </div>
        ))}
      </div>

      <h3>Depends on ({module.outbound.length})</h3>
      <Neighbours items={module.outbound} onSelectEdge={onSelectEdge} />

      <h3>Depended on by ({module.inbound.length})</h3>
      <Neighbours items={module.inbound} onSelectEdge={onSelectEdge} />

      <h3>Files ({module.files.length})</h3>
      <div className="rows">
        {module.files.map((file) => (
          <div className="row" key={file.path} style={{ display: 'block' }}>
            <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {file.disagrees && <span className="tag-disagree">≠ folder</span>}
              {file.path}
            </div>
            <div className="hint" style={{ fontSize: 10, marginTop: 2 }}>
              <span className="tag-reason">{REASON_LABEL[file.reason] ?? file.reason}</span>
              {file.explanation}
            </div>
          </div>
        ))}
      </div>

      <CorrectionControls
        module={module}
        allModules={props.allModules}
        onSave={props.onSaveCorrection}
        busy={props.savingCorrection}
      />
    </div>
  );
}

function Neighbours({
  items,
  onSelectEdge,
}: {
  items: ModuleDetailResponse['inbound'];
  onSelectEdge: (edgeId: string) => void;
}): JSX.Element {
  if (items.length === 0) {
    return <div className="hint">None.</div>;
  }

  return (
    <div className="rows">
      {items.map((item) => (
        <div className="row" key={item.edgeId}>
          <span className="k mono">{item.id}</span>
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
