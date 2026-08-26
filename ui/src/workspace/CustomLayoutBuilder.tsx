import { useMemo, useState } from 'react';
import { LayoutWireframe } from './LayoutWireframe';
import {
  BREAKPOINTS,
  COMPONENT_PALETTE,
  GRID_COLUMNS,
  REGION_TYPES,
  type LayoutRegion,
  type LayoutSchema,
  type RegionType,
} from './layout-types';

const DEFAULT_PLACEMENT_BY_TYPE: Readonly<Record<RegionType, LayoutRegion['placement']>> = {
  header: { colStart: 1, colSpan: 12, row: 1 },
  navigation: { colStart: 1, colSpan: 3, row: 2 },
  content: { colStart: 4, colSpan: 9, row: 2 },
  sidebar: { colStart: 10, colSpan: 3, row: 2 },
  footer: { colStart: 1, colSpan: 12, row: 3 },
};

interface CustomLayoutBuilderProps {
  readonly onBack: () => void;
}

/**
 * A basic working custom builder: add/remove/resize the 5 region types on
 * a 12-column grid, a static component palette, and a live JSON view of
 * the resulting LayoutSchema — the same shape the presets use, not a
 * parallel one. Drag-and-drop is explicitly out of scope for this pass.
 */
export function CustomLayoutBuilder({ onBack }: CustomLayoutBuilderProps): JSX.Element {
  const [regions, setRegions] = useState<readonly LayoutRegion[]>([
    { type: 'header', placement: DEFAULT_PLACEMENT_BY_TYPE.header },
    { type: 'content', placement: DEFAULT_PLACEMENT_BY_TYPE.content },
  ]);

  const schema: LayoutSchema = useMemo(
    () => ({
      id: 'custom-layout',
      name: 'Custom layout',
      columns: GRID_COLUMNS,
      breakpoints: BREAKPOINTS,
      source: 'custom',
      regions,
    }),
    [regions],
  );

  const usedTypes = new Set(regions.map((region) => region.type));
  const availableTypes = REGION_TYPES.filter((type) => !usedTypes.has(type));

  function addRegion(type: RegionType): void {
    setRegions((current) => [...current, { type, placement: DEFAULT_PLACEMENT_BY_TYPE[type] }]);
  }

  function removeRegion(type: RegionType): void {
    setRegions((current) => current.filter((region) => region.type !== type));
  }

  function updatePlacement(type: RegionType, field: keyof LayoutRegion['placement'], value: number): void {
    setRegions((current) =>
      current.map((region) =>
        region.type === type ? { ...region, placement: { ...region.placement, [field]: value } } : region,
      ),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-xs text-slate-400 hover:text-slate-200">
          &larr; Back to presets
        </button>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
          Mock — not wired to a backend
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[160px_1fr_minmax(0,320px)]">
        <aside className="rounded-lg border border-slate-800 bg-slate-900 p-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Component palette
          </h4>
          <ul className="space-y-1 text-xs text-slate-300">
            {COMPONENT_PALETTE.map((category) => (
              <li key={category} className="rounded px-2 py-1 hover:bg-slate-800">
                {category}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[10px] text-slate-500">
            Static list for now — drag-and-drop is a stretch goal, not required for this pass.
          </p>
        </aside>

        <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
          <LayoutWireframe schema={schema} />

          <div className="space-y-3">
            {regions.map((region) => (
              <div
                key={region.type}
                className="flex flex-wrap items-center gap-3 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-xs"
              >
                <span className="w-20 font-semibold uppercase tracking-wide text-slate-300">
                  {region.type}
                </span>
                <label className="flex items-center gap-1 text-slate-400">
                  col start
                  <input
                    type="number"
                    min={1}
                    max={GRID_COLUMNS}
                    value={region.placement.colStart}
                    onChange={(event) =>
                      updatePlacement(region.type, 'colStart', Number(event.target.value))
                    }
                    className="w-14 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-100"
                  />
                </label>
                <label className="flex items-center gap-1 text-slate-400">
                  span
                  <input
                    type="number"
                    min={1}
                    max={GRID_COLUMNS}
                    value={region.placement.colSpan}
                    onChange={(event) =>
                      updatePlacement(region.type, 'colSpan', Number(event.target.value))
                    }
                    className="w-14 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-100"
                  />
                </label>
                <label className="flex items-center gap-1 text-slate-400">
                  row
                  <input
                    type="number"
                    min={1}
                    value={region.placement.row}
                    onChange={(event) => updatePlacement(region.type, 'row', Number(event.target.value))}
                    className="w-14 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-100"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeRegion(region.type)}
                  className="ml-auto rounded px-2 py-1 text-rose-400 hover:bg-rose-950"
                >
                  Remove
                </button>
              </div>
            ))}

            {availableTypes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {availableTypes.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => addRegion(type)}
                    className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                  >
                    + {type}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            LayoutSchema (live)
          </h4>
          <pre className="max-h-96 overflow-auto text-[11px] leading-snug text-emerald-300">
            {JSON.stringify(schema, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
