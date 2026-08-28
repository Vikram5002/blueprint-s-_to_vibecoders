import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { PromptBar } from './PromptBar';
import { LayoutDemo } from './LayoutDemo';
import { VerificationDemo } from './VerificationDemo';
import { WorkflowDemo } from './WorkflowDemo';

type Tab = 'conversation' | 'layout' | 'verification' | 'workflow';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'layout', label: 'Layout (mock)' },
  { id: 'verification', label: 'Verification (mock)' },
  { id: 'workflow', label: 'Workflow graph (mock)' },
];

/**
 * The workspace shell: collapsible sidebar, a tab strip, and one content
 * region below it. Placeholder content only — no API calls, no streaming,
 * no persistence. `min-w-0` on the flex children is load-bearing: without it
 * a flex item refuses to shrink below its content's natural width, which is
 * exactly what breaks this layout at 768px.
 *
 * The three mock-data features (Module C's layout selection, the
 * three-outcome verification result display, and the deterministic workflow
 * graph) previously each had their own "temporary" button opening an
 * unrelated modal. Replaced with a single tab strip so there is one coherent
 * way to move between every area of the workspace, not four disconnected
 * entry points. None of the three is part of the shell's real conversational
 * flow yet — they remain mock-data views reached by tab instead of by modal.
 */
export function WorkspaceShell(): JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('conversation');

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-slate-100">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          role="tablist"
          aria-label="Workspace sections"
          className="flex flex-shrink-0 gap-1 border-b border-slate-800 bg-slate-950 px-3 py-1.5"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="rounded px-2.5 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-100 aria-selected:bg-slate-800 aria-selected:text-slate-100"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'conversation' && (
          <>
            <ConversationPane />
            <PromptBar />
          </>
        )}
        {activeTab === 'layout' && <LayoutDemo />}
        {activeTab === 'verification' && <VerificationDemo />}
        {activeTab === 'workflow' && <WorkflowDemo />}
      </div>
    </div>
  );
}
