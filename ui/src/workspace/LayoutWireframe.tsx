import { useState } from 'react';
import { GRID_COLUMNS, type LayoutRegion, type LayoutSchema, type RegionType } from './layout-types';

/** One-line description shown when a region is clicked — the region's role. */
const REGION_ROLES: Readonly<Record<RegionType, string>> = {
  header: 'Top banner: branding, primary nav entry points, page title.',
  navigation: 'Wayfinding: links between the sections of the app.',
  content: 'The primary content area — what the page is actually for.',
  sidebar: 'Secondary content: filters, metadata, related actions.',
  footer: 'Bottom bar: legal links, secondary navigation, status info.',
};

const REGION_COLORS: Readonly<Record<RegionType, string>> = {
  header: 'bg-sky-900/60 border-sky-700 text-sky-200',
  navigation: 'bg-violet-900/60 border-violet-700 text-violet-200',
  content: 'bg-emerald-900/60 border-emerald-700 text-emerald-200',
  sidebar: 'bg-amber-900/60 border-amber-700 text-amber-200',
  footer: 'bg-rose-900/60 border-rose-700 text-rose-200',
};

interface LayoutWireframeProps {
  readonly schema: LayoutSchema;
  readonly onRegionClick?: (region: LayoutRegion) => void;
}

/**
 * Renders a LayoutSchema's regions on a real CSS grid, sized by each
 * region's placement — an interactive wireframe, not a static image.
 * Clicking a region highlights it and shows its role.
 */
export function LayoutWireframe({ schema, onRegionClick }: LayoutWireframeProps): JSX.Element {
  const [selected, setSelected] = useState<RegionType | null>(null);

  const maxRow = Math.max(1, ...schema.regions.map((region) => region.placement.row));

  return (
    <div className="space-y-2">
      <div
        className="grid gap-1 rounded border border-slate-800 bg-slate-950 p-2"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${maxRow}, 2.5rem)`,
        }}
      >
        {schema.regions.map((region) => {
          const isSelected = selected === region.type;
          return (
            <button
              key={`${region.type}-${region.placement.row}`}
              type="button"
              onClick={() => {
                setSelected(region.type);
                onRegionClick?.(region);
              }}
              className={`flex items-center justify-center rounded border text-[11px] font-medium uppercase tracking-wide transition-colors ${REGION_COLORS[region.type]} ${
                isSelected ? 'ring-2 ring-slate-100' : ''
              }`}
              style={{
                gridColumn: `${region.placement.colStart} / span ${region.placement.colSpan}`,
                gridRow: `${region.placement.row}`,
              }}
            >
              {region.type}
            </button>
          );
        })}
      </div>
      {selected && (
        <p className="text-xs text-slate-400">
          <span className="font-semibold text-slate-200">{selected}:</span> {REGION_ROLES[selected]}
        </p>
      )}
    </div>
  );
}
