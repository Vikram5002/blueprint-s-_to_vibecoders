import { useRef, useState } from 'react';
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { generatePageFile } from './page-builder-api-client';
import {
  CANVAS_ELEMENT_TYPES,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DESIGN_TOKENS,
  DESIGN_TOKEN_NAMES,
  type CanvasElement,
  type CanvasElementType,
  type DesignToken,
  type GeneratedPageFile,
} from './page-builder-types';

/** Default size for a freshly-placed element, per type - a button and a text label are not the same shape, and this is the one place that decides it, never a guess made per-drop. */
const DEFAULT_SIZE: Readonly<
  Record<CanvasElementType, { readonly width: number; readonly height: number }>
> = {
  heading: { width: 320, height: 40 },
  text: { width: 200, height: 24 },
  button: { width: 160, height: 40 },
  link: { width: 140, height: 24 },
  image: { width: 240, height: 160 },
  input: { width: 220, height: 36 },
  textarea: { width: 220, height: 96 },
  checkbox: { width: 160, height: 24 },
  radio: { width: 160, height: 24 },
  select: { width: 200, height: 36 },
  divider: { width: 400, height: 2 },
  container: { width: 320, height: 200 },
};

const DEFAULT_LABEL: Readonly<Record<CanvasElementType, string>> = {
  heading: 'Heading',
  text: 'Text label',
  button: 'Click me',
  link: 'Learn more',
  image: 'Image',
  input: 'Enter text...',
  textarea: 'Enter a longer message...',
  checkbox: 'Checkbox option',
  radio: 'Radio option',
  select: 'Option one',
  divider: '',
  container: '',
};

/** Palette entry labels — separate from DEFAULT_LABEL, which is what gets placed on the canvas, not what names the palette button itself. */
const PALETTE_LABEL: Readonly<Record<CanvasElementType, string>> = {
  heading: 'Heading',
  text: 'Text',
  button: 'Button',
  link: 'Link',
  image: 'Image',
  input: 'Input',
  textarea: 'Textarea',
  checkbox: 'Checkbox',
  radio: 'Radio',
  select: 'Dropdown',
  divider: 'Divider',
  container: 'Container',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

let idCounter = 0;
function nextElementId(): string {
  idCounter += 1;
  return `el-${idCounter}`;
}

interface PaletteItemProps {
  readonly type: CanvasElementType;
  readonly label: string;
}

function PaletteItem({ type, label }: PaletteItemProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: `palette:${type}` });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      type="button"
      data-testid={`palette-${type}`}
      style={{ transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined }}
      className="block w-full cursor-grab rounded border border-slate-700 bg-slate-800 px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-700 active:cursor-grabbing"
    >
      {label}
    </button>
  );
}

interface PlacedElementProps {
  readonly element: CanvasElement;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

/**
 * Editor-only approximation of what `layoutToComponentFile` will actually
 * generate for this element - a real `<input>`/`<select>` etc. isn't
 * rendered here on purpose: this whole node is also the dnd-kit draggable
 * surface, and a real form control's own native focus/text-selection/drag
 * behavior would fight the canvas drag gesture. A styled `<div>` that reads
 * as "this is an input" is the honest tradeoff, not a claim that this IS
 * the generated markup.
 */
function placedElementVisual(
  element: CanvasElement,
  color: string,
): { readonly style: React.CSSProperties; readonly content: React.ReactNode } {
  const base: React.CSSProperties = { fontSize: 13, boxSizing: 'border-box' };

  switch (element.type) {
    case 'heading':
      return { style: { ...base, color, fontSize: 22, fontWeight: 700 }, content: element.label };
    case 'text':
      return { style: { ...base, color }, content: element.label };
    case 'button':
      return {
        style: { ...base, backgroundColor: color, color: '#ffffff', border: 'none', borderRadius: 4 },
        content: element.label,
      };
    case 'link':
      return { style: { ...base, color, textDecoration: 'underline' }, content: element.label };
    case 'image':
      return {
        style: {
          ...base,
          color,
          border: `2px dashed ${color}`,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
        content: element.label,
      };
    case 'input':
      return {
        style: {
          ...base,
          color,
          border: `1px solid ${color}`,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 8,
          opacity: 0.85,
        },
        content: element.label,
      };
    case 'textarea':
      return {
        style: {
          ...base,
          color,
          border: `1px solid ${color}`,
          borderRadius: 4,
          padding: 8,
          opacity: 0.85,
        },
        content: element.label,
      };
    case 'checkbox':
    case 'radio':
      return {
        style: { ...base, color, display: 'flex', alignItems: 'center', gap: 8 },
        content: (
          <>
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 14,
                flexShrink: 0,
                border: `2px solid ${color}`,
                borderRadius: element.type === 'radio' ? '50%' : 3,
              }}
            />
            {element.label}
          </>
        ),
      };
    case 'select':
      return {
        style: {
          ...base,
          color,
          border: `1px solid ${color}`,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
        },
        content: (
          <>
            <span>{element.label}</span>
            <span aria-hidden>▾</span>
          </>
        ),
      };
    case 'divider':
      return { style: { ...base, backgroundColor: color }, content: null };
    case 'container':
      return {
        style: {
          ...base,
          border: `2px solid ${color}`,
          borderRadius: 8,
          color,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          padding: 4,
          opacity: 0.6,
        },
        // Editor-only affordance so an empty container is still selectable
        // and identifiable on the canvas - never part of the generated
        // output, which renders an empty div for this type.
        content: 'Container',
      };
  }
}

