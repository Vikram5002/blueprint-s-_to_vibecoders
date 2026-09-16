import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { PromptBar } from './PromptBar';
import { LayoutDemo } from './LayoutDemo';
import { VerificationDemo } from './VerificationDemo';
import { WorkflowDemo } from './WorkflowDemo';
import { PageBuilderCanvas } from './PageBuilderCanvas';
import { ProviderPicker } from './ProviderPicker';
import { useWorkspaceStore, type Tab } from './store';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'layout', label: 'Page regions (mock)' },
  { id: 'page-builder', label: 'Page builder' },
  { id: 'verification', label: 'Verification (mock)' },
  { id: 'workflow', label: 'Workflow graph (mock)' },
];

/**
 * The workspace shell: collapsible sidebar, a tab strip, and one content
 * region below it. `min-w-0` on the flex children is load-bearing: without it
 * a flex item refuses to shrink below its content's natural width, which is
 * exactly what breaks this layout at 768px.
 *
 * The three mock-data features (Module C's layout selection, the
 * three-outcome verification result display, and the deterministic workflow
 * graph) previously each had their own "temporary" button opening an
 * unrelated modal. Replaced with a single tab strip so there is one coherent
 * way to move between every area of the workspace, not four disconnected
 * entry points. The Conversation tab itself is still an unwired placeholder
 * (see ConversationPane/PromptBar). `activeTab` lives in the shared
 * workspace store, not local state, so the Sidebar's session list can switch
 * this shell to the Workflow graph tab from outside this component.
 */
export function WorkspaceShell(): JSX.Element {
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);

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
              className="whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-100 aria-selected:bg-slate-800 aria-selected:text-slate-100"
            >
              {tab.label}
            </button>
          ))}

          {/* Not inside any one tab: the choice decides who serves BOTH schema generation and the application generation that follows it. */}
          <div className="ml-auto flex items-center pr-1">
            <ProviderPicker />
          </div>
        </div>

        {activeTab === 'conversation' && (
          <>
            <ConversationPane />
            <PromptBar />
          </>
        )}
        {activeTab === 'layout' && <LayoutDemo />}
        {activeTab === 'page-builder' && <PageBuilderCanvas />}
        {activeTab === 'verification' && <VerificationDemo />}
        {activeTab === 'workflow' && <WorkflowDemo />}
      </div>
    </div>
  );
}
