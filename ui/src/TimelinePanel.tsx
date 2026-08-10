import { useEffect, useState } from 'react';
import { fetchDriftHistory, fetchDiff, fetchSnapshot } from './api';
import type { DiffResponse, DriftHistoryResponse, DriftPointResponse, SnapshotResponse } from './api-types';

/**
 * Drift over time, and what moved it.
 *
 * Week 9 established that a flat line next to a real refactor reads as a bug
 * unless the chart explains itself, so explaining is the panel's main job. Every
 * point states whether it moved the score, and if it did not, whether that is
 * because nothing changed or because what changed broke no rule.
 *
 * Reads `/api/drift-history`, `/api/diff` and `/api/snapshot`. Computes nothing.
 */
export function TimelinePanel(): JSX.Element {
  const [history, setHistory] = useState<DriftHistoryResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);

  useEffect(() => {
    fetchDriftHistory()
      .then(setHistory)
      .catch((cause: unknown) => setHistory({ ok: false, reason: String(cause) }));
  }, []);

  useEffect(() => {
    if (selected === null || history === null || !history.ok) return;

    // The snapshot is what the repository looked like *at* this commit; the
    // diff is what changed to get there. Both are wanted, and neither implies
    // the other.
    fetchSnapshot(selected)
      .then(setSnapshot)
      .catch((cause: unknown) => setSnapshot({ ok: false, reason: String(cause) }));

    const points = history.history.points;
    const index = points.findIndex((point) => point.commit === selected);
    if (index <= 0) {
      setDiff(null);
      return;
    }
    const previous = points[index - 1];
    if (previous === undefined) return;

    fetchDiff(previous.commit, selected)
      .then(setDiff)
      .catch((cause: unknown) => setDiff({ ok: false, reason: String(cause), available: [] }));
  }, [selected, history]);

  if (history === null) return <div className="hint">Loading history…</div>;

  if (!history.ok) {
    return (
      <div>
        <h2>Drift over time</h2>
        <div className="banner">{history.reason}</div>
        <div className="hint">
          Snapshots are built on demand because each one costs a git worktree and a
          full re-analysis. Run <span className="mono">vibe-blueprint . --history=20</span>{' '}
          once, then reload.
        </div>
      </div>
    );
  }

  const { points, summary } = history.history;
  const peak = Math.max(summary.peak, 1);
  const point = points.find((candidate) => candidate.commit === selected) ?? null;

  return (
    <div>
      <h2>
        Drift over time
        <span className="provenance stated-chip" title="Drift compares stated rules against the derived graph.">
          STATED vs DERIVED
        </span>
      </h2>

      <div className="hint" style={{ marginBottom: 8 }}>
        {summary.commits} commits · score {summary.first.toFixed(1)} → {summary.last.toFixed(1)} ·
        peak {summary.peak.toFixed(1)}
      </div>

      <div className="timeline">
        {points.map((candidate) => (
          <button
            type="button"
            key={candidate.commit}
            className="tick"
            data-selected={candidate.commit === selected}
            data-moved={candidate.delta !== 0}
            data-changed={candidate.changeCount > 0}
            title={
              `${candidate.shortCommit} — ${candidate.subject}\n` +
              `drift ${candidate.score.toFixed(1)}` +
              (candidate.delta === 0 ? ' (unchanged)' : ` (${candidate.delta > 0 ? '+' : ''}${candidate.delta.toFixed(1)})`) +
              `\n${candidate.changeCount} architectural change(s)`
            }
            onClick={() => setSelected(candidate.commit)}
          >
            <span className="bar" style={{ height: `${Math.max(3, (candidate.score / peak) * 56)}px` }} />
          </button>
        ))}
      </div>

      <div className="legend">
        <span>
          <i className="swatch swatch-flat" /> no rule broken
        </span>
        <span>
          <i className="swatch swatch-changed" /> architecture changed
        </span>
        <span>
          <i className="swatch swatch-moved" /> drift moved
        </span>
        <span className="hint" style={{ fontSize: 10 }}>
          oldest → newest
        </span>
      </div>

      {/*
        Week 9's finding, stated up front rather than left for the user to
        wonder about: on this repository 11 of 19 steps changed the architecture
        without moving the score at all.
      */}
      <div className="hint" style={{ fontSize: 11, marginBottom: 12 }}>
        {summary.note}
      </div>

      {point === null ? (
        <div className="hint">Click a commit to see what changed and what it broke.</div>
      ) : (
        <CommitDetail point={point} diff={diff} snapshot={snapshot} />
      )}
    </div>
  );
}

