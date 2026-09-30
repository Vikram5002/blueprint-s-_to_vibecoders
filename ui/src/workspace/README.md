# ui/src/workspace/

Component-level documentation for the workspace (`workspace.html`): what the
code in this directory does today.

## 1. Architecture overview

One shell, four tabs, one shared store (`store.ts`, zustand). Tab panels
unmount when another tab is shown, so anything that must survive a tab switch

- the opened session, the Page Builder canvas and its undo history - lives in
  the store, not in a panel's own state.

```
WorkspaceShell
├─ Sidebar                 sessions list, Import (ImportProjectDialog)
├─ ProviderPicker          plan model and code model
└─ tabs
   ├─ Conversation         ConversationPane - Agent mode (agent-runner.ts)
   ├─ Page builder         PageBuilderCanvas and friends (§3)
   ├─ Verification (mock)  VerificationDemo - the three-outcome display on mock data
   └─ Workflow graph       WorkflowDemo - plan generation, application runs, edits
```

## 2. Components

- **`WorkspaceShell.tsx`** - the tab strip and the active panel. `min-w-0` /
  `min-h-0` on the main column is load-bearing: without it a flex item will
  not shrink below its content, which breaks the layout at 768px.
- **`Sidebar.tsx`** - saved workflow sessions (fetched from
  `/api/workflow/sessions`), collapsible (240px / 56px), plus **Import** to
  continue a project built outside the tool (`ImportProjectDialog.tsx`).
- **`ConversationPane.tsx`** - Agent mode: one request runs plan → generate →
  build → fix → continue → pages, with a live timeline and Stop.
  `agent-runner.ts` holds the orchestration and is unit-tested on its own.
- **`WorkflowDemo.tsx` / `GenerateApplicationPanel.tsx`** - plan generation,
  Generate Application, Fix build errors, Continue generation, Add or remove
  components (`ComponentEditor.tsx`), and the run's pages.
- **`store.ts`** - active tab, opened session, Page Builder canvas (elements,
  theme, origin) and its undo/redo history.

## 3. Page Builder

- **`PageBuilderCanvas.tsx`** - palette, zoomable canvas, Inspector, Layers.
  All screen-to-canvas conversion is in `paletteLanding` / `moveLanding` and
  the resize handles; snapping, resizing and bounds are in
  `page-builder-geometry.ts`, which never sees the zoom.
- **`page-builder-catalogue.ts`** - every element type: palette name, default
  size and label, the hint for its label, and its category.
- **`page-builder-previews.tsx`** - how each element looks on the canvas
  (stand-ins for the generated markup; the real code comes from
  `src/generate/`).
- **`page-templates.ts`** - ready-made sections and pages ("+ Add section…"),
  including the Single column and Split panel page layouts that used to be the
  separate Page regions tab.
- **`ThemePanel.tsx` / `page-theme.ts`** - colours, fonts, light/dark,
  contrast grades, CSS/Tailwind export.
- **`svg-backgrounds.ts`**, **`motion-preview.ts`** - editor twins of the
  generator's backgrounds and motion CSS (kept identical; see their tests).
- **`PageSwitcher.tsx`**, **`PageSyncButton.tsx`**, **`EditorToolbar.tsx`** -
  switching a run's pages, syncing a page's form to the backend, and the
  undo/zoom/templates/preview toolbar.

## 4. Known limitations

- **Verification (mock)** still shows hard-coded scenarios; real verification
  results appear in each application run's report in the Workflow tab.
- The canvas is a fixed 1280x800 page; responsive breakpoints are not
  modelled.
- UI code never imports from `src/` (rule 4): shared shapes are mirrored in
  `*-types.ts` files here and kept in step by tests.

## 5. Running this part of the app standalone

From `ui/` (a separate package from the repo root - see the root `CLAUDE.md`
for why `npm install` has to be run in both places):

```bash
npm install       # only needed once, or after ui/package.json changes
npm run dev
```

Then open **`http://localhost:5173/workspace.html`** - not `/`, which serves
the separate architecture dashboard (`App.tsx`). Without the backend
(`node dist/cli.js .` from the repo root) the tabs and editor work, but
sessions, runs and generation do not.

Tests for this directory:

```bash
npm test          # vitest, src/**/*.test.ts
npm run test:e2e  # playwright, e2e/*.spec.ts - starts its own dev server
```
