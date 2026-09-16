import { useRef, useState } from 'react';
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { generatePageFile } from './page-builder-api-client';
import {
  ANIMATION_NAMES,
  ANIMATIONS,
  CANVAS_ELEMENT_TYPES,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DESIGN_TOKENS,
  DESIGN_TOKEN_NAMES,
  keyframesIdentifier,
  type AnimationName,
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

/** Every catalogue keyframe, injected once into the canvas so the editor preview animates exactly like the generated file does. Built once at module load - it never varies. */
const EDITOR_KEYFRAMES = ANIMATION_NAMES.map(
  (name) => `@keyframes ${keyframesIdentifier(name)} { ${ANIMATIONS[name].keyframes} }`,
).join('\n');

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
    // Suppressed mid-drag: several catalogue animations drive `transform`,
    // which is the same property dnd-kit uses to follow the pointer, so an
    // animating element would fight the drag and visibly jump.
    animation:
      element.animation !== undefined && !isDragging
        ? `${keyframesIdentifier(element.animation)} ${ANIMATIONS[element.animation].timing}`
        : undefined,
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
  /**
   * Bumped to re-run every entry animation. A CSS entry animation plays once
   * on mount and then never again, so without this you would see each
   * animation exactly once - when the element is first placed - and never
   * while actually choosing between them, which is the one moment you need
   * to see it. Bumping this remounts the placed elements (it is part of
   * their React key), which replays them.
   */
  const [replayTick, setReplayTick] = useState(0);
  /** The fixed 1280x800 element coordinate space. */
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** The flexible, scrollable window onto it - what is actually visible on screen. */
  const viewportRef = useRef<HTMLDivElement | null>(null);
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
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (canvasRect === undefined || viewportRect === undefined) return;

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
      // Asked against the VISIBLE viewport, not the canvas: the canvas is now
      // usually wider than what is on screen, and a drop onto scrolled-out
      // canvas area the user cannot even see is not a drop they meant.
      const droppedOnCanvas =
        centerX >= viewportRect.left &&
        centerX <= viewportRect.right &&
        centerY >= viewportRect.top &&
        centerY <= viewportRect.bottom;
      if (!droppedOnCanvas) return;

      // Canvas-space. No scroll adjustment needed: the canvas element scrolls
      // together with its own contents, so its rect's origin already IS the
      // element coordinate space's origin at any scroll offset.
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

  function deleteSelected(): void {
    if (selectedId === null) return;
    setElements((current) => current.filter((element) => element.id !== selectedId));
    setSelectedId(null);
  }

  /** Offset so the copy is visibly its own element rather than sitting exactly on top of the original, and clamped so duplicating something at the canvas edge cannot push it out of bounds (which `validatePageLayout` would reject at generate time). */
  function duplicateSelected(): void {
    if (selected === null) return;
    const copy: CanvasElement = {
      ...selected,
      id: nextElementId(),
      x: Math.round(clamp(selected.x + 16, 0, CANVAS_WIDTH - selected.width)),
      y: Math.round(clamp(selected.y + 16, 0, CANVAS_HEIGHT - selected.height)),
    };
    setElements((current) => [...current, copy]);
    setSelectedId(copy.id);
  }

  interface ElementPatch {
    readonly label?: string;
    readonly colorToken?: DesignToken;
    /** Explicit `undefined` means "clear it". `exactOptionalPropertyTypes` makes that a different thing from omitting the key, so it has to be spelled out. */
    readonly animation?: AnimationName | undefined;
  }

  function updateSelected(patch: ElementPatch): void {
    if (selectedId === null) return;
    setElements((current) =>
      current.map((element) => {
        if (element.id !== selectedId) return element;
        // Clearing drops the key entirely rather than setting it to
        // undefined: canvas-layout.ts's contract is "absent means no
        // animation", and JSON.stringify would drop an explicit undefined on
        // the way to the API anyway - so storing one would only create a
        // shape the rest of the pipeline never sees.
        const { animation, ...rest } = { ...element, ...patch };
        return animation === undefined ? rest : { ...rest, animation };
      }),
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
      <div className="mx-auto max-w-[1700px] space-y-4">
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

            {/*
              Two elements, not one, and that split is load-bearing.
              Previously the fixed 1280x800 canvas WAS the grid item, and a
              grid item with a definite width contributes that width as the
              track's minimum - so `1fr` resolved to a literal 1280px
              (measured: `grid-template-columns: 160px 1280px 260px`),
              overflowing the container and pushing the 260px Inspector
              column clean off the right edge of the viewport (x=1784 in a
              1536px window, with no page scrollbar to reach it). The Label
              and Color controls had been rendering the whole time; nobody
              could see them. `min-width: 0` does NOT fix that case - it
              overrides the content-based automatic minimum, not the
              minimum contribution of a specified size.

              So the flexible, scrollable viewport is the grid item, and the
              fixed-size canvas lives inside it. That also keeps the drop
              maths honest: the inner canvas scrolls WITH its contents, so
              its own rect stays the element coordinate space at any scroll
              offset, while the outer rect is what "was this dropped on the
              visible canvas?" has to be asked against.
            */}
            <div
              ref={viewportRef}
              data-testid="page-builder-viewport"
              className="min-w-0 overflow-auto border border-slate-700"
            >
              <div
                ref={canvasRef}
                data-testid="page-builder-canvas"
                // Only a click on the canvas BACKGROUND clears the selection.
                // Without the target check this fired for clicks on placed
                // elements too, since those bubble - so selecting an element
                // by clicking it set `selectedId` on pointerup and then
                // immediately cleared it on the click that followed, and the
                // Inspector snapped back to "select an element". An element
                // was therefore only ever editable in the instant after it
                // was dropped (which auto-selects); clicking it again to
                // rename or recolour it could never work. Checked here
                // rather than with stopPropagation() on the child, because
                // PlacedElement's own comment documents why interfering with
                // its pointer events breaks dnd-kit's drag cleanup.
                onClick={(event) => {
                  if (event.target === event.currentTarget) setSelectedId(null);
                }}
                style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, position: 'relative' }}
                className="bg-white"
              >
                {/*
                  The same keyframes the generated file carries, by the same
                  vb-* names - so what you preview here is what that file will
                  actually do, not an approximation of it.
                */}
                <style>{EDITOR_KEYFRAMES}</style>
                {elements.map((element) => (
                  <PlacedElement
                    key={`${element.id}:${replayTick}`}
                    element={element}
                    selected={element.id === selectedId}
                    onSelect={() => setSelectedId(element.id)}
                  />
                ))}
              </div>
            </div>

            <aside className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Inspector
              </h4>
              {selected === null ? (
                <p className="text-xs text-slate-500">
                  Select a placed element to edit its text, color, and animation.
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

                  <div>
                    <span className="mb-1 block text-xs text-slate-400">Animation</span>
                    <select
                      data-testid="animation-select"
                      value={selected.animation ?? 'none'}
                      onChange={(event) =>
                        updateSelected({
                          animation:
                            event.target.value === 'none'
                              ? undefined
                              : (event.target.value as AnimationName),
                        })
                      }
                      className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    >
                      <option value="none">None</option>
                      {ANIMATION_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {ANIMATIONS[name].label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      data-testid="replay-animations"
                      onClick={() => setReplayTick((tick) => tick + 1)}
                      className="mt-1.5 w-full rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                    >
                      Replay animations
                    </button>
                  </div>

                  <div className="flex gap-2 border-t border-slate-800 pt-3">
                    <button
                      type="button"
                      data-testid="duplicate-element"
                      onClick={duplicateSelected}
                      className="flex-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      data-testid="delete-element"
                      onClick={deleteSelected}
                      className="flex-1 rounded border border-red-800 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/40"
                    >
                      Delete
                    </button>
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
