/**
 * "VibeCoder: Open Workspace": the full VibeCoder workspace - plans, Workflow,
 * Page Builder, "Update backend & database", Run app - inside a VS Code
 * panel. It is the same UI the browser and the desktop app show, served by
 * the same local server the rework flow already starts for the folder, so
 * the extension adds no logic of its own: generated and edited files land in
 * the project folder, where VS Code's Explorer shows them.
 */
import * as vscode from 'vscode';
import type { ServerManager } from './server-process';
import { workspaceHtml } from './text';

export class WorkspacePanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly servers: ServerManager) {}

  /** Opens (or brings forward) the workspace for one folder; returns the address it shows. */
  async open(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const existing = this.panels.get(folder.uri.fsPath);
    if (existing !== undefined) {
      existing.reveal();
      return undefined;
    }
    const panel = vscode.window.createWebviewPanel('vibecoder.workspace', `VibeCoder - ${folder.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panels.set(folder.uri.fsPath, panel);
    panel.onDidDispose(() => this.panels.delete(folder.uri.fsPath));
    panel.webview.html = workspaceHtml({ loading: `Starting VibeCoder for ${folder.name}...` });

    try {
      const local = await this.servers.url(folder.uri.fsPath);
      const external = (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString().replace(/\/+$/, '');
      panel.webview.html = workspaceHtml({ origin: external, page: `${external}/workspace.html` });
      return external;
    } catch (error) {
      panel.webview.html = workspaceHtml({ error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
