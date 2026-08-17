import { useWorkspaceStore } from './store';

/** Empty today — no session persistence exists yet. Real list replaces this later. */
const SESSION_PLACEHOLDERS: readonly string[] = [];

/**
 * 240px expanded, a narrow icon rail when collapsed. Collapse state lives in
 * the Zustand store rather than local state so other regions could react to
 * it later without prop drilling — not needed today, but cheap to set up
 * right the first time.
 */
export function Sidebar(): JSX.Element {
  const collapsed = useWorkspaceStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);

  return (
    <aside
      className={`flex h-full flex-shrink-0 flex-col border-r border-slate-800 bg-slate-950 transition-[width] duration-150 ${
        collapsed ? 'w-14' : 'w-60'
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-3">
        {!collapsed && <span className="text-sm font-semibold text-slate-200">Sessions</span>}
        <button
          type="button"
          onClick={toggleSidebar}
          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-3 py-4 text-sm text-slate-500">
          {SESSION_PLACEHOLDERS.length === 0 ? (
            <p>No sessions yet.</p>
          ) : (
            <ul className="space-y-1">
              {SESSION_PLACEHOLDERS.map((session) => (
                <li key={session} className="rounded px-2 py-1.5 hover:bg-slate-900">
                  {session}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