function PlacedElement({ element, selected, onSelect }: PlacedElementProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `element:${element.id}`,
  });
  const color = DESIGN_TOKENS[element.colorToken];
  const visual = placedElementVisual(element, color);
  const pointerDownPosition = useRef<{ x: number; y: number } | null>(null);

  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    outline: selected ? '2px solid #38bdf8' : 'none',
    outlineOffset: 2,
    opacity: isDragging ? 0.6 : 1,
    cursor: 'grab',
  };

  // Selection cannot be wired through onClick: a draggable node's own
  // pointerdown handling suppresses the browser's native "click" synthesis
  // even when no drag actually starts (confirmed live - a real down+up
  // with zero movement never produces a click event on this node).
  // Instead, treat a pointer-up as a selection if it didn't move far
  // enough to be a drag - the same disambiguation dnd-kit's own
  // activationConstraint uses. Do NOT call stopPropagation() here: dnd-kit
  // attaches its own pointerup listener directly to this same node to
  // clean up a pending (not-yet-activated) drag, and stopping propagation
  // on the React event was found, live, to prevent that cleanup - leaving
  // a stale pending drag that a later, unrelated mouse movement elsewhere
  // on the page would exceed the activation distance for, starting a real
  // "phantom" drag on this element and swallowing every click afterward
  // (dnd-kit installs a document-wide capture-phase click-canceller for
  // the duration of any activated drag).
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-testid={`placed-${element.id}`}
      onPointerDown={(event) => {
        pointerDownPosition.current = { x: event.clientX, y: event.clientY };
        listeners?.onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        const start = pointerDownPosition.current;
        pointerDownPosition.current = null;
        if (
          start !== null &&
          Math.abs(event.clientX - start.x) < 5 &&
          Math.abs(event.clientY - start.y) < 5
        ) {
          onSelect();
        }
      }}
      style={{ ...baseStyle, ...visual.style }}
    >
      {visual.content}
    </div>
  );
}

/**
 * Module: the real page builder (Milestone 1 of this feature). Real
 * drag-and-drop via @dnd-kit/core - dragging a palette item onto the
 * canvas places a real element at the drop position; dragging a placed
 * element repositions it. No LLM call anywhere in this component: "Generate"
 * calls the deterministic /api/page-builder/generate endpoint
 * (layoutToComponentFile, src/generate/canvas-layout.ts), which copies
 * exact position/size/color data into real JSX - never infers it.
 *
 * Fixed 1280x800 canvas, rendered at true 1:1 scale (no zoom/scale
 * transform) so a screen drop position maps directly onto the generated
 * file's own coordinate space with no scale-factor arithmetic to get
 * wrong. Twelve element types (CANVAS_ELEMENT_TYPES, page-builder-types.ts)
 * covering the common building blocks of a page - headings, text, links,
 * images, buttons, the standard form controls, a divider, and a grouping
 * container - and one color per element from the fixed DESIGN_TOKENS
 * palette.
 */
