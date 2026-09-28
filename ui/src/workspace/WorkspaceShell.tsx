import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { VerificationDemo } from './VerificationDemo';
import { WorkflowDemo } from './WorkflowDemo';
import { PageBuilderCanvas } from './PageBuilderCanvas';
import { ProviderPicker } from './ProviderPicker';
import { useWorkspaceStore, type Tab } from './store';
import { SegmentedControl } from '../design/SegmentedControl';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
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
 * One tab strip for every area of the workspace: Agent mode (the
 * Conversation tab, ConversationPane.tsx), the Page Builder, the
 * three-outcome verification display and the workflow graph. The former
 * "Page regions" tab (Module C's layout presets) was folded into the Page
 * Builder as page templates - see page-templates.ts. `activeTab` lives in the shared
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
        <div className="glass relative z-10 flex flex-shrink-0 items-center gap-3 border-b border-white/[0.08] px-3 py-2">
          <SegmentedControl<Tab>
            ariaLabel="Workspace sections"
            kind="tabs"
            value={activeTab}
            onChange={setActiveTab}
            options={TABS.map((tab) => ({ value: tab.id, label: tab.label }))}
            className="flex-shrink-0"
          />

          {/* Not inside any one tab: the choice decides who serves BOTH schema generation and the application generation that follows it. */}
          <div className="ml-auto flex min-w-0 items-center">
            <ProviderPicker />
          </div>
        </div>

        {/* Keyed on the tab so each view fades in when it is switched to. Opacity only: a moving parent would shift the page builder's drop maths and React Flow's fit-to-view while it settles (caught by the page-builder e2e tests). */}
        <div key={activeTab} className="anim-fade flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab === 'conversation' && <ConversationPane />}
          {activeTab === 'page-builder' && <PageBuilderCanvas />}
          {activeTab === 'verification' && <VerificationDemo />}
          {activeTab === 'workflow' && <WorkflowDemo />}
        </div>
      </div>
    </div>
  );
}
