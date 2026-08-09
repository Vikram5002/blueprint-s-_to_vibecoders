import type { CorrectionsResponse, CorrectionStatus, CorrectionSummary } from './api-types';

export interface CorrectionsPanelProps {
  corrections: CorrectionsResponse;
  onDelete: (id: string) => void;
}

const STATUS_LABEL: Record<CorrectionStatus, string> = {
  applied: 'applied',
  'applied-with-drift': 'drifted',
  orphaned: 'orphaned',
  pending: 'next run',
};

/**
 * What happened to each stored correction on this run.
 *
 * Orphans and drift are the reason this panel exists. A correction that has
 * quietly stopped matching is worse than one that was never made, so the files
 * that joined and left are listed by name rather than counted, and an orphan
 * is called out at the top instead of being left to scroll past.
 */
export function CorrectionsPanel({ corrections, onDelete }: CorrectionsPanelProps): JSX.Element {
  const { summary } = corrections;
  const orphaned = corrections.corrections.filter((c) => c.status === 'orphaned');
  const drifted = corrections.corrections.filter((c) => c.status === 'applied-with-drift');

  return (
    <div>
      <h2>Your corrections</h2>

      {corrections.corrections.length === 0 ? (
        <div className="hint">
          None yet. Select a module and use <b>rename</b>, <b>merge</b> or <b>split</b> to correct the
          grouping — corrections are stored and reapplied on later runs.
        </div>
      ) : (
        <>
          <div className="rows" style={{ marginBottom: 10 }}>
            <Row k="Stored" v={summary.total} />
            <Row k="Applied cleanly" v={summary.applied} />
            <Row k="Applied with drift" v={summary.drifted} />
            <Row k="Orphaned" v={summary.orphaned} />
          </div>

          {orphaned.length > 0 && (
            <div className="banner">
              {orphaned.length === 1 ? (
                <>
                  1 correction no longer matches any module and <b>was not reapplied</b>. The code
                  moved too far since you made it.
                </>
              ) : (
                <>
                  {orphaned.length} corrections no longer match any module and{' '}
                  <b>were not reapplied</b>. The code moved too far since you made them.
                </>
              )}
            </div>
          )}

          {drifted.length > 0 && (
            <div className="banner" data-tone="info">
              {drifted.length} correction{drifted.length === 1 ? ' was' : 's were'} reapplied to a module whose
              membership has changed. Check the files below are still what you meant.
            </div>
          )}

          {corrections.corrections.map((correction) => (
            <CorrectionCard key={correction.id} correction={correction} onDelete={onDelete} />
          ))}
        </>
      )}
    </div>
  );
}

function CorrectionCard({
  correction,
  onDelete,
}: {
  correction: CorrectionSummary;
  onDelete: (id: string) => void;
}): JSX.Element {
  return (
    <div className="evidence-group" data-status={correction.status}>
      <header>
        <span className={`tag-status tag-${correction.status}`}>{STATUS_LABEL[correction.status]}</span>
        {correction.kind}
        {correction.label !== null && ` → ${correction.label}`}
        {correction.status !== 'pending' && correction.status !== 'orphaned' && (
          <span className="hint"> · {(correction.overlap * 100).toFixed(0)}% match</span>
        )}
      </header>

      <div style={{ padding: '6px 9px' }}>
        <div className="hint" style={{ fontSize: 11 }}>
          {correction.explanation}
        </div>

        {correction.sides.length > 0 && (
          <div className="hint mono" style={{ fontSize: 10, marginTop: 4 }}>
            sides: {correction.sides.map((side) => `${side.label} (${side.files.length})`).join(' · ')}
          </div>
        )}

        <FileList label="joined" files={correction.joined} tone="joined" />
        <FileList label="left" files={correction.left} tone="left" />
        <FileList label="in neither side" files={correction.unresolved} tone="unresolved" />

        <button type="button" className="link" style={{ marginTop: 6 }} onClick={() => onDelete(correction.id)}>
          forget this correction
        </button>
      </div>
    </div>
  );
}

function FileList({
  label,
  files,
  tone,
}: {
  label: string;
  files: string[];
  tone: string;
}): JSX.Element | null {
  if (files.length === 0) {
    return null;
  }

  return (
    <div style={{ marginTop: 5 }}>
      <div className="hint" style={{ fontSize: 10 }} data-tone={tone}>
        {label} ({files.length})
      </div>
      {files.slice(0, 8).map((file) => (
        <div key={file} className="mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>
          {tone === 'joined' ? '+ ' : tone === 'left' ? '− ' : '? '}
          {file}
        </div>
      ))}
      {files.length > 8 && (
        <div className="hint" style={{ fontSize: 10 }}>
          … and {files.length - 8} more
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: number }): JSX.Element {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
