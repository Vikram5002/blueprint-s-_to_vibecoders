import { useState } from 'react';
import type { ViolationsResponse, ViolationResponse } from './api-types';

export interface ViolationsPanelProps {
  violations: ViolationsResponse;
  /** Highlights the implicated files on the graph. */
  onHighlight: (files: readonly string[]) => void;
  highlighted: readonly string[];
}

const SEVERITY_ORDER = ['high', 'medium', 'low'] as const;

const KIND_WORDS: Record<string, string> = {
  'forbidden-import': 'forbidden import',
  'bypassed-route': 'bypassed route',
  cycle: 'dependency cycle',
  'upward-dependency': 'upward dependency',
};

/**
 * Conformance, made readable.
 *
 * Weeks 8 and 9 computed all of this correctly and left it reachable only by
 * curl. Nothing here recomputes anything — every number and every sentence
 * comes from `/api/violations` exactly as the pipeline produced it.
 *
 * The panel is built around one idea: a violation is an accusation, so it has
 * to arrive with its evidence attached and its confidence visible. A reader who
 * disagrees should be able to see immediately *which sentence* they disagree
 * with and *which import line* triggered it, without clicking anything.
 */
export function ViolationsPanel(props: ViolationsPanelProps): JSX.Element {
  const { violations: data } = props;
  const { summary } = data;

  return (
    <div className="conformance">
      <h2>
        Conformance
        <span className="provenance" title="Edges are derived from real imports.">
          DERIVED
        </span>
        <span className="provenance stated-chip" title="Rules are claimed in prose.">
          vs STATED
        </span>
      </h2>

      <ConstraintLedger data={data} />

      {data.emptyReason !== null ? (
        <EmptyState reason={data.emptyReason} summary={summary} />
      ) : (
        <>
          <h3>
            Violations ({summary.violations}) ·{' '}
            {SEVERITY_ORDER.filter((s) => summary.bySeverity[s] > 0)
              .map((s) => `${summary.bySeverity[s]} ${s}`)
              .join(', ')}
          </h3>
          <div className="hint" style={{ marginBottom: 8 }}>
            Ranked by severity: how much the rule is trusted, times how much the
            evidence is trusted, times how entrenched the breach is.
          </div>
          <div className="rows">
            {data.violations.map((violation) => (
              <ViolationCard
                key={violation.id}
                violation={violation}
                onHighlight={props.onHighlight}
                highlighted={props.highlighted}
              />
            ))}
          </div>
        </>
      )}

      {data.unchecked.length > 0 && <UncheckedList data={data} />}
    </div>
  );
}

/**
 * What was checked, before what failed.
 *
 * A violation count alone cannot be read: zero could mean a clean repository or
 * one whose every rule was unevaluable. The ledger is shown first for that
 * reason, and it is where Week 7's uncheckable count lands too.
 */
function ConstraintLedger({ data }: { data: ViolationsResponse }): JSX.Element {
  const { summary, uncheckableStatements } = data;

  return (
    <div className="ledger">
      <div className="rows">
        <Row k="rules stated" v={String(summary.constraints)} />
        <Row k="checked against the graph" v={String(summary.checked)} />
        <Row k="satisfied" v={String(summary.satisfied)} tone={summary.satisfied > 0 ? 'good' : undefined} />
        <Row k="violated" v={String(summary.violated)} tone={summary.violated > 0 ? 'bad' : undefined} />
        {summary.unchecked > 0 && <Row k="not checkable" v={String(summary.unchecked)} tone="warn" />}
        <Row k="drift score" v={data.drift.score.toFixed(1)} />
      </div>

      <div className="hint" style={{ fontSize: 10, marginTop: 4 }}>
        {data.drift.explanation}
      </div>

      {/*
        Week 7's finding, put where it changes how the number above is read.
        Three constraints out of a document that made sixty-odd architectural
        statements is a very different thing from a document with three
        sentences in it.
      */}
      {uncheckableStatements.total > 0 && (
        <div className="banner" data-tone="stated" style={{ marginTop: 8 }}>
          <b>
            {uncheckableStatements.total} further statement
            {uncheckableStatements.total === 1 ? '' : 's'} found, not checkable.
          </b>{' '}
          Read across {uncheckableStatements.documents} document
          {uncheckableStatements.documents === 1 ? '' : 's'}, these say something
          architectural that no import graph can decide — style, process, runtime
          behaviour, technology choice. They are counted, not silently dropped:{' '}
          {Object.entries(uncheckableStatements.byReason)
            .filter(([, total]) => total > 0)
            .map(([reason, total]) => `${total} ${reason.replace(/-/g, ' ')}`)
            .join(', ')}
          .
        </div>
      )}
    </div>
  );
}

