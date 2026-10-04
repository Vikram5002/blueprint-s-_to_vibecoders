/**
 * One file, start to finish: which rules it breaks -> what the person wants
 * -> a proposal from the server -> a side-by-side diff -> Keep or Discard.
 * Nothing is written until Keep; a kept change can be undone from the panel
 * (or with Ctrl+Z in the editor, since it is applied as a normal edit).
 */
import * as vscode from 'vscode';
import { ApiClient } from './api';
import type { HistoryEntry, HistoryView } from './history';
import type { ServerManager } from './server-process';
import { checkDetails, relativeTo, summariseChecks } from './text';

export const PROPOSAL_SCHEME = 'vibecoder-proposal';

/** Read-only documents holding each proposal, shown on the right of the diff. */
export class ProposalDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();

  set(uri: vscode.Uri, text: string): void {
    this.texts.set(uri.toString(), text);
  }

  delete(uri: vscode.Uri): void {
    this.texts.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }
}

export interface FlowDeps {
  readonly servers: ServerManager;
  readonly history: HistoryView;
  readonly proposals: ProposalDocuments;
}

export async function reworkFiles(deps: FlowDeps, uris: readonly vscode.Uri[]): Promise<void> {
  for (const uri of uris) {
    // One at a time: each ends in a question the person has to answer.
    await reworkOne(deps, uri);
  }
}

async function reworkOne(deps: FlowDeps, uri: vscode.Uri): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const stat = await vscode.workspace.fs.stat(uri).then(undefined, () => null);
  if (folder === undefined || stat === null || stat.type !== vscode.FileType.File) {
    void vscode.window.showWarningMessage(`VibeCoder: ${uri.fsPath} is not a file in an open workspace folder.`);
    return;
  }
  const path = relativeTo(folder.uri.fsPath, uri.fsPath);
  if (path === null) return;

  const entry = deps.history.add(uri);
  try {
    const api = await client(deps, folder.uri.fsPath);
    const violations = await api.violations(path);

    const instruction = await askWhatToDo(path, violations.length);
    if (instruction === undefined) {
      deps.history.update(entry, 'discarded', 'cancelled');
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();
    const answer = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VibeCoder: reworking ${path}…`, cancellable: false },
      () => api.rework({ path, source: original, ...(instruction === '' ? {} : { instruction }) }),
    );

    if (answer.unchanged) {
      deps.history.update(entry, 'unchanged', 'the model kept the file as it was');
      void vscode.window.showInformationMessage(`VibeCoder: no change proposed for ${path}.`);
      return;
    }
    await review(deps, entry, document, original, answer.proposed, answer.checks);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    deps.history.update(entry, 'failed', message);
    void vscode.window.showErrorMessage(`VibeCoder: ${message}`);
  }
}

async function client(deps: FlowDeps, root: string): Promise<ApiClient> {
  const accessCode = vscode.workspace.getConfiguration('vibecoder').get<string>('accessCode', '');
  return new ApiClient({ baseUrl: await deps.servers.url(root), accessCode });
}

/** '' = just fix the violations; undefined = cancelled. */
async function askWhatToDo(path: string, violationCount: number): Promise<string | undefined> {
  if (violationCount === 0) {
    const asked = await vscode.window.showInputBox({
      title: `VibeCoder: ${path} breaks no stated rule`,
      prompt: 'What should change in this file?',
      placeHolder: 'e.g. move the database calls into a service',
      ignoreFocusOut: true,
    });
    return asked === undefined || asked.trim() === '' ? undefined : asked.trim();
  }
  const fix = `Fix the ${violationCount} rule violation(s)`;
  const more = 'Fix them, with an extra instruction…';
  const choice = await vscode.window.showQuickPick([fix, more], { title: `VibeCoder: ${path}`, ignoreFocusOut: true });
  if (choice === undefined) return undefined;
  if (choice === fix) return '';
  const extra = await vscode.window.showInputBox({ prompt: 'Anything else the rework should do?', ignoreFocusOut: true });
  return extra === undefined ? undefined : extra.trim();
}

async function review(
  deps: FlowDeps,
  entry: HistoryEntry,
  document: vscode.TextDocument,
  original: string,
  proposed: string,
  checks: Parameters<typeof summariseChecks>[0],
): Promise<void> {
  const proposalUri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: document.uri.path, query: String(entry.id) });
  deps.proposals.set(proposalUri, proposed);
  const name = vscode.workspace.asRelativePath(document.uri);
  await vscode.commands.executeCommand('vscode.diff', document.uri, proposalUri, `${name}: current ↔ proposed (VibeCoder)`);

  const summary = summariseChecks(checks);
  const choice = await vscode.window.showInformationMessage(
    `Keep VibeCoder's change to ${name}? ${summary}`,
    { modal: true, detail: checks.length > 0 ? checkDetails(checks) : undefined },
    'Keep',
    'Discard',
  );
  deps.proposals.delete(proposalUri);
  await closeDiff(proposalUri);

  if (choice !== 'Keep') {
    deps.history.update(entry, 'discarded', 'nothing was changed');
    return;
  }
  if (document.getText() !== original) {
    deps.history.update(entry, 'failed', 'the file changed while you were reviewing - nothing was applied');
    void vscode.window.showWarningMessage(`VibeCoder: ${name} changed during the review, so the proposal was not applied.`);
    return;
  }
  await replaceAll(document, proposed);
  deps.history.update(entry, 'kept', summary, original);
  const undo = await vscode.window.showInformationMessage(`VibeCoder: kept the change to ${name}.`, 'Undo');
  if (undo === 'Undo') await undoEntry(deps, entry);
}

export async function undoEntry(deps: Pick<FlowDeps, 'history'>, entry: HistoryEntry): Promise<void> {
  if (entry.original === undefined) return;
  const document = await vscode.workspace.openTextDocument(entry.uri);
  await replaceAll(document, entry.original);
  deps.history.update(entry, 'undone', 'original text restored');
}

async function replaceAll(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(document.uri, whole, text);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not edit ${document.uri.fsPath}`);
  await document.save();
}

async function closeDiff(proposalUri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === proposalUri.toString()) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}
