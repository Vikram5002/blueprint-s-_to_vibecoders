import { useState } from 'react';
import { WorkflowGraph } from './WorkflowGraph';
import { SMALL_PROJECT_SCHEMA, LARGE_PROJECT_SCHEMA } from './workflow-mocks';

type Scenario = 'small' | 'large';

/**
 * The deterministic workflow graph, reached via the "Workflow graph" tab in
 * WorkspaceShell. No orchestrator exists yet (see src/types/project-schema.ts);
 * both scenarios are hand-built ProjectSchema mocks (workflow-mocks.ts). The
 * "large" one exists specifically to exercise the pagination scale guard —
 * its backend domain has 350 components, deliberately over the 300
 * direct-expansion limit — not to demonstrate a realistic project.
 */
export function WorkflowDemo(): JSX.Element {
  const [scenario, setScenario] = useState<Scenario>('small');
  const schema = scenario === 'small' ? SMALL_PROJECT_SCHEMA : LARGE_PROJECT_SCHEMA;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setScenario('small')}
            data-active={scenario === 'small'}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
          >
            Small project
          </button>
          <button
            type="button"
            onClick={() => setScenario('large')}
            data-active={scenario === 'large'}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
          >
            Large project (350-component scale test)
          </button>
        </div>
        <span className="rounded border border-amber-700/50 bg-amber-950/20 px-2 py-1 text-[11px] text-amber-300">
          No backend exists yet. This is a hand-built ProjectSchema mock (src/types/project-schema.ts)
          — no orchestrator run produced it.
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <WorkflowGraph key={scenario} schema={schema} />
      </div>
    </div>
  );
}
