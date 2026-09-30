/**
 * Choosing which project the analysis views show: a folder on this machine,
 * or a public Git repository cloned for the purpose.
 *
 * Analysing a project takes seconds to minutes (walk, parse, cluster, name,
 * read documents), so it runs as one background job whose progress the UI
 * polls - the same submit-and-poll shape as the generation jobs. When the job
 * finishes, the context holder swaps to the new project and every analysis
 * route answers about it from the next request on. Nothing about the
 * workspace (sessions, providers, generated applications) moves: those stay
 * in the database of the repository the server was started in.
 *
 * Only one analysis runs at a time. A second request while one is running is
 * refused rather than queued - two pipelines racing to replace the same
 * holder would leave the UI showing whichever happened to finish last.
 */
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { runPipeline } from '../pipeline/run.js';
import { cloneDirectoryFor, cloneRepository, parseGitUrl, validateBranch, type CloneOptions, type CloneResult } from '../ingest/git-source.js';
import { err, ok, type Result } from '../types/result.js';
import type { SettingsStore } from '../store/settings-store.js';
import { toAnalysisContext } from './analysis-context.js';
import type { AnalysisContext } from './context.js';
import type { ContextHolder } from './context-holder.js';

export type ProjectSource =
  | { readonly kind: 'home' }
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'git'; readonly url: string; readonly branch: string; readonly commit: string };

export type JobStatus = 'idle' | 'cloning' | 'analysing' | 'succeeded' | 'failed';

