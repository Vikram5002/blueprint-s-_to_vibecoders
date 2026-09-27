import { useState } from 'react';
import { pickFolderNatively } from '../projects-api-client';
import { fetchWorkflowSession, importProjectViaApi, type ImportSource } from './workflow-api-client';
import { useWorkspaceStore } from './store';

type DialogState =
  | { readonly kind: 'editing' }
  | { readonly kind: 'importing'; readonly phase: string }
  | { readonly kind: 'error'; readonly message: string };

const PHASE: Record<string, string> = {
  generating: 'Reading the project…',
  installing: 'Installing its dependencies…',
  building: 'Building it…',
  reverifying: 'Checking its architecture rules…',
};

/**
 * Import a project a person has been building - kept in a local folder or
 * pushed to Git - so it opens as a session they can keep editing: Page
 * Builder, backend sync, add or remove components, fix build errors.
 */
export function ImportProjectDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const openSession = useWorkspaceStore((state) => state.openSession);
  const notifySessionSaved = useWorkspaceStore((state) => state.notifySessionSaved);
  const notifyRunSaved = useWorkspaceStore((state) => state.notifyRunSaved);
  const [kind, setKind] = useState<'local' | 'git'>('local');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [state, setState] = useState<DialogState>({ kind: 'editing' });

  async function browse(): Promise<void> {
    try {
      const picked = await pickFolderNatively();
      if (picked !== null) setPath(picked);
    } catch (cause) {
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function handleImport(): Promise<void> {
    const source: ImportSource = kind === 'local' ? { kind: 'local', path } : { kind: 'git', url, branch };
    setState({ kind: 'importing', phase: kind === 'git' ? 'Cloning the repository…' : 'Reading the project…' });
    try {
      const { job, sessionId } = await importProjectViaApi(source, {
        onStatus: (j) => setState({ kind: 'importing', phase: PHASE[j.phase ?? ''] ?? 'Working…' }),
      });
      if (job.status === 'failed') {
        const error = job.error;
        setState({ kind: 'error', message: error === undefined ? 'import failed' : 'message' in error ? error.message : error.failure.message });
        return;
      }
      notifySessionSaved();
      notifyRunSaved();
      openSession(await fetchWorkflowSession(sessionId));
      onClose();
    } catch (cause) {
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  const busy = state.kind === 'importing';
  const ready = kind === 'local' ? path.trim() !== '' : url.trim() !== '';
  const input = 'w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500';
  return (
    <div role="dialog" aria-label="Import a project" className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div data-testid="import-dialog" className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
        <h3 className="text-sm font-semibold text-slate-100">Continue a project you have been building</h3>
        <p className="mt-1 text-[11px] text-slate-400">
          A project from this tool that you downloaded and kept working on - in a folder on this PC or pushed to Git. It opens as a session:
          edit its pages, add or remove components, sync the backend. Your own files are kept as they are.
        </p>
        <div className="mt-3 flex gap-1">
          {(['local', 'git'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
              className={`rounded-md border px-3 py-1 text-xs ${kind === option ? 'border-sky-600 bg-sky-950/50 text-sky-200' : 'border-slate-700 text-slate-300'}`}
            >
              {option === 'local' ? 'Folder on this PC' : 'Git repository'}
            </button>
          ))}
        </div>
        {kind === 'local' ? (
          <div className="mt-3 flex gap-2">
            <input data-testid="import-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="D:\projects\my-shop" className={input} />
            <button type="button" onClick={() => void browse()} disabled={busy} className="rounded-md border border-slate-700 px-3 text-xs text-slate-200 hover:bg-slate-800">
              Browse…
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <input data-testid="import-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/my-shop" className={input} />
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch (optional - default branch)" className={input} />
          </div>
        )}
        {state.kind === 'importing' && <p className="mt-3 text-xs text-slate-300">{state.phase}</p>}
        {state.kind === 'error' && <p data-testid="import-error" className="mt-3 text-xs text-red-300">{state.message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
          <button
            type="button"
            data-testid="import-submit"
            onClick={() => void handleImport()}
            disabled={busy || !ready}
            className="rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50"
          >
            {busy ? 'Importing…' : 'Import and open'}
          </button>
        </div>
      </div>
    </div>
  );
}
