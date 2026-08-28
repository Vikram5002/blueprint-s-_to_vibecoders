import { useState } from 'react';
import { WorkflowGraph } from './WorkflowGraph';
import { SMALL_PROJECT_SCHEMA, LARGE_PROJECT_SCHEMA } from './workflow-mocks';

type Scenario = 'small' | 'large';

interface WorkflowDemoProps {
  readonly onClose: () => void;
}

/**
 * Demo entry point for the workflow graph — disconnected from the rest of
 * the shell, reachable only from the temporary "Workflow Graph" button in
 * WorkspaceShell, same pattern as LayoutDemo and VerificationDemo. No
 * orchestrator exists yet (see src/types/project-schema.ts); both scenarios
 * are hand-built ProjectSchema mocks (workflow-mocks.ts). The "large" one
 * exists specifically to exercise the pagination scale guard — its backend
 * domain has 350 components, deliberately over the 300 direct-expansion
 * limit — not to demonstrate a realistic project.
 */
export function WorkflowDemo({ onClose }: WorkflowDemoProps): JSX.Element {
  const [scenario, setScenario] = useState<Scenario>('small');
  const schema = scenario === 'small' ? SMALL_PROJECT_SCHEMA : LARGE_PROJECT_SCHEMA;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-950">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-100">Workflow graph (mock data)</h2>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setScenario('small')}
              data-active={scenario === 'small'}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
            >
              Small project
            </button>
            <button
              type="button"
              onClick={() => setScenario('large')}
              data-active={scenario === 'large'}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
            >
              Large project (350-component scale test)
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-slate-400 hover:text-slate-100"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <WorkflowGraph key={scenario} schema={schema} />
      </div>
    </div>
  );
}
