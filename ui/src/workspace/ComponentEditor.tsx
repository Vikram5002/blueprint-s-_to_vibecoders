import { useState } from 'react';
import { editComponentsViaApi } from './workflow-api-client';
import type { ApplicationJob } from './application-job-types';
import type { ProjectSchema } from './project-schema-types';

type Domain = 'frontend' | 'backend' | 'database' | 'security';
const DOMAINS: readonly Domain[] = ['frontend', 'backend', 'database', 'security'];
const DOMAIN_LABEL: Record<Domain, string> = { frontend: 'Pages', backend: 'API routes', database: 'Database', security: 'Security' };

interface ComponentEditorProps {
  readonly job: ApplicationJob;
  readonly schema: ProjectSchema;
  /** Called with the finished edit run. */
  readonly onDone: (job: ApplicationJob) => void;
}

/**
 * Add or remove components on a finished run. Marked removals and new
 * components are sent together as one edit: removed files go, new components
 * are generated against the existing code, and everything else - generated or
 * hand-written - is kept exactly as it is.
 */
export function ComponentEditor({ job, schema, onDone }: ComponentEditorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<readonly { domain: Domain; name: string; purpose: string }[]>([]);
  const [draft, setDraft] = useState<{ domain: Domain; name: string; purpose: string }>({ domain: 'frontend', name: '', purpose: '' });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const key = (domain: Domain, name: string): string => `${domain}:${name}`;
  const toggle = (domain: Domain, name: string): void =>
    setRemoving((current) => {
      const next = new Set(current);
      if (next.has(key(domain, name))) next.delete(key(domain, name));
      else next.add(key(domain, name));
      return next;
    });

  async function apply(): Promise<void> {
    setBusy(true);
    setStatus('Starting…');
    try {
      const remove = [...removing].map((entry) => {
        const [domain = '', ...rest] = entry.split(':');
        return { domain, name: rest.join(':') };
      });
      const finished = await editComponentsViaApi(job.id, { add: added, remove }, { onStatus: (j) => setStatus(j.phase ?? j.status) });
      setRemoving(new Set());
      setAdded([]);
      setStatus(finished.status === 'succeeded' ? null : 'The edit run failed - see its report below.');
      onDone(finished);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const changes = removing.size + added.length;
  const input = 'rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500';
  return (
    <div data-testid="component-editor" className="mt-3 rounded-lg border border-violet-800/50 bg-violet-950/10 p-3">
      <button type="button" data-testid="toggle-component-editor" onClick={() => setOpen(!open)} className="text-xs font-semibold text-violet-300">
        {open ? '▾' : '▸'} Add or remove components
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {DOMAINS.map((domain) => (
              <div key={domain}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{DOMAIN_LABEL[domain]}</div>
                <ul className="space-y-0.5">
                  {schema.domains[domain].components.map((component) => {
                    const marked = removing.has(key(domain, component.name));
                    return (
                      <li key={component.id} className="flex items-center justify-between gap-1 text-[11px]">
                        <span className={marked ? 'text-red-300 line-through' : 'text-slate-200'}>{component.name}</span>
                        <button
                          type="button"
                          data-testid={`remove-${component.name}`}
                          onClick={() => toggle(domain, component.name)}
                          title={marked ? 'Keep it' : 'Remove it (its file is deleted)'}
                          className="rounded px-1 text-slate-500 hover:bg-slate-800 hover:text-red-300"
                        >
                          {marked ? '↺' : '×'}
                        </button>
                      </li>
                    );
                  })}
                  {added
                    .filter((item) => item.domain === domain)
                    .map((item) => (
                      <li key={item.name} className="text-[11px] text-emerald-300">
                        + {item.name}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value as Domain })} className={input}>
              {DOMAINS.map((domain) => (
                <option key={domain} value={domain}>
                  {DOMAIN_LABEL[domain]}
                </option>
              ))}
            </select>
            <input data-testid="new-component-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name, e.g. Checkout Page" className={input} />
            <input
              data-testid="new-component-purpose"
              value={draft.purpose}
              onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
              placeholder="What it does, e.g. lets a shopper pay for their cart"
              className={`${input} min-w-[260px] flex-1`}
            />
            <button
              type="button"
              data-testid="add-component"
              disabled={draft.name.trim() === '' || draft.purpose.trim() === ''}
              onClick={() => {
                setAdded([...added, { domain: draft.domain, name: draft.name.trim(), purpose: draft.purpose.trim() }]);
                setDraft({ ...draft, name: '', purpose: '' });
              }}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              + Add
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="apply-component-edit"
              onClick={() => void apply()}
              disabled={busy || changes === 0}
              className="rounded-lg border border-violet-600 bg-violet-950/40 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-900/40 disabled:opacity-40"
            >
              {busy ? 'Applying…' : `Apply ${changes} change${changes === 1 ? '' : 's'}`}
            </button>
            <span className="text-[11px] text-slate-400">
              {status ?? 'Only new components use the model; everything you already have is kept.'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