/**
 * One commit: why the score did or did not move, then what changed, then what
 * the repository looked like afterwards.
 */
function CommitDetail({
  point,
  diff,
  snapshot,
}: {
  point: DriftPointResponse;
  diff: DiffResponse | null;
  snapshot: SnapshotResponse | null;
}): JSX.Element {
  return (
    <div className="commit-detail">
      <h3>
        {point.shortCommit}{' '}
        <span className="hint" style={{ fontWeight: 400 }}>
          {new Date(point.committedAt).toISOString().slice(0, 10)}
        </span>
      </h3>
      <div className="hint mono" style={{ fontSize: 11, marginBottom: 8 }}>
        {point.subject}
      </div>

      <div className="rows" style={{ marginBottom: 8 }}>
        <div className="row">
          <span className="k">drift</span>
          <span className="v">
            {point.score.toFixed(1)}
            {point.delta !== 0 && (
              <span data-tone={point.delta > 0 ? 'bad' : 'good'}>
                {' '}
                ({point.delta > 0 ? '+' : ''}
                {point.delta.toFixed(1)})
              </span>
            )}
          </span>
        </div>
        <div className="row">
          <span className="k">violations at this commit</span>
          <span className="v">{point.violationCount}</span>
        </div>
        <div className="row">
          <span className="k">architectural changes</span>
          <span className="v">{point.changeCount}</span>
        </div>
        <div className="row">
          <span className="k">files / modules</span>
          <span className="v">
            {point.fileCount} / {point.moduleCount}
          </span>
        </div>
      </div>

      <WhyItMoved point={point} />

      {diff !== null && !diff.ok && <div className="banner">{diff.reason}</div>}
      {diff !== null && diff.ok && (
        <>
          {!diff.diff.summary.comparable && (
            <div className="banner">{diff.diff.summary.comparabilityNote}</div>
          )}
          <h3>Changes ({diff.diff.entries.length})</h3>
          <div className="rows">
            {diff.diff.entries.slice(0, 25).map((entry, index) => (
              <div className="row" key={`${entry.kind}-${entry.key}-${index}`} style={{ display: 'block' }}>
                <div style={{ fontSize: 11 }}>
                  <span className="tag-reason">{entry.kind.replace(/-/g, ' ')}</span>
                  {entry.description}
                </div>
                {entry.evidence.length > 0 && (
                  <div className="hint mono" style={{ fontSize: 10, marginTop: 2 }}>
                    {entry.evidence.slice(0, 3).join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
          {diff.diff.entries.length > 25 && (
            <div className="hint" style={{ marginTop: 6 }}>
              … and {diff.diff.entries.length - 25} more.
            </div>
          )}
        </>
      )}

      {snapshot !== null && snapshot.ok && snapshot.snapshot.violations.length > 0 && (
        <>
          <h3>Violations at this commit ({snapshot.snapshot.violations.length})</h3>
          <div className="rows">
            {snapshot.snapshot.violations.map((violation) => (
              <div className="row" key={violation.id} style={{ display: 'block' }}>
                <div style={{ fontSize: 11 }}>
                  <span className={`tag-status tag-sev-${violation.severity}`}>{violation.severity}</span>
                  {violation.explanation}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The explanation Week 9 said the chart needs.
 *
 * Three distinct situations all render as "the line did not move", and telling
 * them apart is the difference between a chart that looks broken and one that
 * is informative.
 */
function WhyItMoved({ point }: { point: DriftPointResponse }): JSX.Element {
  if (point.causes.length > 0) {
    return (
      <div className="banner" data-tone="info">
        <b>Why the score moved:</b>
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          {point.causes.map((cause, index) => (
            <li key={index} style={{ fontSize: 11 }}>
              {cause}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (point.changeCount > 0) {
    return (
      <div className="hint" style={{ marginBottom: 8 }}>
        <b>The score did not move, and that is correct.</b> This commit made{' '}
        {point.changeCount} architectural change
        {point.changeCount === 1 ? '' : 's'}, but drift only moves when a stated
        rule breaks or is fixed — and none did.
      </div>
    );
  }

  return (
    <div className="hint" style={{ marginBottom: 8 }}>
      No architectural change at this commit. Files may well have changed, but no
      import, module, rule or violation did.
    </div>
  );
}
