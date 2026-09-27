import { SECTION_TEMPLATES } from './page-templates';
import { ELEMENT_SPECS } from './page-builder-catalogue';
import type { CanvasElement } from './page-builder-types';

const ZOOM_STEPS = [0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5];

interface EditorToolbarProps {
  readonly zoom: number;
  readonly fitting: boolean;
  readonly onZoom: (zoom: 'fit' | number) => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly preview: boolean;
  readonly onPreview: (preview: boolean) => void;
  readonly onTemplate: (templateId: string) => void;
}

const button =
  'rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40';

/** The Page Builder's top bar: undo/redo, section templates, zoom, and preview. */
export function EditorToolbar(props: EditorToolbarProps): JSX.Element {
  const { zoom, fitting, onZoom } = props;
  const stepZoom = (direction: 1 | -1): void => {
    const next = direction === 1 ? ZOOM_STEPS.find((step) => step > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);
    if (next !== undefined) onZoom(next);
  };
  return (
    <div data-testid="editor-toolbar" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5">
      <button type="button" data-testid="undo" onClick={props.onUndo} disabled={!props.canUndo} title="Undo (Ctrl+Z)" className={button}>
        ↶ Undo
      </button>
      <button type="button" data-testid="redo" onClick={props.onRedo} disabled={!props.canRedo} title="Redo (Ctrl+Y)" className={button}>
        ↷ Redo
      </button>
      <span className="mx-1 h-4 w-px bg-slate-700" />
      <select
        data-testid="add-template"
        value=""
        onChange={(event) => {
          if (event.target.value !== '') props.onTemplate(event.target.value);
        }}
        disabled={props.preview}
        className={`${button} pr-6`}
      >
        <option value="">＋ Add section…</option>
        {SECTION_TEMPLATES.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name} — {template.description}
          </option>
        ))}
      </select>
      <span className="ml-auto flex items-center gap-1">
        <button type="button" data-testid="zoom-out" onClick={() => stepZoom(-1)} title="Zoom out" className={button}>
          −
        </button>
        <span data-testid="zoom-level" className="w-12 text-center font-mono text-[11px] text-slate-300">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" data-testid="zoom-in" onClick={() => stepZoom(1)} title="Zoom in" className={button}>
          +
        </button>
        <button type="button" data-testid="zoom-fit" onClick={() => onZoom('fit')} className={`${button} ${fitting ? 'border-sky-600 text-sky-300' : ''}`}>
          Fit
        </button>
        <button type="button" onClick={() => onZoom(1)} className={button}>
          100%
        </button>
        <span className="mx-1 h-4 w-px bg-slate-700" />
        <button
          type="button"
          data-testid="toggle-preview"
          onClick={() => props.onPreview(!props.preview)}
          className={`${button} ${props.preview ? 'border-emerald-600 bg-emerald-950/40 text-emerald-300' : ''}`}
        >
          {props.preview ? '✎ Edit' : '▶ Preview'}
        </button>
      </span>
    </div>
  );
}

/** Every element, top-most first, like a design tool's layers panel. Click to select. */
export function LayersList({
  elements,
  selectedId,
  onSelect,
}: {
  readonly elements: readonly CanvasElement[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}): JSX.Element | null {
  if (elements.length === 0) return null;
  return (
    <div className="border-t border-slate-800 pt-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Layers ({elements.length})</h4>
      <ul data-testid="layers" className="max-h-56 space-y-0.5 overflow-y-auto">
        {[...elements].reverse().map((element) => (
          <li key={element.id}>
            <button
              type="button"
              onClick={() => onSelect(element.id)}
              className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] ${
                element.id === selectedId ? 'bg-sky-950/60 text-sky-200' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <span className="w-20 shrink-0 text-slate-500">{ELEMENT_SPECS[element.type].palette}</span>
              <span className="truncate">{element.label.split('|')[0] || '—'}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
