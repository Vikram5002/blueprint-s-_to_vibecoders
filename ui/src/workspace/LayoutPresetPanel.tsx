import { LayoutWireframe } from './LayoutWireframe';
import { MOCK_PRESETS } from './layout-presets';
import type { LayoutSchema } from './layout-types';

interface LayoutPresetPanelProps {
  readonly onSelectPreset: (schema: LayoutSchema) => void;
  readonly onCustom: () => void;
}

/**
 * Shows exactly 3 options: the 2 mock "AI-generated" presets (hard-coded,
 * standing in for an orchestrator that doesn't exist yet) plus a Custom
 * entry point. Presets are real interactive wireframes, not screenshots.
 */
export function LayoutPresetPanel({ onSelectPreset, onCustom }: LayoutPresetPanelProps): JSX.Element {
  return (
    <div className="space-y-4">
      <p className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
        Mock data — these presets are hard-coded, not generated. The real orchestrator that
        would produce layout presets from a prompt does not exist yet.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {MOCK_PRESETS.map((preset) => (
          <div key={preset.id} className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">{preset.name}</h3>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                AI-generated (mock)
              </span>
            </div>
            <LayoutWireframe schema={preset} />
            <button
              type="button"
              onClick={() => onSelectPreset(preset)}
              className="mt-auto rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600"
            >
              Use this preset
            </button>
          </div>
        ))}

        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-900/50 p-4">
          <h3 className="text-sm font-semibold text-slate-100">Custom</h3>
          <p className="flex-1 text-xs text-slate-500">
            Build a layout from scratch: place regions on a 12-column grid and pick components
            from the palette.
          </p>
          <button
            type="button"
            onClick={onCustom}
            className="mt-auto rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
          >
            Start custom layout
          </button>
        </div>
      </div>
    </div>
  );
}
