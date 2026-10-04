import * as vscode from 'vscode';
import { HistoryView, type HistoryEntry } from './history';
import { PROPOSAL_SCHEME, ProposalDocuments, reworkFiles, undoEntry, type FlowDeps } from './rework-flow';
import { ServerManager } from './server-process';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('VibeCoder');
  const servers = new ServerManager(output);
  const proposals = new ProposalDocuments();
  // A drop only happens after activation returns, so `deps` exists by then.
  const history = new HistoryView((uris) => void reworkFiles(deps, uris));
  const deps: FlowDeps = { servers, history, proposals };

  context.subscriptions.push(
    output,
    servers,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposals),
    vscode.window.createTreeView('vibecoder.files', {
      treeDataProvider: history,
      dragAndDropController: history,
      canSelectMany: false,
    }),
    vscode.commands.registerCommand('vibecoder.reworkFile', (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected !== undefined && selected.length > 0 ? selected : uri !== undefined ? [uri] : [];
      return reworkFiles(deps, targets);
    }),
    vscode.commands.registerCommand('vibecoder.reworkActiveFile', () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri === undefined || uri.scheme !== 'file') {
        void vscode.window.showInformationMessage('VibeCoder: open a file first, or drop one on the Rework panel.');
        return undefined;
      }
      return reworkFiles(deps, [uri]);
    }),
    vscode.commands.registerCommand('vibecoder.undo', (entry: HistoryEntry) => undoEntry(deps, entry)),
    vscode.commands.registerCommand('vibecoder.undoLast', async () => {
      const entry = history.lastKept();
      if (entry === undefined) {
        void vscode.window.showInformationMessage('VibeCoder: there is no kept change to undo.');
        return false;
      }
      await undoEntry(deps, entry);
      return true;
    }),
    vscode.commands.registerCommand('vibecoder.clearHistory', () => history.clear()),
    vscode.commands.registerCommand('vibecoder.restartServer', () => {
      servers.restart();
      void vscode.window.showInformationMessage('VibeCoder: the analysis server will start again on the next rework.');
    }),
  );
}

export function deactivate(): void {
  // ServerManager is disposed through context.subscriptions.
}
