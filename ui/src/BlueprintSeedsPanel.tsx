import { useCallback, useEffect, useState } from 'react';
import { fetchBlueprint, fetchBlueprintSeeds, acceptBlueprintSeeds } from './api';
import type { ConstraintResponse } from './api-types';

/**
 * Part A.2: "start from current" — candidates proposed from the graph that
 * already holds, shown for explicit accept/reject, never applied on their
 * own. See seed.ts's header comment for why silent acceptance is exactly the
 * mistake this panel exists to not make: every candidate here is
 * `source.type === 'seeded-from-derived'`, and none of them is a constraint
 * — checked by conformance, checkable by `check_import` — until its checkbox
 * is ticked and Add is pressed.
 */
export function BlueprintSeedsPanel(): JSX.Element {
  const [candidates, setCandidates] = useState<ConstraintResponse[] | null>(null);
  const [alreadyAdded, setAlreadyAdded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([fetchBlueprintSeeds(), fetchBlueprint()])
      .then(([seeds, blueprint]) => {
        setCandidates(seeds.candidates);
        setAlreadyAdded(new Set(blueprint.constraints.map((c) => c.id)));
        setSelected((current) => {
          const next = new Set(current);
          for (const id of next) {
            if (!seeds.candidates.some((c) => c.id === id)) next.delete(id);
          }
          return next;
        });
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(reload, [reload]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const acceptSelected = useCallback(() => {
    if (selected.size === 0) return;
    setBusy(true);
    setNotice(null);
    acceptBlueprintSeeds([...selected])
      .then((result) => {
        setNotice(`Added ${result.accepted.length} constraint(s) to the blueprint.`);
        setSelected(new Set());
        reload();
      })
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setBusy(false));
  }, [selected, reload]);

  if (candidates === null) {
    return <div className="hint">Loading candidates…</div>;
  }

  const pending = candidates.filter((candidate) => !alreadyAdded.has(candidate.id));

  return (
    <div className="stated" style={{ marginBottom: 18 }}>
      <h2>
        Start from current
        <span className="provenance stated-chip" title="Proposed from the graph. Not a constraint until accepted.">
          SEEDED
        </span>
      </h2>
      <div className="hint" style={{ marginBottom: 10 }}>
        Layering that already holds today, offered as candidate rules. Nothing
        here is checked until you accept it — an unaccepted candidate never
        reaches conformance.
      </div>

      {error !== null && <div className="banner">{error}</div>}
      {notice !== null && (
        <div className="banner" data-tone="stated">
          {notice}{' '}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      {pending.length === 0 ? (
        <div className="hint">
          {candidates.length === 0
            ? 'No one-directional module boundaries to propose yet.'
            : 'Every current candidate has already been added.'}
        </div>
      ) : (
        <>
          <div className="rows">
            {pending.map((candidate) => (
              <label key={candidate.id} className="row" style={{ cursor: 'pointer' }}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.id)}
                    onChange={() => toggle(candidate.id)}
                  />
                  <span className="k mono" style={{ whiteSpace: 'normal' }}>
                    “{candidate.rawText}”
                  </span>
                </span>
                <span className="v" title={`confidence ${(candidate.confidence * 100).toFixed(0)}%`}>
                  {(candidate.confidence * 100).toFixed(0)}%
                </span>
              </label>
            ))}
          </div>
          <button type="button" onClick={acceptSelected} disabled={busy || selected.size === 0} style={{ marginTop: 10 }}>
            {busy ? 'adding…' : `add ${selected.size || ''} to blueprint`}
          </button>
        </>
      )}
    </div>
  );
}
