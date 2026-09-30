/**
 * The designer agent, on the builder's side: the operation shapes the server
 * returns (mirroring src/generate/page-designer.ts - rule 4, ui/ never imports
 * src/), and applying them to the canvas.
 *
 * Applied to the canvas as it is when the reply arrives, not as it was when
 * the request was sent: an element the person deleted in the meantime is
 * simply skipped, and everything they added or moved is kept. That is what
 * lets a person and the agent work on one page at the same time.
 */
import type { AnimationName, CanvasElement, CanvasElementType, DesignToken, PageLayout } from './page-builder-types';

export type DesignOperation =
  | {
      readonly op: 'add';
      readonly type: CanvasElementType;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly label: string;
      readonly colorToken: DesignToken;
      readonly animation?: AnimationName;
    }
  | {
      readonly op: 'update';
      readonly id: string;
      readonly x?: number;
      readonly y?: number;
      readonly width?: number;
      readonly height?: number;
      readonly label?: string;
      readonly colorToken?: DesignToken;
      readonly animation?: AnimationName | null;
    }
  | { readonly op: 'remove'; readonly id: string };

export interface DesignReply {
  readonly reply: string;
  readonly operations: readonly DesignOperation[];
  readonly refused: number;
}

export interface ChatTurn {
  readonly role: 'user' | 'designer';
  readonly text: string;
}

/** The next free `el-N` id, the same scheme the builder uses for dropped elements. */
function idAllocator(elements: readonly CanvasElement[]): () => string {
  let highest = 0;
  for (const element of elements) {
    const match = /^el-(\d+)$/.exec(element.id);
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
  }
  return () => `el-${(highest += 1)}`;
}

export interface Applied {
  readonly elements: readonly CanvasElement[];
  /** How many operations changed something; the rest named elements that no longer exist. */
  readonly changed: number;
}

export function applyDesignOperations(elements: readonly CanvasElement[], operations: readonly DesignOperation[]): Applied {
  const nextId = idAllocator(elements);
  let current = [...elements];
  let changed = 0;
  for (const operation of operations) {
    if (operation.op === 'add') {
      const { op: _op, animation, ...rest } = operation;
      current.push({ id: nextId(), ...rest, ...(animation === undefined ? {} : { animation }) });
      changed += 1;
    } else if (operation.op === 'remove') {
      const before = current.length;
      current = current.filter((element) => element.id !== operation.id);
      if (current.length < before) changed += 1;
    } else {
      const index = current.findIndex((element) => element.id === operation.id);
      const target = current[index];
      if (target === undefined) continue;
      const { op: _op, id: _id, animation, ...fields } = operation;
      const withAnimation =
        animation === undefined ? { ...target, ...fields } : animation === null ? withoutAnimation({ ...target, ...fields }) : { ...target, ...fields, animation };
      current[index] = withAnimation;
      changed += 1;
    }
  }
  return { elements: current, changed };
}

function withoutAnimation(element: CanvasElement): CanvasElement {
  const { animation: _animation, ...rest } = element;
  return rest;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return detail?.error ?? fallback;
}

export async function designViaApi(instruction: string, layout: PageLayout, history: readonly ChatTurn[], signal?: AbortSignal): Promise<DesignReply> {
  const response = await fetch('/api/page-builder/design', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction, layout, history }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, `designer failed: ${response.status}`));
  return (await response.json()) as DesignReply;
}
