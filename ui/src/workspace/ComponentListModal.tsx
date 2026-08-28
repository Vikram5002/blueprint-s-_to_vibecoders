import { useState } from 'react';
import { paginateComponents, exceedsDirectListLimit, COMPONENTS_PER_PAGE } from './workflow-layout';
import type { DomainName, DomainSpec } from './project-schema-types';

export interface ComponentListModalProps {
  readonly domain: DomainName;
  readonly spec: DomainSpec;
  readonly onClose: () => void;
}

const DOMAIN_LABEL: Readonly<Record<DomainName, string>> = {
  frontend: 'Frontend',
  backend: 'Backend',
  database: 'Database',
  security: 'Security',
};

/**
 * The scale guard, made concrete: a domain's components are never rendered
 * as individual graph nodes (WorkflowGraph only ever draws the four fixed
 * domain nodes) and never dumped into one flat list either — always this
 * fixed-size paginated view, regardless of domain size. That means a domain
 * with 350 components and a domain with 3 go through the identical code
 * path; the only difference is how many pages there are.
 */
export function ComponentListModal({
  domain,
  spec,
  onClose,
}: ComponentListModalProps): JSX.Element {
  const [page, setPage] = useState(1);
  const result = paginateComponents(spec, page);
  const large = exceedsDirectListLimit(spec);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-6">
      <div className="w-full max-w-2xl rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">
            {DOMAIN_LABEL[domain]} components ({result.totalComponents})
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-400 hover:text-slate-100"
          >
            Close
          </button>
        </div>

        {large && (
          <div className="mb-4 rounded border border-amber-700/50 bg-amber-950/20 p-2 text-xs text-amber-300">
            This domain has {result.totalComponents} components — over the direct-expansion limit,
            so it is never offered as individual graph nodes. Shown here {COMPONENTS_PER_PAGE} at a
            time instead.
          </div>
        )}

        <ul className="mb-4 space-y-2" data-testid="component-page-list">
          {result.items.map((item) => (
            <li
              key={item.id}
              className="rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm"
            >
              <div className="font-medium text-slate-100">{item.name}</div>
              <div className="text-xs text-slate-500">{item.purpose}</div>
            </li>
          ))}
        </ul>

        {result.totalComponents === 0 && (
          <p className="text-sm text-slate-500">No components in this domain yet.</p>
        )}

        {result.totalPages > 1 && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={result.page <= 1}
              className="rounded border border-slate-700 px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Previous
            </button>
            <span>
              Page {result.page} of {result.totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(result.totalPages, current + 1))}
              disabled={result.page >= result.totalPages}
              className="rounded border border-slate-700 px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
