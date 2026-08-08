import type { SummaryResponse } from './api-types';

export interface SummaryPanelProps {
  summary: SummaryResponse;
}

/**
 * The run summary, shown rather than asserted.
 *
 * The resolution rate is only trustworthy if you can see what it excludes, so
 * the unresolved reasons and real examples sit next to the number. A user who
 * disagrees with the rate can go and look.
 */
export function SummaryPanel({ summary }: SummaryPanelProps): JSX.Element {
  const unresolvedReasons = Object.entries(summary.unresolvedByReason).sort((a, b) => b[1] - a[1]);
  const externalReasons = Object.entries(summary.externalByReason).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <h2>Run summary</h2>

      <div className="rate" data-good={summary.resolutionRate >= 95}>
        {summary.resolutionRate.toFixed(2)}%
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        import resolution rate — 1 − (unresolved ÷ total)
      </div>

      <h3>Imports</h3>
      <div className="rows">
        <Row k="Total" v={summary.imports.total} />
        <Row k="Internal (edges in the graph)" v={summary.imports.internal} />
        <Row k="External (identified packages)" v={summary.imports.external} />
        <Row k="Unresolved" v={summary.imports.unresolved} />
      </div>

      {externalReasons.length > 0 && (
        <>
          <h3>External, by kind</h3>
          <div className="rows">
            {externalReasons.map(([reason, count]) => (
              <Row key={reason} k={reason} v={count} />
            ))}
          </div>
        </>
      )}

      {unresolvedReasons.length > 0 && (
        <>
          <h3>Unresolved, by reason</h3>
          <div className="rows">
            {unresolvedReasons.map(([reason, count]) => (
              <Row key={reason} k={reason} v={count} />
            ))}
          </div>

          <h3>Unresolved examples</h3>
          <div className="rows">
            {summary.unresolvedExamples.slice(0, 12).map((example) => (
              <div className="row" key={`${example.file}:${example.line}:${example.specifier}`}>
                <span className="k mono" title={`${example.reason} — ${example.file}:${example.line}`}>
                  {example.specifier || '(relative)'}
                </span>
                <span className="v mono" style={{ fontSize: 11 }}>
                  {example.file.split('/').pop()}:{example.line}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>Files</h3>
      <div className="rows">
        <Row k="Files analysed" v={summary.files} />
        <Row k="File-level edges" v={summary.fileEdges} />
        {Object.entries(summary.languages)
          .filter(([, count]) => count > 0)
          .map(([language, count]) => (
            <Row key={language} k={language} v={count} />
          ))}
      </div>

      <h3>Parsing</h3>
      <div className="rows">
        <Row k="Parsed" v={summary.parse.filesParsed} />
        <Row k="Failed" v={summary.parse.filesFailed} />
        <Row k="Recovered syntax errors" v={summary.parse.filesWithSyntaxErrors} />
        <Row k="Duration" v={`${summary.parse.durationMs} ms`} />
      </div>

      {summary.topExternals.length > 0 && (
        <>
          <h3>Most used external packages</h3>
          <div className="rows">
            {summary.topExternals.slice(0, 12).map((external) => (
              <Row key={external.name} k={external.name} v={external.count} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: number | string }): JSX.Element {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{typeof v === 'number' ? v.toLocaleString() : v}</span>
    </div>
  );
}
