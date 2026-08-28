import { useState } from 'react';
import { CustomLayoutBuilder } from './CustomLayoutBuilder';
import { LayoutPresetPanel } from './LayoutPresetPanel';
import type { LayoutSchema } from './layout-types';

type View = { readonly mode: 'presets' } | { readonly mode: 'custom' } | { readonly mode: 'selected'; readonly schema: LayoutSchema };

/**
 * Module C — layout selection, reached via the "Layout" tab in
 * WorkspaceShell. Everything here is mock data pending the real
 * orchestrator (see LayoutPresetPanel's own banner).
 */
export function LayoutDemo(): JSX.Element {
  const [view, setView] = useState<View>({ mode: 'presets' });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl">
        {view.mode === 'presets' && (
          <LayoutPresetPanel
            onSelectPreset={(schema) => setView({ mode: 'selected', schema })}
            onCustom={() => setView({ mode: 'custom' })}
          />
        )}

        {view.mode === 'custom' && <CustomLayoutBuilder onBack={() => setView({ mode: 'presets' })} />}

        {view.mode === 'selected' && (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              Selected preset: <span className="font-semibold">{view.schema.name}</span>
            </p>
            <pre className="max-h-96 overflow-auto rounded border border-slate-800 bg-slate-950 p-3 text-[11px] leading-snug text-emerald-300">
              {JSON.stringify(view.schema, null, 2)}
            </pre>
            <button
              type="button"
              onClick={() => setView({ mode: 'presets' })}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              &larr; Back to presets
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
