import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { VerificationDemo } from './VerificationDemo';
import { WorkflowDemo } from './WorkflowDemo';
import { PageBuilderCanvas } from './PageBuilderCanvas';
import { ProviderPicker } from './ProviderPicker';
import { CommandPalette } from './CommandPalette';
import { DesignerChat } from './DesignerChat';
import { useWorkspaceStore, type Tab } from './store';
import { SegmentedControl } from '../design/SegmentedControl';
import { Icon, type IconName } from '../design/Icon';

const TABS: readonly { readonly id: Tab; readonly label: string; readonly icon: IconName }[] = [
  { id: 'conversation', label: 'Agent', icon: 'sparkles' },
  { id: 'workflow', label: 'Workflow', icon: 'flow' },
  { id: 'page-builder', label: 'Page builder', icon: 'layout' },
  { id: 'verification', label: 'Verification', icon: 'shield' },
];

/**
 * The workspace shell: collapsible sidebar, a header with the tab strip, and
 * one content region below it. `min-w-0` on the flex children is
 * load-bearing: without it a flex item refuses to shrink below its content's
 * natural width, which is exactly what breaks this layout at 768px.
 *
 * One tab strip for every area: Agent mode (ConversationPane.tsx), the
 * workflow graph, the Page Builder and the verification display. `activeTab`
 * lives in the shared store, so the sidebar, the command palette and "New
 * project" can all switch it from outside this component.
 */
export function WorkspaceShell(): JSX.Element {
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);
  const setCommandOpen = useWorkspaceStore((state) => state.setCommandOpen);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0c0c0e] text-slate-100">
      <Sidebar />
      <div className="app-canvas flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="relative z-20 flex h-[52px] flex-shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#0c0c0e]/60 px-3 backdrop-blur-xl">
          <SegmentedControl<Tab>
            ariaLabel="Workspace sections"
            kind="tabs"
            value={activeTab}
            onChange={setActiveTab}
            options={TABS.map((tab) => ({ value: tab.id, label: tab.label, icon: <Icon name={tab.icon} size={14} /> }))}
            className="flex-shrink-0"
          />

          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              data-testid="open-command"
              onClick={() => setCommandOpen(true)}
              title="Search and commands (Ctrl+K)"
              className="btn btn-ghost btn-sm !gap-2"
            >
              <Icon name="search" size={14} />
              <span className="hidden xl:inline">Search</span>
              <span className="kbd hidden xl:inline-flex">Ctrl K</span>
            </button>
            {/* Not inside any one tab: the choice decides who serves BOTH plan generation and the application generation that follows it. */}
            <ProviderPicker />
          </div>
        </header>

        {/* Keyed on the tab so each view fades in when it is switched to. Opacity only: a moving parent would shift the page builder's drop maths and React Flow's fit-to-view while it settles (caught by the page-builder e2e tests). */}
        <div key={activeTab} className="anim-fade flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab === 'conversation' && <ConversationPane />}
          {activeTab === 'page-builder' && (
            <>
              <PageBuilderCanvas />
              <DesignerChat />
            </>
          )}
          {activeTab === 'verification' && <VerificationDemo />}
          {activeTab === 'workflow' && <WorkflowDemo />}
        </div>
      </div>
      <CommandPalette />
    </div>
  );
}
