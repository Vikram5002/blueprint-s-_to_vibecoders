import { useEffect, useState } from 'react';
import { fetchRunPages, type RunPage } from './workflow-api-client';
import { useWorkspaceStore, type PageOrigin } from './store';
import type { CanvasElement } from './page-builder-types';

interface PageSwitcherProps {
  readonly origin: PageOrigin;
  readonly elements: readonly CanvasElement[];
}

/**
 * The Page Builder's page picker for a generated run: every frontend page in
 * that run, so moving between them does not mean going back to the Workflow
 * tab each time. Switching loads the chosen page's layout (its saved edit if
 * it has one); unsaved changes on the current page are confirmed first.
 */
export function PageSwitcher({ origin, elements }: PageSwitcherProps): JSX.Element {
  const openPageInBuilder = useWorkspaceStore((state) => state.openPageInBuilder);
  const runsVersion = useWorkspaceStore((state) => state.runsVersion);
  const [pages, setPages] = useState<readonly RunPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRunPages(origin.runId)
      .then((list) => {
        if (!cancelled) setPages(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [origin.runId, origin.edited, runsVersion]);

  const current = pages?.find((page) => page.path === origin.path);
  const unsaved = current !== undefined && JSON.stringify(current.layout.elements) !== JSON.stringify(elements);

  function switchTo(path: string): void {
    const next = pages?.find((page) => page.path === path);
    if (next === undefined || path === origin.path) return;
    if (unsaved && !window.confirm(`"${current?.pageName ?? 'This page'}" has unsaved changes. Switch pages and discard them?`)) return;
    openPageInBuilder({ ...origin, path: next.path, edited: next.edited }, next.layout);
  }

  if (error !== null) return <span className="text-[11px] text-red-300">Could not list pages: {error}</span>;

  return (
    <label className="flex items-center gap-2 text-xs text-slate-400">
      Page
      <select
        data-testid="page-switcher"
        value={origin.path}
        onChange={(event) => switchTo(event.target.value)}
        disabled={pages === null}
        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
      >
        {(pages ?? [{ path: origin.path, pageName: origin.path, edited: origin.edited } as const]).map((page) => (
          <option key={page.path} value={page.path}>
            {page.pageName}
            {page.edited ? ' (edited)' : ''}
          </option>
        ))}
      </select>
      {pages !== null && <span className="text-[10px] text-slate-500">{pages.length} page(s)</span>}
      {unsaved && <span data-testid="page-unsaved" className="text-[10px] text-amber-400">unsaved changes</span>}
    </label>
  );
}
