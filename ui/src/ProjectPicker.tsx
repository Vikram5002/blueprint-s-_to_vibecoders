import { useEffect, useRef, useState } from 'react';
import {
  browseFolders,
  fetchProjectJob,
  fetchRecentProjects,
  pickFolderNatively,
  startAnalysis,
  switchToHomeProject,
} from './projects-api-client';
import { SegmentedControl } from './design/SegmentedControl';
import type { BrowseResponse, CurrentProject, ProjectJob, RecentProject } from './projects-types';

type Tab = 'local' | 'git';

const POLL_MS = 700;

interface ProjectPickerProps {
  readonly current: CurrentProject | null;
  readonly onClose: () => void;
  /** Called once a new project is being served, so the page can reload its data. */
  readonly onSwitched: () => void;
}

/**
 * Choose which project the analysis views show: a folder on this machine, or
 * a public Git repository. The analysis runs on the server in the background;
 * this dialog shows its progress and closes itself when the new project is
 * being served.
 */
export function ProjectPicker({ current, onClose, onSwitched }: ProjectPickerProps): JSX.Element {
  const [tab, setTab] = useState<Tab>(current?.source.kind === 'git' ? 'git' : 'local');
  const [path, setPath] = useState(current?.source.kind === 'local' ? current.source.path : '');
  const [url, setUrl] = useState(current?.source.kind === 'git' ? current.source.url : '');
  const [branch, setBranch] = useState(current?.source.kind === 'git' ? current.source.branch : '');
  const [modelLabels, setModelLabels] = useState(false);
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [recent, setRecent] = useState<readonly RecentProject[]>([]);
  const [job, setJob] = useState<ProjectJob | null>(
    current !== null && (current.job.status === 'cloning' || current.job.status === 'analysing')
      ? current.job
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const polling = useRef<number | null>(null);

  useEffect(() => {
    void fetchRecentProjects().then(setRecent);
    return () => {
      if (polling.current !== null) window.clearInterval(polling.current);
    };
  }, []);

  // Resume watching a job already running (the dialog was closed and reopened).
  useEffect(() => {
    if (
      job !== null &&
      (job.status === 'cloning' || job.status === 'analysing') &&
      polling.current === null
    )
      watch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function watch(): void {
    if (polling.current !== null) window.clearInterval(polling.current);
    polling.current = window.setInterval(() => {
      fetchProjectJob()
        .then((latest) => {
          setJob(latest);
          if (latest.status === 'succeeded' || latest.status === 'failed') {
            if (polling.current !== null) window.clearInterval(polling.current);
            polling.current = null;
            if (latest.status === 'succeeded') onSwitched();
          }
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    }, POLL_MS);
  }

  async function analyse(request: Parameters<typeof startAnalysis>[0]): Promise<void> {
    setError(null);
    try {
      const accepted = await startAnalysis(request);
      // A folder that is the home project switches instantly, with no job to watch.
      if (accepted.job.status === 'succeeded' && accepted.root !== current?.root) {
        onSwitched();
        return;
      }
      setJob(accepted.job);
      watch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function openBrowse(target: string): Promise<void> {
    setError(null);
    try {
      setBrowse(await browseFolders(target));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function nativePick(): Promise<void> {
    setPicking(true);
    setError(null);
    try {
      const picked = await pickFolderNatively();
      if (picked !== null) {
        setPath(picked);
        setBrowse(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
    }
  }

  async function backHome(): Promise<void> {
    try {
      await switchToHomeProject();
      onSwitched();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const running = job !== null && (job.status === 'cloning' || job.status === 'analysing');

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => event.target === event.currentTarget && !running && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-picker-title"
        data-testid="project-picker"
      >
        <div className="modal-head">
          <h2 id="project-picker-title">Analyse a project</h2>
          <button
            type="button"
            className="control"
            onClick={onClose}
            disabled={running}
            aria-label="Close"
          >
            Close
          </button>
        </div>

        {current !== null && (
          <p className="hint">
            Now showing: <span className="mono">{current.root}</span>
            {!current.isHome && (
              <>
                {' '}
                ·{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void backHome()}
                  disabled={running}
                >
                  back to this tool&apos;s own project
                </button>
              </>
            )}
          </p>
        )}

        <SegmentedControl<Tab>
          ariaLabel="Project source"
          kind="tabs"
          className="modal-tabs"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'local', label: 'Local folder', disabled: running },
            { value: 'git', label: 'Git repository', disabled: running },
          ]}
        />

        {tab === 'local' ? (
          <div className="form">
            <label htmlFor="project-path">Folder on this computer</label>
            <div className="input-row">
              <input
                id="project-path"
                data-testid="project-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="D:\projects\my-app"
                disabled={running}
              />
              <button
                type="button"
                className="control"
                onClick={() => void nativePick()}
                disabled={running || picking}
                title="Opens your computer's own folder window"
              >
                {picking ? 'Waiting…' : 'Choose folder…'}
              </button>
              <button
                type="button"
                className="control"
                onClick={() => void openBrowse(path)}
                disabled={running}
              >
                Browse
              </button>
            </div>
            <p className="hint">
              The folder picker may open behind this browser window. Analysis writes a small{' '}
              <span className="mono">.vibe</span> folder into the project, exactly like running the
              CLI there.
            </p>

            {browse !== null && (
              <div className="browser" data-testid="folder-browser">
                <div className="browser-head">
                  <span className="mono">{browse.path === '' ? 'This computer' : browse.path}</span>
                  {browse.parent !== null && (
                    <button
                      type="button"
                      className="control"
                      onClick={() => void openBrowse(browse.parent ?? '')}
                    >
                      Up
                    </button>
                  )}
                  {browse.path !== '' && (
                    <button
                      type="button"
                      className="control primary"
                      onClick={() => {
                        setPath(browse.path);
                        setBrowse(null);
                      }}
                    >
                      Use this folder
                    </button>
                  )}
                </div>
                <ul>
                  {browse.entries.length === 0 && <li className="hint">No sub-folders.</li>}
                  {browse.entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void openBrowse(entry.path)}
                      >
                        📁 {entry.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="form">
            <label htmlFor="project-url">Repository URL (public, HTTPS)</label>
            <input
              id="project-url"
              data-testid="project-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repo"
              disabled={running}
            />
            <label htmlFor="project-branch">Branch or tag (optional)</label>
            <input
              id="project-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="default branch"
              disabled={running}
            />
            <p className="hint">
              Cloned (latest commit only) into this tool&apos;s{' '}
              <span className="mono">.vibe/repos</span> folder. Private repositories aren&apos;t
              supported here: clone one yourself and use Local folder.
            </p>
          </div>
        )}

        <label className="check-row">
          <input
            type="checkbox"
            checked={modelLabels}
            onChange={(event) => setModelLabels(event.target.checked)}
            disabled={running}
          />
          Name modules with the AI model (one API call per module; off uses folder names). Reading
          the project&apos;s documents always uses the model, one call per document.
        </label>

        {error !== null && <div className="notice-bad">{error}</div>}

        {job !== null && job.status !== 'idle' && (
          <div className="job" data-status={job.status} data-testid="project-job">
            <div>
              <b>
                {job.status === 'failed'
                  ? 'Failed'
                  : job.status === 'succeeded'
                    ? 'Done'
                    : job.status === 'cloning'
                      ? 'Cloning'
                      : 'Analysing'}
              </b>{' '}
              <span className="mono">{job.target}</span>
            </div>
            <div className="hint">{job.message}</div>
            {running && (
              <div className="progress">
                <div className="progress-bar" style={{ width: `${job.percent ?? 5}%` }} />
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="control primary"
            data-testid="project-analyse"
            disabled={running || (tab === 'local' ? path.trim() === '' : url.trim() === '')}
            onClick={() =>
              void analyse(
                tab === 'local'
                  ? { kind: 'local', path, modelLabels }
                  : { kind: 'git', url, branch, modelLabels },
              )
            }
          >
            {running ? 'Working…' : 'Analyse'}
          </button>
        </div>

        {recent.length > 0 && (
          <>
            <h3>Recent</h3>
            <ul className="recent">
              {recent.map((entry) => (
                <li key={`${entry.source.kind}:${entry.label}`}>
                  <button
                    type="button"
                    className="link-button"
                    disabled={running}
                    onClick={() => {
                      if (entry.source.kind === 'local') {
                        setTab('local');
                        setPath(entry.source.path);
                      } else {
                        setTab('git');
                        setUrl(entry.source.url);
                        setBranch(entry.source.branch);
                      }
                    }}
                  >
                    {entry.source.kind === 'git' ? '🌐' : '📁'} {entry.label}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
