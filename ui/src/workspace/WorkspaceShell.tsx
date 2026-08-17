import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { PromptBar } from './PromptBar';

/**
 * The three-region shell: collapsible sidebar, conversation pane, prompt bar.
 * Placeholder content only — no API calls, no streaming, no persistence.
 * `min-w-0` on the flex children is load-bearing: without it a flex item
 * refuses to shrink below its content's natural width, which is exactly what
 * breaks a three-region layout at 768px.
 */
export function WorkspaceShell(): JSX.Element {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-slate-100">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConversationPane />
        <PromptBar />
      </div>
    </div>
  );
}
