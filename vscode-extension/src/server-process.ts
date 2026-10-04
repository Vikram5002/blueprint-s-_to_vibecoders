/**
 * Finds the server to talk to: the configured address (a hosted server), or
 * a local one this extension starts for the workspace folder with the same
 * CLI a person would run (`vibe-blueprint <folder> --no-open`), stopped
 * again when VS Code closes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { parseServerUrl } from './text';

/** Analysing a large repository takes a while before the server is up. */
const START_TIMEOUT_MS = 3 * 60_000;

export class ServerManager implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;

  constructor(private readonly output: vscode.OutputChannel) {}

  /** The base URL to use, starting a local server first when none is configured. */
  async url(root: string): Promise<string> {
    const configured = vscode.workspace.getConfiguration('vibecoder').get<string>('serverUrl', '').trim();
    if (configured !== '') return configured;
    this.starting ??= this.start(root).catch((cause: unknown) => {
      this.starting = null;
      throw cause;
    });
    return this.starting;
  }

  restart(): void {
    this.stop();
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    this.child?.kill();
    this.child = null;
    this.starting = null;
  }

  private start(root: string): Promise<string> {
    const command = vscode.workspace.getConfiguration('vibecoder').get<string>('cliCommand', 'npx --yes vibe-blueprint');
    const full = `${command} "${root}" --no-open`;
    this.output.appendLine(`Starting the analysis server: ${full}`);
    const child = spawn(full, { cwd: root, shell: true, windowsHide: true });
    this.child = child;

    return new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(() => {
        reject(new Error('the analysis server did not start within 3 minutes - see Output > VibeCoder'));
      }, START_TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        this.output.append(text);
        seen += text;
        const url = parseServerUrl(seen);
        if (url !== null) {
          clearTimeout(timer);
          this.output.appendLine(`Analysis server ready at ${url}`);
          resolve(url);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.starting = null;
        }
        reject(new Error(`the analysis server stopped (exit code ${code ?? 'none'}) - see Output > VibeCoder`));
      });
    });
  }
}
