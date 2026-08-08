import type { EdgeResponse } from './api-types';

export interface EvidencePanelProps {
  edge: EdgeResponse;
}

/**
 * The evidence trail.
 *
 * This is the point of the product. Every edge in the diagram is a claim about
 * the architecture, and this panel shows the exact source lines that produced
 * it — file, line number, and the import statement as written. It is what makes
 * "this tool never invents structure" something a user can check in five
 * seconds rather than something they have to believe.
 *
 * So nothing here is summarised or truncated away: every underlying file pair
 * is listed, and every statement behind each pair.
 */
export function EvidencePanel({ edge }: EvidencePanelProps): JSX.Element {
  const statements = edge.groups.reduce((sum, group) => sum + group.evidence.length, 0);

  return (
    <div>
      <h2>
        Edge evidence
        <span className="provenance" title="Traced to a real import in a real file">
          {edge.groups.length > 0 ? 'DERIVED' : 'NO EVIDENCE'}
        </span>
      </h2>

      <div className="hint mono" style={{ marginBottom: 10 }}>
        {edge.from} → {edge.to}
      </div>

      <div className="hint" style={{ marginBottom: 12 }}>
        {statements} import {statements === 1 ? 'statement' : 'statements'} across{' '}
        {edge.groups.length} file {edge.groups.length === 1 ? 'pair' : 'pairs'}. Every line below
        is quoted from the repository.
      </div>

      {edge.groups.map((group) => (
        <div className="evidence-group" key={`${group.source}->${group.target}`}>
          <header>
            {group.source}
            <br />→ {group.target}
          </header>
          {group.evidence.map((item) => (
            <div className="evidence-line" key={`${item.file}:${item.line}:${item.snippet}`}>
              <span className="loc" title="Open this file at this line">
                {item.file}:{item.line}
              </span>
              <code>{item.snippet}</code>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