export interface ProjectJob {
  readonly status: JobStatus;
  /** What is being analysed, in words: a path or a URL. */
  readonly target: string;
  /** The current step in plain words, e.g. "Parsing files 120 of 480". */
  readonly message: string;
  /** 0-100 when the current step reports one; absent otherwise. */
  readonly percent?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface RecentProject {
  readonly label: string;
  readonly source: Exclude<ProjectSource, { kind: 'home' }>;
  readonly analysedAt: string;
}

export interface AnalyseOptions {
  /** Let the model name the modules (one call per module). Off means mechanical names, no API calls for naming. */
  readonly modelLabels: boolean;
  readonly onProgress: (message: string, percent?: number) => void;
}

export interface ProjectRouteDeps {
  readonly holder: ContextHolder;
  /** Where cloned repositories are kept, one folder per URL. */
  readonly cloneRoot: string;
  readonly settings: SettingsStore;
  /** Injectable for tests; defaults to the real pipeline. */
  readonly analyse?: (root: string, options: AnalyseOptions) => Promise<Result<AnalysisContext, string>>;
  /** Injectable for tests; defaults to the real git clone. */
  readonly clone?: (url: string, directory: string, options: CloneOptions) => Promise<Result<CloneResult, string>>;
  /** Injectable for tests; defaults to the operating system's own folder dialog. */
  readonly pickFolder?: () => Promise<Result<string | null, string>>;
}

export const RECENT_PROJECTS_SETTING_KEY = 'projects.recent';
const MAX_RECENT = 8;
const MAX_BROWSE_ENTRIES = 500;

export function createProjectRoutes(deps: ProjectRouteDeps): Hono {
  const analyse = deps.analyse ?? analyseWithPipeline;
  const clone = deps.clone ?? cloneRepository;
  const pickFolder = deps.pickFolder ?? pickFolderNatively;
  const app = new Hono();

  let source: ProjectSource = { kind: 'home' };
  let job: ProjectJob = { status: 'idle', target: '', message: '' };

  const busy = (): boolean => job.status === 'cloning' || job.status === 'analysing';

  function describeCurrent() {
    const current = deps.holder.current();
    return { root: current.root, isHome: current === deps.holder.home, source, job };
  }

  function remember(entry: RecentProject): void {
    const existing = readRecent(deps.settings).filter((item) => !sameSource(item.source, entry.source));
    deps.settings.set(RECENT_PROJECTS_SETTING_KEY, JSON.stringify([entry, ...existing].slice(0, MAX_RECENT)));
  }

  async function run(target: string, work: () => Promise<Result<{ context: AnalysisContext; source: ProjectSource }, string>>): Promise<void> {
    const outcome = await work().catch((cause: unknown) => err(`unexpected: ${String(cause)}`));
    const finishedAt = new Date().toISOString();
    if (!outcome.ok) {
      // Drop the last progress value: "failed" shown beside 80% reads as
      // though the work nearly finished.
      const { percent: _lastPercent, ...rest } = job;
      job = { ...rest, status: 'failed', message: outcome.error, finishedAt };
      return;
    }
    deps.holder.replace(outcome.value.context);
    source = outcome.value.source;
    job = { status: 'succeeded', target, message: `Analysed ${outcome.value.context.root}`, finishedAt, ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }) };
    if (source.kind !== 'home') {
      remember({ label: labelFor(source), source, analysedAt: finishedAt });
    }
  }

  const progress = (message: string, percent?: number): void => {
    const { percent: _previous, ...rest } = job;
    job = percent === undefined ? { ...rest, message } : { ...rest, message, percent };
  };

  app.get('/current', (c) => c.json(describeCurrent()));
  app.get('/job', (c) => c.json(job));
  app.get('/recent', (c) => c.json({ recent: readRecent(deps.settings) }));

  app.post('/analyse', async (c) => {
    if (busy()) return c.json({ error: `already analysing ${job.target} - wait for it to finish` }, 409);

    const body: unknown = await c.req.json().catch(() => null);
    const request = parseAnalyseRequest(body);
    if (!request.ok) return c.json({ error: request.error }, 400);
    const { modelLabels } = request.value;
    const startedAt = new Date().toISOString();

    if (request.value.kind === 'local') {
      const root = resolve(request.value.path);
      const info = await stat(root).catch(() => null);
      if (info === null) return c.json({ error: `That folder does not exist: ${root}` }, 400);
      if (!info.isDirectory()) return c.json({ error: `That is a file, not a folder: ${root}` }, 400);

      if (samePath(root, deps.holder.home.root)) {
        deps.holder.replace(deps.holder.home);
        source = { kind: 'home' };
        job = { status: 'succeeded', target: root, message: 'Back to the project this tool was started in.', startedAt, finishedAt: startedAt };
        return c.json(describeCurrent());
      }

      job = { status: 'analysing', target: root, message: 'Starting analysis…', startedAt };
      void run(root, async () => {
        const analysed = await analyse(root, { modelLabels, onProgress: progress });
        return analysed.ok ? ok({ context: analysed.value, source: { kind: 'local', path: root } }) : analysed;
      });
      return c.json(describeCurrent(), 202);
    }

    const { url, branch } = request.value;
    const parsed = parseGitUrl(url);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const branchCheck = validateBranch(branch);
    if (!branchCheck.ok) return c.json({ error: branchCheck.error }, 400);
    const directory = cloneDirectoryFor(deps.cloneRoot, parsed.value);

    job = { status: 'cloning', target: parsed.value.url, message: 'Cloning the repository…', startedAt };
    void run(parsed.value.url, async () => {
      const cloned = await clone(parsed.value.url, directory, {
        branch: branchCheck.value,
        onProgress: (percent, phase) => progress(`Cloning: ${phase}`, percent),
      });
      if (!cloned.ok) return cloned;
      job = { ...job, status: 'analysing', message: 'Starting analysis…' };
      const analysed = await analyse(cloned.value.directory, { modelLabels, onProgress: progress });
      if (!analysed.ok) return analysed;
      return ok({ context: analysed.value, source: { kind: 'git', url: parsed.value.url, branch: branchCheck.value, commit: cloned.value.commit } });
    });
    return c.json(describeCurrent(), 202);
  });

  app.post('/home', (c) => {
    if (busy()) return c.json({ error: `already analysing ${job.target} - wait for it to finish` }, 409);
    deps.holder.replace(deps.holder.home);
    source = { kind: 'home' };
    return c.json(describeCurrent());
  });

  app.get('/browse', async (c) => {
    const requested = c.req.query('path') ?? '';
    if (requested.trim() === '') {
      return c.json({ path: '', parent: null, entries: await startingPoints() });
    }
    const path = resolve(requested);
    const listed = await listDirectories(path);
    if (!listed.ok) return c.json({ error: listed.error }, 400);
    const parent = dirname(path);
    return c.json({ path, parent: parent === path ? '' : parent, entries: listed.value });
  });

  app.post('/pick-folder', async (c) => {
    const picked = await pickFolder();
    if (!picked.ok) return c.json({ error: picked.error }, 501);
    return c.json(picked.value === null ? { cancelled: true } : { path: picked.value });
  });

  return app;
}

type AnalyseRequest =
  | { readonly kind: 'local'; readonly path: string; readonly modelLabels: boolean }
  | { readonly kind: 'git'; readonly url: string; readonly branch: string; readonly modelLabels: boolean };

