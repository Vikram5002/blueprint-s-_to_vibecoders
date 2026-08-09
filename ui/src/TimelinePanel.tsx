import { useEffect, useState } from 'react';
import { fetchDriftHistory, fetchDiff } from './api';
import type { DiffResponse, DriftHistoryResponse } from './api-types';

/**
 * Drift over time, and what changed at each step.
 *
 * Deliberately minimal — Week 9's brief calls the full time-travel slider a
 * later polish item, and this is the functional version: a bar per commit, a
 * click to see that commit's diff, and the cause of every score movement.
 *
 * The empty state is a real state, not a spinner that never resolves. History
 * has to be built explicitly with `--history=N` because it costs a worktree and
 * a re-analysis per commit, so a user who has not done that needs telling
 * rather than left waiting.
 */
export function TimelinePanel(): JSX.Element {
  const [history, setHistory] = useState<DriftHistoryResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);

  useEffect(() => {
    fetchDriftHistory()
      .then(setHistory)
      .catch((cause: unknown) => setHistory({ ok: false, reason: String(cause) }));
  }, []);

  useEffect(() => {
    if (selected === null || history === null || !history.ok) return;
    const points = history.history.points;
    const index = points.findIndex((point) => point.commit === selected);
    // The first commit has nothing before it, so there is no diff to show.
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

  if (history === null) {
    return <div className="hint">Loading history…</div>;
  }

  if (!history.ok) {
    return (
      <div>
        <h2>Drift over time</h2>
        <div className="banner">{history.reason}</div>
        <div className="hint">
          Snapshots are built on demand because each one costs a git worktree and a
          full re-analysis. Run <span className="mono">vibe-blueprint . --history=20</span> once,
          then reload.
        </div>
      </div>
    );
  }

  const { points, summary } = history.history;
  const peak = Math.max(summary.peak, 1);

  return (
    <div>
      <h2>
        Drift over time
        <span className="provenance stated-chip" title="Drift compares stated rules against the graph.">
          STATED vs DERIVED
        </span>
      </h2>

      <div className="hint" style={{ marginBottom: 10 }}>
        {summary.commits} commits, score {summary.first.toFixed(1)} → {summary.last.toFixed(1)}.{' '}
        {summary.note}
      </div>

      <div className="timeline">
        {points.map((point) => (
          <button
            type="button"
            key={point.commit}
            className="tick"
            data-selected={point.commit === selected}
            data-moved={point.delta !== 0}
            title={`${point.shortCommit} — ${point.subject}\ndrift ${point.score.toFixed(1)}, ${point.changeCount} change(s)`}
            onClick={() => setSelected(point.commit)}
          >
            <span
              className="bar"
              /* Zero drift still gets a visible stub, so a flat history reads
                 as "measured and flat" rather than as an empty chart. */
              style={{ height: `${Math.max(2, (point.score / peak) * 60)}px` }}
            />
          </button>
        ))}
      </div>

      <div className="hint" style={{ fontSize: 10, marginBottom: 12 }}>
        oldest → newest · click a commit for its changes
      </div>

      {selected !== null && <DiffView diff={diff} />}
    </div>
  );
}

function DiffView({ diff }: { diff: DiffResponse | null }): JSX.Element {
  if (diff === null) return <div className="hint">Nothing before this commit to compare with.</div>;
  if (!diff.ok) return <div className="banner">{diff.reason}</div>;

  const { entries, summary, from, to } = diff.diff;

  return (
    <div>
      <h3>
        {from.commit.slice(0, 7)} → {to.commit.slice(0, 7)}
      </h3>
      <div className="hint mono" style={{ fontSize: 10, marginBottom: 6 }}>
        {to.subject}
      </div>

      {!summary.comparable && <div className="banner">{summary.comparabilityNote}</div>}

      {entries.length === 0 && (
        <div className="hint">
          No architectural change. Files may have changed, but no import, module,
          rule or violation did.
        </div>
      )}

      <div className="rows">
        {entries.slice(0, 40).map((entry, index) => (
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

      {entries.length > 40 && (
        <div className="hint" style={{ marginTop: 6 }}>
          … and {entries.length - 40} more.
        </div>
      )}
    </div>
  );
}
