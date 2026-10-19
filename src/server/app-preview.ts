/**
 * Runs a generated application on this machine so it can be opened inside
 * the workspace - the same files a person gets in the zip (withRunScaffold),
 * not the verified build folder, which is never touched.
 *
 * One preview at a time: starting another stops the first. Each preview gets
 * its own folder under `previewRoot`, two free loopback ports (the backend's
 * API and Vite serving the frontend, which forwards `/api` to the backend),
 * and a small watchdog process around each server that stops it when this
 * server's process goes away, however it ends - so closing the desktop app
 * never leaves a generated app running in the background.
 *
 * Local mode only: in hosted mode the routes refuse (generation-api.ts),
 * because a preview runs model-written code on the machine that serves it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { runCommand, stopTree } from '../generate/build-and-repair.js';
import { FRONTEND_ENTRY, type ZipEntry } from '../export/runnable-project.js';

export type PreviewState = 'starting' | 'running' | 'failed' | 'stopped';
export type PreviewStep = 'install' | 'build' | 'start';

export interface PreviewStatus {
  readonly runId: string;
  readonly state: PreviewState;
  readonly step?: PreviewStep;
  /** Where the app opens: the web UI, or the API alone when the project has no frontend. */
  readonly url?: string;
  readonly error?: string;
}

export interface PreviewManager {
  /** Starts (or restarts) the preview of one run from its zip entries; returns at once, poll `status`. */
  start(runId: string, entries: readonly ZipEntry[]): PreviewStatus;
  status(runId: string): PreviewStatus;
  stop(runId: string): void;
  stopAll(): void;
}

export interface PreviewOptions {
  readonly previewRoot: string;
  /** How long a started server may take to answer; Vite's first start compiles dependencies. */
  readonly readyTimeoutMs?: number;
  /** Seam for tests: npm install / npm run build. */
  readonly run?: typeof runCommand;
}

const BACKEND_ENTRY = 'backend/src/index.ts';
const BACKEND_START = 'dist/backend/src/index.js';
const VITE_BIN = 'node_modules/vite/bin/vite.js';
const PREVIEW_CONFIG = 'vite.preview.config.mjs';
const MAX_ERROR_CHARS = 2_000;

/**
 * Started as `node -e WATCHDOG <parentPid> <command> ...args`: runs the
 * command and stops it once the parent is gone. The parent can end without
 * running any exit handler (the desktop app ends its server outright), so
 * only a process outside it can clean up.
 */
const WATCHDOG = [
  "const { spawn } = require('node:child_process');",
  'const [parent, command, ...args] = process.argv.slice(1);',
  "const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });",
  'const end = () => { child.kill(); process.exit(0); };',
  'setInterval(() => { try { process.kill(Number(parent), 0); } catch { end(); } }, 2000);',
  "child.on('exit', (code) => process.exit(code ?? 1));",
  "process.on('SIGTERM', end);",
].join('\n');

/** Every preview server started by this process, stopped synchronously on exit (an exit handler cannot wait for taskkill). */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function track(child: ChildProcess): ChildProcess {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const running of live) killNow(running);
    });
  }
  live.add(child);
  child.once('exit', () => live.delete(child));
  return child;
}

interface Running {
  status: PreviewStatus;
  readonly processes: ChildProcess[];
  stopped: boolean;
}

export function createPreviewManager(options: PreviewOptions): PreviewManager {
  const previews = new Map<string, Running>();
  const run = options.run ?? runCommand;
  const readyTimeoutMs = options.readyTimeoutMs ?? 3 * 60_000;

  const stop = (runId: string): void => {
    const preview = previews.get(runId);
    if (preview === undefined) return;
    preview.stopped = true;
    for (const child of preview.processes) stopTree(child);
    preview.status = { runId, state: 'stopped' };
  };

  const stopAll = (): void => {
    for (const runId of previews.keys()) stop(runId);
  };

  return {
    start(runId, entries) {
      stopAll();
      const preview: Running = { status: { runId, state: 'starting', step: 'install' }, processes: [], stopped: false };
      previews.set(runId, preview);
      const update = (status: Omit<PreviewStatus, 'runId'>): void => {
        if (!preview.stopped) preview.status = { runId, ...status };
      };
      launch(join(options.previewRoot, runId), entries, preview, update, run, readyTimeoutMs).catch((cause: unknown) => {
        for (const child of preview.processes) stopTree(child);
        update({ state: 'failed', error: String(cause instanceof Error ? cause.message : cause).slice(-MAX_ERROR_CHARS) });
      });
      return preview.status;
    },
    status: (runId) => previews.get(runId)?.status ?? { runId, state: 'stopped' },
    stop,
    stopAll,
  };
}

