/**
 * The "Rework" panel: a drop target for files from the Explorer, and the list
 * of files reworked this session with what happened to each. A kept change
 * carries the original text, so Undo can put it back exactly.
 */
import * as vscode from 'vscode';
import { parseUriList } from './text';

export type Outcome = 'working' | 'kept' | 'discarded' | 'unchanged' | 'failed' | 'undone';

export interface HistoryEntry {
  readonly id: number;
  readonly uri: vscode.Uri;
  outcome: Outcome;
  detail: string;
  /** Present once a change was kept - what Undo restores. */
  original?: string;
}

const ICONS: Readonly<Record<Outcome, string>> = {
  working: 'loading~spin',
  kept: 'check',
  discarded: 'close',
  unchanged: 'circle-slash',
  failed: 'error',
  undone: 'discard',
};

export class HistoryView implements vscode.TreeDataProvider<HistoryEntry>, vscode.TreeDragAndDropController<HistoryEntry> {
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: readonly string[] = [];

  private readonly entries: HistoryEntry[] = [];
  private nextId = 1;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly onDrop: (uris: readonly vscode.Uri[]) => void) {}

  add(uri: vscode.Uri): HistoryEntry {
    const entry: HistoryEntry = { id: this.nextId++, uri, outcome: 'working', detail: 'asking the model…' };
    this.entries.unshift(entry);
    this.changed.fire();
    return entry;
  }

  update(entry: HistoryEntry, outcome: Outcome, detail: string, original?: string): void {
    entry.outcome = outcome;
    entry.detail = detail;
    if (original !== undefined) entry.original = original;
    this.changed.fire();
  }

  /** The newest change that was kept and not yet undone. */
  lastKept(): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.outcome === 'kept');
  }

  clear(): void {
    this.entries.splice(0, this.entries.length, ...this.entries.filter((e) => e.outcome === 'working'));
    this.changed.fire();
  }

  getTreeItem(entry: HistoryEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(vscode.workspace.asRelativePath(entry.uri));
    item.description = `${entry.outcome} - ${entry.detail}`;
    item.tooltip = `${entry.uri.fsPath}\n${entry.outcome}: ${entry.detail}`;
    item.iconPath = new vscode.ThemeIcon(ICONS[entry.outcome]);
    item.contextValue = entry.outcome;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [entry.uri] };
    return item;
  }

  getChildren(entry?: HistoryEntry): HistoryEntry[] {
    return entry === undefined ? [...this.entries] : [];
  }

  handleDrop(_target: HistoryEntry | undefined, data: vscode.DataTransfer): void | Thenable<void> {
    const item = data.get('text/uri-list');
    if (item === undefined) return;
    return item.asString().then((text) => {
      const uris = parseUriList(text).map((value) => vscode.Uri.parse(value));
      if (uris.length > 0) this.onDrop(uris);
    });
  }
}
