import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { PromptBar } from './PromptBar';
import { LayoutDemo } from './LayoutDemo';
import { VerificationDemo } from './VerificationDemo';
import { WorkflowDemo } from './WorkflowDemo';

/**
 * The three-region shell: collapsible sidebar, conversation pane, prompt bar.
 * Placeholder content only — no API calls, no streaming, no persistence.
 * `min-w-0` on the flex children is load-bearing: without it a flex item
 * refuses to shrink below its content's natural width, which is exactly what
 * breaks a three-region layout at 768px.
 *
 * The "Layout Demo", "Verification Demo", and "Workflow Graph" buttons are
 * temporary entry points into disconnected mock-data UI (Module C's layout
 * selection, the three-outcome verification result display, and the
 * deterministic workflow graph respectively) — none is part of the shell's
 * real flow yet.
 */
export function WorkspaceShell(): JSX.Element {
  const [showLayoutDemo, setShowLayoutDemo] = useState(false);
  const [showVerificationDemo, setShowVerificationDemo] = useState(false);
  const [showWorkflowDemo, setShowWorkflowDemo] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-slate-100">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 justify-end gap-2 border-b border-slate-800 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setShowWorkflowDemo(true)}
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            Workflow Graph (mock data)
          </button>
          <button
            type="button"
            onClick={() => setShowVerificationDemo(true)}
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            Verification Demo (mock data)
          </button>
          <button
            type="button"
            onClick={() => setShowLayoutDemo(true)}
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            Layout Demo (mock data)
          </button>
        </div>
        <ConversationPane />
        <PromptBar />
      </div>
      {showLayoutDemo && <LayoutDemo onClose={() => setShowLayoutDemo(false)} />}
      {showVerificationDemo && <VerificationDemo onClose={() => setShowVerificationDemo(false)} />}
      {showWorkflowDemo && <WorkflowDemo onClose={() => setShowWorkflowDemo(false)} />}
    </div>
  );
}