async function launch(
  dir: string,
  entries: readonly ZipEntry[],
  preview: Running,
  update: (status: Omit<PreviewStatus, 'runId'>) => void,
  run: typeof runCommand,
  readyTimeoutMs: number,
): Promise<void> {
  const paths = new Set(entries.map((entry) => entry.path));
  const hasBackend = paths.has(BACKEND_ENTRY);
  const hasFrontend = paths.has(FRONTEND_ENTRY);
  const [apiPort, webPort] = [await freePort(), await freePort()];

  await writeEntries(dir, entries);
  if (hasFrontend) await writeFile(join(dir, PREVIEW_CONFIG), viteConfig(webPort, hasBackend ? apiPort : null), 'utf8');

  update({ state: 'starting', step: 'install' });
  const installed = await run('npm', ['install', '--no-audit', '--no-fund'], dir);
  if (!installed.ok) throw new Error(`npm install failed:\n${installed.output}`);
  if (hasBackend) {
    update({ state: 'starting', step: 'build' });
    const built = await run('npm', ['run', 'build'], dir);
    if (!built.ok) throw new Error(`npm run build failed:\n${built.output}`);
  }
  if (preview.stopped) return;

  update({ state: 'starting', step: 'start' });
  if (hasBackend) preview.processes.push(startWatched(dir, [BACKEND_START], { PORT: String(apiPort) }));
  if (hasFrontend) {
    await access(join(dir, VITE_BIN));
    preview.processes.push(startWatched(dir, [VITE_BIN, '--config', PREVIEW_CONFIG], {}));
  }
  const port = hasFrontend ? webPort : apiPort;
  await waitUntilListening(port, preview, readyTimeoutMs);
  update({ state: 'running', url: `http://127.0.0.1:${port}` });
}

/** Writes the entries into `dir`, first removing everything but node_modules (kept, so a restart installs in seconds). */
async function writeEntries(dir: string, entries: readonly ZipEntry[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (name !== 'node_modules') await rm(join(dir, name), { recursive: true, force: true, maxRetries: 3 });
  }
  for (const entry of entries) {
    const full = join(dir, ...entry.path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, entry.contents, 'utf8');
  }
}

function viteConfig(webPort: number, apiPort: number | null): string {
  const proxy = apiPort === null ? '' : `, proxy: { '/api': 'http://127.0.0.1:${apiPort}' }`;
  return [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    '',
    '// Written by VibeCoder for the in-app preview only; vite.config.mjs is the one in the zip.',
    'export default defineConfig({',
    "  root: 'frontend',",
    '  plugins: [react()],',
    '  clearScreen: false,',
    `  server: { host: '127.0.0.1', port: ${webPort}, strictPort: true${proxy} },`,
    '});',
    '',
  ].join('\n');
}

function startWatched(dir: string, args: readonly string[], env: Record<string, string>): ChildProcess {
  return track(spawn(process.execPath, ['-e', WATCHDOG, String(process.pid), process.execPath, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  }));
}

/** Waits until the app accepts connections on its loopback port - a local socket, never a network request. */
async function waitUntilListening(port: number, preview: Running, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (preview.stopped) return;
    const exited = preview.processes.find((child) => child.exitCode !== null);
    if (exited !== undefined) throw new Error(`the app stopped while starting (exit code ${exited.exitCode})`);
    if (await accepts(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`the app did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function killNow(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}
