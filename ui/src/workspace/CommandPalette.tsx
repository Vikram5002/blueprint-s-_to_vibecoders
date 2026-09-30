import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Icon, type IconName } from '../design/Icon';
import { filterCommands, withHeadings, type Command } from './command-palette';
import { fetchProviders, selectProvider } from './provider-api-client';
import { fetchWorkflowSession, listWorkflowSessions } from './workflow-api-client';
import { useWorkspaceStore, type Tab } from './store';
import type { ProviderStatus } from './provider-types';
import type { WorkflowSessionSummary } from './workflow-session-types';

const TABS: readonly {
  readonly tab: Tab;
  readonly label: string;
  readonly icon: IconName;
  readonly keywords: string;
}[] = [
  { tab: 'conversation', label: 'Agent', icon: 'sparkles', keywords: 'conversation build prompt' },
  { tab: 'workflow', label: 'Workflow', icon: 'flow', keywords: 'graph plan generate' },
  { tab: 'page-builder', label: 'Page builder', icon: 'layout', keywords: 'design ui canvas' },
  { tab: 'verification', label: 'Verification', icon: 'shield', keywords: 'check rules' },
];

/**
 * Ctrl/Cmd+K: one box that reaches everything - start or import a project,
 * jump to a view, open any saved project by name, or switch the AI model -
 * without the mouse. Opened from anywhere; closed with Escape or a click
 * outside.
 */
export function CommandPalette(): JSX.Element | null {
  const open = useWorkspaceStore((state) => state.commandOpen);
  const setOpen = useWorkspaceStore((state) => state.setCommandOpen);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(!useWorkspaceStore.getState().commandOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  return open ? <PaletteDialog onClose={() => setOpen(false)} /> : null;
}

function PaletteDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [sessions, setSessions] = useState<readonly WorkflowSessionSummary[]>([]);
  const [providers, setProviders] = useState<readonly ProviderStatus[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const commands = useCommands(sessions, providers);
  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    listWorkflowSessions().then(setSessions, () => {});
    fetchProviders().then(
      (response) => setProviders(response.providers),
      () => {},
    );
  }, []);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function run(command: Command | undefined): void {
    if (command === undefined) return;
    onClose();
    void command.run();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(matches[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="anim-fade fixed inset-0 z-[100] flex items-start justify-center bg-black/55 px-4 pt-[13vh] backdrop-blur-[3px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        data-testid="command-palette"
        onMouseDown={(event) => event.stopPropagation()}
        className="anim-pop glass w-full max-w-[620px] overflow-hidden rounded-2xl border border-white/[0.1] shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4">
          <Icon name="search" size={17} className="text-slate-400" />
          <input
            autoFocus
            data-testid="command-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command, or search your projects…"
            aria-label="Search commands and projects"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-slate-50 placeholder:text-slate-500 focus-visible:outline-none"
          />
          <span className="kbd">Esc</span>
        </div>

        <div
          ref={listRef}
          className="max-h-[min(420px,60vh)] overflow-y-auto p-2"
          role="listbox"
          aria-label="Commands"
        >
          {matches.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-slate-500">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            withHeadings(matches).map((row) =>
              'heading' in row ? (
                <div
                  key={`h-${row.heading}`}
                  className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-slate-500 first:pt-1.5"
                >
                  {row.heading}
                </div>
              ) : (
                <button
                  key={row.command.id}
                  type="button"
                  role="option"
                  aria-selected={row.index === active}
                  data-active={row.index === active}
                  data-testid="command-item"
                  onMouseMove={() => setActive(row.index)}
                  onClick={() => run(row.command)}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-[13.5px] text-slate-200 data-[active=true]:bg-white/[0.08] data-[active=true]:text-white"
                >
                  <Icon
                    name={row.command.icon}
                    size={16}
                    className="flex-shrink-0 text-slate-400"
                  />
                  <span className="min-w-0 flex-1 truncate">{row.command.label}</span>
                  {row.command.hint !== undefined && (
                    <span className="flex-shrink-0 text-xs text-slate-500">{row.command.hint}</span>
                  )}
                  {row.index === active && (
                    <Icon name="arrow-right" size={14} className="flex-shrink-0 text-slate-400" />
                  )}
                </button>
              ),
            )
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-white/[0.07] px-4 py-2.5 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> to move
          </span>
          <span className="flex items-center gap-1.5">
            <span className="kbd">Enter</span> to open
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="kbd">Ctrl</span>
            <span className="kbd">K</span> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

const dateOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
};

/** Every command the palette offers right now, in display order. */
function useCommands(
  sessions: readonly WorkflowSessionSummary[],
  providers: readonly ProviderStatus[],
): readonly Command[] {
  const startNewProject = useWorkspaceStore((state) => state.startNewProject);
  const setImportOpen = useWorkspaceStore((state) => state.setImportOpen);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const sidebarCollapsed = useWorkspaceStore((state) => state.sidebarCollapsed);
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);
  const openSession = useWorkspaceStore((state) => state.openSession);
  const notifyProvidersChanged = useWorkspaceStore((state) => state.notifyProvidersChanged);

  return useMemo(() => {
    const actions: Command[] = [
      {
        id: 'new-project',
        group: 'Actions',
        label: 'New project',
        icon: 'plus',
        keywords: 'create start agent build',
        run: startNewProject,
      },
      {
        id: 'import',
        group: 'Actions',
        label: 'Import a project from a folder or Git',
        icon: 'folder',
        keywords: 'continue open existing',
        run: () => setImportOpen(true),
      },
      {
        id: 'sidebar',
        group: 'Actions',
        label: sidebarCollapsed ? 'Show the sidebar' : 'Hide the sidebar',
        icon: sidebarCollapsed ? 'chevrons-right' : 'chevrons-left',
        keywords: 'toggle collapse expand',
        run: toggleSidebar,
      },
    ];
    const tabs: Command[] = TABS.map((entry) => ({
      id: `tab-${entry.tab}`,
      group: 'Go to',
      label: entry.label,
      icon: entry.icon,
      keywords: entry.keywords,
      run: () => setActiveTab(entry.tab),
    }));
    const projects: Command[] = sessions.map((session) => ({
      id: `session-${session.id}`,
      group: 'Projects',
      label: `Open ${session.title}`,
      icon: 'history',
      hint: dateOf(session.createdAt),
      run: async () => openSession(await fetchWorkflowSession(session.id)),
    }));
    const models: Command[] = providers.map((provider) => ({
      id: `model-${provider.id}`,
      group: 'AI model',
      label: `Plan with ${provider.label}`,
      icon: 'cpu',
      keywords: `model provider switch ${provider.id}`,
      ...(provider.available ? {} : { hint: 'not set up' }),
      run: async () => {
        await selectProvider(provider.id);
        notifyProvidersChanged();
      },
    }));
    return [...actions, ...tabs, ...projects, ...models];
  }, [
    sessions,
    providers,
    sidebarCollapsed,
    startNewProject,
    setImportOpen,
    toggleSidebar,
    setActiveTab,
    openSession,
    notifyProvidersChanged,
  ]);
}
