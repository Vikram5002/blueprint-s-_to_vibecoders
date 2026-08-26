import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { PromptBar } from './PromptBar';
import { LayoutDemo } from './LayoutDemo';

/**
 * The three-region shell: collapsible sidebar, conversation pane, prompt bar.
 * Placeholder content only — no API calls, no streaming, no persistence.
 * `min-w-0` on the flex children is load-bearing: without it a flex item
 * refuses to shrink below its content's natural width, which is exactly what
 * breaks a three-region layout at 768px.
 *
 * The "Layout Demo" button is a temporary entry point into Module C
 * (layout selection UI, mock data) — disconnected new UI, not part of the
 * shell's real flow yet.
 */
export function WorkspaceShell(): JSX.Element {
  const [showLayoutDemo, setShowLayoutDemo] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-slate-100">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 justify-end border-b border-slate-800 px-3 py-1.5">
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
    </div>
  );
}
