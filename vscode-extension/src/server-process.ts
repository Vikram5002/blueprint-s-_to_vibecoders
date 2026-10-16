/**
 * Finds the server to talk to: the configured address (a hosted server), or
 * a local one this extension starts for the workspace folder with the same
 * CLI a person would run (`vibe-blueprint <folder> --no-open`), stopped
 * again when VS Code closes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { parseServerUrl } from './text';

/** Analysing a large repository takes a while before the server is up. */
const START_TIMEOUT_MS = 3 * 60_000;

interface LocalServer {
  readonly child: ChildProcess;
  readonly ready: Promise<string>;
  stop(): void;
}

export class ServerManager implements vscode.Disposable {
  private readonly servers = new Map<string, LocalServer>();

  constructor(private readonly output: vscode.OutputChannel) {}

  /** The base URL to use, starting a local server first when none is configured. */
  async url(root: string): Promise<string> {
    const configured = vscode.workspace.getConfiguration('vibecoder').get<string>('serverUrl', '').trim();
    if (configured !== '') {
      this.stop();
      return configured;
    }
    const absoluteRoot = resolve(root);
    const key = process.platform === 'win32' ? absoluteRoot.toLowerCase() : absoluteRoot;
    let server = this.servers.get(key);
    if (server === undefined) {
      server = this.start(absoluteRoot, key);
      this.servers.set(key, server);
    }
    return server.ready;
  }

  restart(): void {
    this.stop();
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    for (const server of this.servers.values()) server.stop();
    this.servers.clear();
  }

  private start(root: string, key: string): LocalServer {
    const command = vscode.workspace.getConfiguration('vibecoder').get<string>('cliCommand', 'npx --yes vibe-blueprint');
    const full = `${command} "${root}" --no-open`;
    this.output.appendLine(`Starting the analysis server: ${full}`);
    const child = spawn(full, { cwd: root, shell: true, windowsHide: true });
    let stop = (): void => killServer(child);

    const ready = new Promise<string>((resolveReady, reject) => {
      let seen = '';
      let settled = false;
      const forget = (): void => {
        if (this.servers.get(key)?.child === child) this.servers.delete(key);
      };
      const failed = (error: Error): void => {
        clearTimeout(timer);
        forget();
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      stop = (): void => {
        failed(new Error('the analysis server was stopped - start the rework again to restart it'));
        killServer(child);
      };
      const timer = setTimeout(() => {
        failed(new Error('the analysis server did not start within 3 minutes - see Output > VibeCoder'));
        killServer(child);
      }, START_TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        this.output.append(text);
        if (settled) return;
        seen = `${seen}${text}`.slice(-65_536);
        const url = parseServerUrl(seen);
        if (url !== null) {
          settled = true;
          clearTimeout(timer);
          this.output.appendLine(`Analysis server ready at ${url}`);
          resolveReady(url);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
      child.on('error', failed);
      child.on('exit', (code) => {
        failed(new Error(`the analysis server stopped (exit code ${code ?? 'none'}) - see Output > VibeCoder`));
      });
    });
    return { child, ready, stop: () => stop() };
  }
}

/** The configured CLI runs through a shell, so stop its descendants on Windows too. */
function killServer(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => child.kill());
    killer.on('exit', (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }
  child.kill();
}