/** The three zeroes, told apart. */
function EmptyState({
  reason,
  summary,
}: {
  reason: NonNullable<ViolationsResponse['emptyReason']>;
  summary: ViolationsResponse['summary'];
}): JSX.Element {
  if (reason === 'no-constraints') {
    return (
      <div className="banner" data-tone="stated">
        <b>No violations, because no rules were found.</b> The documentation in this
        repository states nothing that can be checked against an import graph, so
        there was nothing to compare. This is not a clean bill of health — it is an
        unmeasured one.
      </div>
    );
  }

  if (reason === 'all-unchecked') {
    return (
      <div className="banner">
        <b>No violations, but nothing was actually checked.</b> All{' '}
        {summary.constraints} stated rule{summary.constraints === 1 ? '' : 's'} named
        something that could not be matched to this repository, so none could be
        evaluated. See the list below.
      </div>
    );
  }

  return (
    <div className="banner" data-tone="good">
      <b>No violations. All {summary.satisfied} rule{summary.satisfied === 1 ? '' : 's'} hold.</b>{' '}
      Every constraint the documentation states was checked against the real import
      graph and none is broken.
    </div>
  );
}

function ViolationCard({
  violation,
  onHighlight,
  highlighted,
}: {
  violation: ViolationResponse;
  onHighlight: (files: readonly string[]) => void;
  highlighted: readonly string[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const files = violation.edges.flatMap((edge) => [edge.fromFile, edge.toFile]);
  const isHighlighted = files.length > 0 && files.every((file) => highlighted.includes(file));

  return (
    <div className="evidence-group violation" data-severity={violation.severity} data-open={open}>
      <header>
        <span className={`tag-status tag-sev-${violation.severity}`}>{violation.severity}</span>
        <span className="tag-reason">{KIND_WORDS[violation.kind] ?? violation.kind}</span>
        <span className="hint" style={{ fontSize: 10 }}>
          score {violation.severityScore.toFixed(2)}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="control"
          data-active={isHighlighted}
          title="Show the files involved on the graph"
          onClick={() => onHighlight(isHighlighted ? [] : files)}
        >
          {isHighlighted ? 'clear' : 'show on graph'}
        </button>
      </header>

      <div className="constraint-body">
        <div style={{ fontSize: 12 }}>{violation.explanation}</div>

        {/* The STATED side, marked as such. Rule 2 does not relax in a UI. */}
        <div className="quote">
          <span className="provenance stated-chip">STATED</span>“{violation.constraint.rawText}”
        </div>
        <div className="hint" style={{ fontSize: 10 }}>
          {violation.constraint.source.location}
          {violation.constraint.source.line !== null && `:${violation.constraint.source.line}`} ·{' '}
          {violation.constraint.source.type} · confidence{' '}
          {(violation.constraint.confidence * 100).toFixed(0)}%
          {violation.constraint.lowConfidence && (
            <span className="tag-status tag-low" style={{ marginLeft: 6 }}>
              low confidence
            </span>
          )}
        </div>

        {/* The DERIVED side: the actual import lines. */}
        <div className="derived-evidence">
          <span className="provenance">DERIVED</span>
          {violation.edges.slice(0, open ? undefined : 2).map((edge) =>
            edge.evidence.slice(0, open ? undefined : 1).map((entry) => (
              <div className="evidence-line" key={`${edge.edgeId}-${entry.line}`}>
                <span className="loc">
                  {entry.file}:{entry.line}
                </span>
                <code>{entry.snippet.trim()}</code>
              </div>
            )),
          )}
        </div>

        {violation.edges.length > 2 && (
          <button type="button" className="link" onClick={() => setOpen(!open)}>
            {open ? 'show less' : `show all ${violation.edges.length} edges`}
          </button>
        )}

        {open && (
          <div className="hint" style={{ fontSize: 10 }}>
            severity: {violation.severityFactors.join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Rules that could not be evaluated, listed rather than counted.
 *
 * These are the ones most likely to be a problem with the documentation rather
 * than the code, and a user can only act on them if they can see which sentence
 * failed and why.
 */
function UncheckedList({ data }: { data: ViolationsResponse }): JSX.Element {
  return (
    <>
      <h3>Stated but not checkable ({data.unchecked.length})</h3>
      <div className="hint" style={{ marginBottom: 6 }}>
        These rules were read correctly but name something that could not be matched
        to this repository, so they could not be evaluated. Not counted as
        satisfied — unevaluable and passing are different results.
      </div>
      <div className="rows">
        {data.unchecked.map((entry) => (
          <div className="row" key={entry.constraintId} style={{ display: 'block' }}>
            <div style={{ fontSize: 11 }}>
              <span className="tag-status tag-orphaned">{entry.reason.replace(/-/g, ' ')}</span>“
              {entry.rawText}”
            </div>
            <div className="hint" style={{ fontSize: 10, marginTop: 2 }}>
              {entry.explanation} · {entry.source}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'good' | 'bad' | 'warn' | undefined }): JSX.Element {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v" data-tone={tone}>
        {v}
      </span>
    </div>
  );
}