export function PageBuilderCanvas(): JSX.Element {
  const [pageName, setPageName] = useState('Landing Page');
  const [elements, setElements] = useState<readonly CanvasElement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedPageFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /**
   * A real, live bug: without an activation constraint, a zero-movement
   * pointerdown+pointerup (an ordinary click) is ambiguous with a drag
   * start - found live, where clicking a placed element to select it left
   * the PREVIOUSLY-selected element (auto-selected by its own drop)
   * selected instead. A drag only begins once the pointer moves past this
   * distance, so a genuine click passes through untouched; every real drag
   * in this feature moves the pointer far more than 8px.
   */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const selected = elements.find((element) => element.id === selectedId) ?? null;

  function handleDragEnd(event: DragEndEvent): void {
    const activeId = String(event.active.id);
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (canvasRect === undefined) return;

    if (activeId.startsWith('palette:')) {
      const type = activeId.slice('palette:'.length) as CanvasElementType;
      const size = DEFAULT_SIZE[type];

      // The dragged item's final on-screen rect, real and tracked by
      // dnd-kit's own drag state - not a guess. Whether this counts as "a
      // drop onto the canvas" is decided here by direct geometric
      // containment against the canvas's own real getBoundingClientRect,
      // rather than dnd-kit's useDroppable/collision-detection layer:
      // that layer exists to disambiguate BETWEEN several distinct drop
      // zones, which this feature does not have (there is exactly one
      // canvas) - a plain containment check against the one real rect we
      // already need for coordinate translation is simpler and answers
      // the only question that actually matters here.
      const finalRect = event.active.rect.current.translated;
      if (finalRect === null) return;
      const centerX = finalRect.left + finalRect.width / 2;
      const centerY = finalRect.top + finalRect.height / 2;
      const droppedOnCanvas =
        centerX >= canvasRect.left &&
        centerX <= canvasRect.right &&
        centerY >= canvasRect.top &&
        centerY <= canvasRect.bottom;
      if (!droppedOnCanvas) return;

      const dropX = finalRect.left - canvasRect.left;
      const dropY = finalRect.top - canvasRect.top;

      const newElement: CanvasElement = {
        id: nextElementId(),
        type,
        x: Math.round(clamp(dropX, 0, CANVAS_WIDTH - size.width)),
        y: Math.round(clamp(dropY, 0, CANVAS_HEIGHT - size.height)),
        width: size.width,
        height: size.height,
        label: DEFAULT_LABEL[type],
        colorToken: 'primary',
      };
      setElements((current) => [...current, newElement]);
      setSelectedId(newElement.id);
      return;
    }

    if (activeId.startsWith('element:')) {
      // An existing placed element, moved by the drag delta.
      const id = activeId.slice('element:'.length);
      setElements((current) =>
        current.map((element) =>
          element.id === id
            ? {
                ...element,
                x: Math.round(clamp(element.x + event.delta.x, 0, CANVAS_WIDTH - element.width)),
                y: Math.round(clamp(element.y + event.delta.y, 0, CANVAS_HEIGHT - element.height)),
              }
            : element,
        ),
      );
    }
  }

  function updateSelected(patch: Partial<Pick<CanvasElement, 'label' | 'colorToken'>>): void {
    if (selectedId === null) return;
    setElements((current) =>
      current.map((element) => (element.id === selectedId ? { ...element, ...patch } : element)),
    );
  }

  async function handleGenerate(): Promise<void> {
    setGenerating(true);
    setError(null);
    try {
      const file = await generatePageFile({ id: 'page-builder-v1', pageName, elements });
      setGenerated(file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setGenerated(null);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            Page name
            <input
              type="text"
              value={pageName}
              onChange={(event) => setPageName(event.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
            />
          </label>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={generating || elements.length === 0}
            className="ml-auto rounded-lg border border-emerald-700 bg-emerald-950/30 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-900/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>

        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[160px_1fr_260px]">
            <aside className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Elements
              </h4>
              {CANVAS_ELEMENT_TYPES.map((type) => (
                <PaletteItem key={type} type={type} label={PALETTE_LABEL[type]} />
              ))}
              <p className="pt-2 text-[10px] text-slate-500">Drag any element onto the canvas.</p>
            </aside>

            <div
              ref={canvasRef}
              data-testid="page-builder-canvas"
              onClick={() => setSelectedId(null)}
              style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, position: 'relative' }}
              className="max-w-full overflow-auto border border-slate-700 bg-white"
            >
              {elements.map((element) => (
                <PlacedElement
                  key={element.id}
                  element={element}
                  selected={element.id === selectedId}
                  onSelect={() => setSelectedId(element.id)}
                />
              ))}
            </div>

            <aside className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Inspector
              </h4>
              {selected === null ? (
                <p className="text-xs text-slate-500">
                  Select a placed element to edit its label and color.
                </p>
              ) : (
                <div className="space-y-3">
                  <label className="block text-xs text-slate-400">
                    Label
                    <input
                      type="text"
                      value={selected.label}
                      onChange={(event) => updateSelected({ label: event.target.value })}
                      className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    />
                  </label>
                  <div>
                    <span className="mb-1 block text-xs text-slate-400">Color</span>
                    <div className="flex flex-wrap gap-1.5">
                      {DESIGN_TOKEN_NAMES.map((token) => (
                        <button
                          key={token}
                          type="button"
                          data-testid={`color-${token}`}
                          aria-label={token}
                          onClick={() => updateSelected({ colorToken: token as DesignToken })}
                          style={{ backgroundColor: DESIGN_TOKENS[token] }}
                          className={`h-6 w-6 rounded-full border-2 ${
                            selected.colorToken === token ? 'border-white' : 'border-transparent'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </aside>
          </div>
        </DndContext>

        {error !== null && (
          <div className="rounded-lg border border-red-700/50 bg-red-950/20 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {generated !== null && (
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Generated: {generated.path}
            </h4>
            <pre
              data-testid="generated-code"
              className="max-h-96 overflow-auto text-[11px] leading-snug text-emerald-300"
            >
              {generated.contents}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
