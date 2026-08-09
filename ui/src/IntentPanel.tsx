import type { IntentResponse, ConstraintResponse } from './api-types';

export interface IntentPanelProps {
  intent: IntentResponse;
}

const RELATION_WORDS: Record<string, string> = {
  'must-not-import': 'must not import',
  'may-only-import-via': 'may only import',
  'must-not-cycle': 'must not contain a cycle',
  'must-be-layer-above': 'must sit above',
};

const EMPTY_MESSAGE: Record<string, string> = {
  'not-attempted': 'Documents were found but not read — reading prose needs a model, and there is no mechanical fallback. This is "not attempted", not "nothing stated".',
  'no-documents': 'No README, AGENTS.md, CLAUDE.md or ADRs were found, so there was nothing to read.',
  'nothing-stated': 'The documents were read and stated no dependency rules that can be checked against an import graph.',
};

/**
 * Stated intent.
 *
 * Everything else in this UI is DERIVED — traced to an import statement. This
 * panel is the first thing that is not, and rule 2 says the two must never be
 * mistaken for each other. So the whole panel is marked, not just individual
 * rows: a claim-coloured border down the side, a STATED chip in the heading,
 * and the source file and line on every single constraint.
 *
 * The wording is chosen to keep the distinction alive in a reader's head.
 * Nothing here says a module "does" anything. It says the documentation
 * "claims", and shows the sentence it claims it in.
 *
 * That quotation is also the only defence against a constraint planted in a
 * hostile README: the tool cannot tell that a document is lying, but a human
 * looking at the exact sentence and where it came from usually can.
 */
export function IntentPanel(props: IntentPanelProps): JSX.Element {
  const { intent } = props;
  const { summary } = intent;

  return (
    <div className="stated">
      <h2>
        Stated intent
        <span className="provenance stated-chip" title="Claimed in prose. Not derived from any import.">
          STATED
        </span>
      </h2>

      <div className="hint" style={{ marginBottom: 10 }}>
        What the documentation says the architecture should be. Nothing here was
        measured — Week 8 is what compares it against the graph.
      </div>

      {intent.emptyReason !== null && (
        <div className="banner" data-tone="stated">
          {EMPTY_MESSAGE[intent.emptyReason] ?? 'Nothing to show.'}
        </div>
      )}

      {intent.constraints.length > 0 && (
        <>
          <h3>Constraints ({intent.constraints.length})</h3>
          <div className="rows">
            {intent.constraints.map((constraint) => (
              <ConstraintCard key={constraint.id} constraint={constraint} />
            ))}
          </div>
        </>
      )}

      {summary.uncheckable > 0 && (
        <>
          <h3>Architectural, but not checkable ({summary.uncheckable})</h3>
          <div className="hint" style={{ marginBottom: 6 }}>
            Real statements about the architecture that no import graph can
            decide. Counted rather than dropped, because pretending they do not
            exist would overstate how much of this project the tool can check.
          </div>
          <div className="rows">
            {intent.uncheckable.slice(0, 12).map((statement, index) => (
              <div className="row" key={`${statement.location}-${index}`} style={{ display: 'block' }}>
                <div style={{ fontSize: 11 }}>“{statement.rawText}”</div>
                <div className="hint" style={{ fontSize: 10, marginTop: 2 }}>
                  <span className="tag-reason">{statement.reason.replace(/-/g, ' ')}</span>
                  {statement.location}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {intent.constraints.length > 0 && (
        <>
          <h3>Subject resolution</h3>
          <div className="hint" style={{ marginBottom: 6 }}>
            Whether each phrase in the prose could be matched to a real module.
            Reported apart from extraction: a rule read correctly whose subject
            was never found is a different failure from a rule never read.
          </div>
          <div className="rows">
            <Row k="resolved to a module" v={String(summary.subjects.module)} />
            <Row k="resolved to a path" v={String(summary.subjects.pathPattern)} />
            <Row k="unresolved" v={String(summary.subjects.unresolved)} />
            <Row k="rate" v={`${summary.subjects.resolutionRate.toFixed(1)}%`} />
            <Row k="checkable in Week 8" v={`${summary.evaluable} of ${summary.constraints}`} />
          </div>
        </>
      )}

      {intent.failures.length > 0 && (
        <>
          <h3>Documents not read ({intent.failures.length})</h3>
          <div className="rows">
            {intent.failures.map((failure) => (
              <div className="row" key={failure.location}>
                <span className="k mono">{failure.location}</span>
                <span className="v">{failure.reason}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ConstraintCard({ constraint }: { constraint: ConstraintResponse }): JSX.Element {
  const relation = RELATION_WORDS[constraint.relation] ?? constraint.relation;

  return (
    <div className="evidence-group constraint" data-evaluable={constraint.evaluable}>
      <header>
        <span className="provenance stated-chip">STATED</span>
        {constraint.lowConfidence && (
          <span className="tag-status tag-low" title="Recorded, but stated too weakly to act on.">
            low confidence
          </span>
        )}
        {!constraint.evaluable && (
          <span className="tag-status tag-orphaned" title="A subject could not be matched to a module.">
            not checkable
          </span>
        )}
      </header>

      <div className="constraint-body">
        <div className="constraint-rule mono">
          <Role role={constraint.subject} /> <span className="rel">{relation}</span>{' '}
          {constraint.relation !== 'must-not-cycle' && <Role role={constraint.object} />}
          {constraint.via !== null && (
            <>
              {' '}
              <span className="rel">via</span> <Role role={constraint.via} />
            </>
          )}
        </div>

        {/* Rule 3 for prose: the sentence, verbatim, and where to find it. */}
        <div className="quote">“{constraint.rawText}”</div>
        <div className="hint" style={{ fontSize: 10 }}>
          {constraint.source.location}
          {constraint.source.line !== null && `:${constraint.source.line}`} ·{' '}
          {constraint.source.type} · confidence {(constraint.confidence * 100).toFixed(0)}%
        </div>
      </div>
    </div>
  );
}

/**
 * A role shows what the prose said and what it resolved to, never only the
 * resolution. If the tool guessed wrong, the phrase next to the module is what
 * makes the mistake visible.
 */
function Role({ role }: { role: ConstraintResponse['subject'] }): JSX.Element {
  if (role.status === 'UNRESOLVED') {
    return (
      <span className="role unresolved" title={`Unresolved: ${role.reason ?? 'no reason given'}`}>
        {role.phrase}
      </span>
    );
  }
  return (
    <span className="role" title={`"${role.phrase}" matched ${role.target ?? ''}`}>
      {role.target}
    </span>
  );
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