function parseAnalyseRequest(body: unknown): Result<AnalyseRequest, string> {
  if (typeof body !== 'object' || body === null) return err('expected { kind: "local", path } or { kind: "git", url }');
  const record = body as Record<string, unknown>;
  const modelLabels = record['modelLabels'] === true;
  if (record['kind'] === 'local') {
    const path = record['path'];
    if (typeof path !== 'string' || path.trim() === '') return err('Enter the folder to analyse.');
    return ok({ kind: 'local', path: path.trim(), modelLabels });
  }
  if (record['kind'] === 'git') {
    const url = record['url'];
    const branch = record['branch'];
    if (typeof url !== 'string') return err('Enter the repository URL.');
    return ok({ kind: 'git', url, branch: typeof branch === 'string' ? branch : '', modelLabels });
  }
  return err('kind must be "local" or "git"');
}

async function analyseWithPipeline(root: string, options: AnalyseOptions): Promise<Result<AnalysisContext, string>> {
  const run = await runPipeline({
    root,
    mechanicalLabels: !options.modelLabels,
    onProgress: (p) =>
      p.stage === 'walk'
        ? options.onProgress(`Finding files: ${p.filesFound} found`)
        : options.onProgress(`Parsing files ${p.filesParsed} of ${p.filesTotal}`, Math.round((p.filesParsed / Math.max(1, p.filesTotal)) * 100)),
    onLabelProgress: (done, total) => options.onProgress(`Naming modules ${done} of ${total}`, Math.round((done / Math.max(1, total)) * 100)),
    onIntentProgress: (done, total) => options.onProgress(`Reading documents ${done} of ${total}`, Math.round((done / Math.max(1, total)) * 100)),
  });
  return run.ok ? ok(toAnalysisContext(run.value)) : err(run.error.message);
}

function readRecent(settings: SettingsStore): RecentProject[] {
  const raw = settings.get(RECENT_PROJECTS_SETTING_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentProject[]) : [];
  } catch {
    return [];
  }
}

function sameSource(a: RecentProject['source'], b: RecentProject['source']): boolean {
  if (a.kind === 'local' && b.kind === 'local') return samePath(a.path, b.path);
  if (a.kind === 'git' && b.kind === 'git') return a.url === b.url && a.branch === b.branch;
  return false;
}

function labelFor(source: Exclude<ProjectSource, { kind: 'home' }>): string {
  if (source.kind === 'git') return `${source.url.replace(/^https:\/\//, '')}${source.branch === '' ? '' : ` @ ${source.branch}`}`;
  return source.path;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

interface BrowseEntry {
  readonly name: string;
  readonly path: string;
}

async function listDirectories(path: string): Promise<Result<BrowseEntry[], string>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return ok(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && !entry.name.startsWith('$'))
        .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_BROWSE_ENTRIES),
    );
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return err(`That folder does not exist: ${path}`);
    if (code === 'EPERM' || code === 'EACCES') return err(`No permission to open: ${path}`);
    if (code === 'ENOTDIR') return err(`That is a file, not a folder: ${path}`);
    return err(`Could not open ${path}: ${String(cause)}`);
  }
}

/** Drive letters on Windows (only the ones that exist), the home folder elsewhere. */
async function startingPoints(): Promise<BrowseEntry[]> {
  if (process.platform !== 'win32') return [{ name: homedir(), path: homedir() }];
  const drives: BrowseEntry[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    if (await stat(root).then(() => true, () => false)) drives.push({ name: `${letter}:`, path: root });
  }
  return drives;
}

const PICK_FOLDER_TIMEOUT_MS = 5 * 60_000;

/**
 * Opens the operating system's own "choose a folder" dialog. A browser cannot
 * hand a server the absolute path of a folder it picked (that is a deliberate
 * browser security rule), but this server runs on the same machine as the
 * person using it, so the server can show the native dialog itself. Returns
 * null when the person cancels.
 */
function pickFolderNatively(): Promise<Result<string | null, string>> {
  if (process.platform === 'win32') {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = 'Choose a project folder to analyse'",
      '$dialog.ShowNewFolderButton = $false',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }",
    ].join('; ');
    return runPicker('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  }
  if (process.platform === 'darwin') {
    return runPicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a project folder to analyse")']);
  }
  return runPicker('zenity', ['--file-selection', '--directory', '--title=Choose a project folder to analyse']);
}

function runPicker(command: string, args: readonly string[]): Promise<Result<string | null, string>> {
  return new Promise((resolvePicker) => {
    let out = '';
    const child = spawn(command, args, { windowsHide: false });
    const timer = setTimeout(() => {
      child.kill();
      resolvePicker(ok(null));
    }, PICK_FOLDER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      resolvePicker(err('No folder dialog is available on this system. Type the path or use Browse instead.'));
    });
    child.on('close', () => {
      clearTimeout(timer);
      const picked = out.trim().replace(/\/$/, '');
      resolvePicker(ok(picked === '' ? null : picked));
    });
  });
}
