import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from './store';
import type { CanvasElement } from './page-builder-types';

const el = (id: string, x = 0): CanvasElement => ({ id, type: 'text', x, y: 0, width: 10, height: 10, label: '', colorToken: 'primary' });
const ids = (): string[] => useWorkspaceStore.getState().pageBuilder.elements.map((e) => `${e.id}@${e.x}`);

describe('page builder undo/redo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().openPageInBuilder(
      { runId: 'r', sessionId: 's', sessionTitle: 't', path: 'frontend/src/pages/p.tsx', edited: false },
      { id: 'p', pageName: 'P', elements: [] },
    );
  });

  const step = (update: (c: readonly CanvasElement[]) => readonly CanvasElement[]): void => {
    vi.advanceTimersByTime(1000);
    useWorkspaceStore.getState().setElements(update);
  };

  it('undoes and redoes each change', () => {
    step((c) => [...c, el('a')]);
    step((c) => [...c, el('b')]);
    expect(ids()).toEqual(['a@0', 'b@0']);
    useWorkspaceStore.getState().undoPage();
    expect(ids()).toEqual(['a@0']);
    useWorkspaceStore.getState().undoPage();
    expect(ids()).toEqual([]);
    useWorkspaceStore.getState().redoPage();
    expect(ids()).toEqual(['a@0']);
  });

  it('treats rapid changes (typing, nudging) as one undo step', () => {
    step((c) => [...c, el('a')]);
    vi.advanceTimersByTime(1000);
    for (let x = 1; x <= 5; x += 1) {
      vi.advanceTimersByTime(100);
      useWorkspaceStore.getState().setElements((c) => c.map((e) => ({ ...e, x })), { coalesce: true });
    }
    expect(ids()).toEqual(['a@5']);
    useWorkspaceStore.getState().undoPage();
    expect(ids()).toEqual(['a@0']);
  });

  it('a new change clears the redo stack', () => {
    step((c) => [...c, el('a')]);
    useWorkspaceStore.getState().undoPage();
    step((c) => [...c, el('b')]);
    useWorkspaceStore.getState().redoPage();
    expect(ids()).toEqual(['b@0']);
  });
});

describe('page builder undo/redo - discrete steps stay separate', () => {
  it('a continuous edit right after a drop does not merge into the drop', () => {
    useWorkspaceStore.getState().openPageInBuilder(
      { runId: 'r', sessionId: 's', sessionTitle: 't', path: 'frontend/src/pages/p.tsx', edited: false },
      { id: 'p', pageName: 'P', elements: [] },
    );
    vi.advanceTimersByTime(1000);
    useWorkspaceStore.getState().setElements((c) => [...c, el('a')]);
    vi.advanceTimersByTime(100);
    useWorkspaceStore.getState().setElements((c) => c.map((e) => ({ ...e, x: 9 })), { coalesce: true });
    useWorkspaceStore.getState().undoPage();
    expect(ids()).toEqual(['a@0']);
  });
});
