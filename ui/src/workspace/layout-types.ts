/**
 * Minimal LayoutSchema for Module C (layout selection UI). No LayoutSchema
 * or "Module C" definition exists anywhere in this repo or in
 * pdsf/vibe_code_blueprint_proposal--.pdf — that document covers the
 * reverse-blueprint conformance tool only, not an app-builder layout layer.
 * This is a fresh minimal type matching the shape requested: 12-column
 * responsive grid, five optional regions, a fixed component palette.
 *
 * Both LayoutPresetPanel's mock presets and CustomLayoutBuilder's output
 * are typed as LayoutSchema — same shape, deliberately, per this project's
 * rule against parallel types for the same concept (see ProjectSchema's
 * reuse of Constraint for the same reason).
 */

export const GRID_COLUMNS = 12;

export type Breakpoint = 'sm' | 'md' | 'lg' | 'xl';

/** Pixel widths this project's breakpoints resolve to, matching the ones
 *  already used for viewport verification elsewhere in this workspace. */
export const BREAKPOINTS: Readonly<Record<Breakpoint, number>> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
};

export type RegionType = 'header' | 'navigation' | 'content' | 'sidebar' | 'footer';

export const REGION_TYPES: readonly RegionType[] = [
  'header',
  'navigation',
  'content',
  'sidebar',
  'footer',
];

export type ComponentCategory =
  | 'form-inputs'
  | 'buttons'
  | 'tables'
  | 'cards'
  | 'charts'
  | 'media'
  | 'containers';

export const COMPONENT_PALETTE: readonly ComponentCategory[] = [
  'form-inputs',
  'buttons',
  'tables',
  'cards',
  'charts',
  'media',
  'containers',
];

/** Placement on the 12-column grid. `colStart` and `colSpan` are 1-indexed;
 *  `colStart + colSpan - 1` must not exceed GRID_COLUMNS, but that's a
 *  builder-time constraint, not something this type enforces structurally. */
export interface GridPlacement {
  readonly colStart: number;
  readonly colSpan: number;
  readonly row: number;
}

export interface LayoutRegion {
  readonly type: RegionType;
  readonly placement: GridPlacement;
}

export type LayoutSource = 'ai-generated' | 'custom';

export interface LayoutSchema {
  readonly id: string;
  readonly name: string;
  readonly columns: typeof GRID_COLUMNS;
  readonly breakpoints: Readonly<Record<Breakpoint, number>>;
  readonly regions: readonly LayoutRegion[];
  readonly source: LayoutSource;
}
