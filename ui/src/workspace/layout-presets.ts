import { BREAKPOINTS, GRID_COLUMNS, type LayoutSchema } from './layout-types';

/**
 * Hard-coded mock data standing in for the orchestrator's real preset
 * generation, which does not exist yet. Structurally different from each
 * other on purpose: one single-column stack, one split-panel with a
 * sidebar — so the panel demonstrates real variety, not two copies of the
 * same idea with different labels.
 */

export const SINGLE_COLUMN_PRESET: LayoutSchema = {
  id: 'preset-single-column',
  name: 'Single column',
  columns: GRID_COLUMNS,
  breakpoints: BREAKPOINTS,
  source: 'ai-generated',
  regions: [
    { type: 'header', placement: { colStart: 1, colSpan: 12, row: 1 } },
    { type: 'content', placement: { colStart: 1, colSpan: 12, row: 2 } },
    { type: 'footer', placement: { colStart: 1, colSpan: 12, row: 3 } },
  ],
};

export const SPLIT_PANEL_PRESET: LayoutSchema = {
  id: 'preset-split-panel',
  name: 'Split panel',
  columns: GRID_COLUMNS,
  breakpoints: BREAKPOINTS,
  source: 'ai-generated',
  regions: [
    { type: 'header', placement: { colStart: 1, colSpan: 12, row: 1 } },
    { type: 'navigation', placement: { colStart: 1, colSpan: 3, row: 2 } },
    { type: 'content', placement: { colStart: 4, colSpan: 6, row: 2 } },
    { type: 'sidebar', placement: { colStart: 10, colSpan: 3, row: 2 } },
    { type: 'footer', placement: { colStart: 1, colSpan: 12, row: 3 } },
  ],
};

export const MOCK_PRESETS: readonly LayoutSchema[] = [SINGLE_COLUMN_PRESET, SPLIT_PANEL_PRESET];
