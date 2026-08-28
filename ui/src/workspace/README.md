# ui/src/workspace/

Component-level documentation for the chat workspace shell and the layout
selection demo. Describes what the code in this directory actually does
today — not what either piece is eventually meant to become.

## 1. Architecture overview

`WorkspaceShell` is the root: a full-height, full-width flex row with two
children — `Sidebar` and a flex column holding a temporary demo-launcher
bar, `ConversationPane`, and `PromptBar`. `workspace-main.tsx` mounts
`WorkspaceShell` into `workspace.html`, which Vite builds as a second,
deliberately unlinked entry point alongside `index.html` (see
`ui/vite.config.ts`) — `workspace.html` and the existing derived-architecture
dashboard (`App.tsx`) share no code path.

Shared state lives in `store.ts`, a single Zustand store
(`useWorkspaceStore`). Right now it holds exactly one piece of state:
`sidebarCollapsed`, plus the `toggleSidebar` action. `Sidebar` is the only
component that reads or writes it. Nothing else in this directory is wired
to the store — `PromptBar`'s textarea value is local `useState`, not store
state, and `ConversationPane` has no state at all.

```
WorkspaceShell
├─ Sidebar               (reads/writes store.sidebarCollapsed)
├─ "Layout Demo" button  (local useState, opens LayoutDemo)
├─ ConversationPane       (no state)
├─ PromptBar              (local useState, not in the store)
└─ LayoutDemo (conditional, mock-data layout system — see §3)
```

## 2. Components

### `WorkspaceShell.tsx`

- **Purpose:** root layout — sidebar + main column, and (temporarily) the
  entry point into the layout demo.
- **Props:** none. **State:** `showLayoutDemo: boolean` (local), gates
  whether `LayoutDemo` renders.
- **Non-obvious detail (already documented inline in the file):**
  `min-w-0`/`min-h-0` on the main column's flex container is load-bearing —
  without it, a flex item refuses to shrink below its content's natural
  width, which is exactly what breaks the three-region layout at 768px.
  `ConversationPane.tsx` repeats `min-h-0 min-w-0` on its own root for the
  same reason at the next level of nesting.

### `Sidebar.tsx`

- **Purpose:** collapsible session list rail.
- **Props:** none — reads `sidebarCollapsed` and `toggleSidebar` directly
  from `useWorkspaceStore`. **State:** none of its own.
- **Behavior:** renders at `w-60` (240px) expanded, `w-14` (56px) collapsed,
  via a Tailwind class swap with a `transition-[width] duration-150`. The
  toggle button's `aria-label` and glyph (`«`/`»`) both flip with
  `collapsed`, so assistive tech and the visible icon never disagree.
- **Content:** `SESSION_PLACEHOLDERS` is a hardcoded empty array — there is
  no session list, real or mock. Collapsed state hides the "Sessions"
  label and the list body entirely, showing only the toggle button.

### `ConversationPane.tsx`

- **Purpose:** the message-log area.
- **Props/state:** none. It is a static placeholder — literally one
  centered line of text, "No messages yet. The conversation will appear
  here." No message list, no scrollback, nothing to page through yet
  (`overflow-y-auto` is set up for when there is).

### `PromptBar.tsx`

- **Purpose:** the compose box at the bottom of the shell.
- **Props:** none. **State:** `value: string` — local `useState`, tracking
  the textarea's contents. This is not read anywhere else; typing here has
  no effect outside this component.
- **Non-obvious detail:** the submit button is `disabled` as a static JSX
  prop, not a condition on `value`. It never becomes enabled, regardless of
  what's typed — `ui/e2e/workspace-shell.spec.ts`'s prompt-bar test asserts
  this exact behavior (disabled when empty, disabled when filled, disabled
  again after clearing) rather than an enabled/disabled-on-content rule the
  code does not implement. This matches the component's own comment
  ("Deliberately disabled... not yet wired to anything") — not a bug, just
  worth knowing before assuming a normal chat input's behavior.
- `onSubmit` calls `event.preventDefault()` and does nothing else.

### `store.ts`

- **Purpose:** shell-level UI state, singular: `sidebarCollapsed` and
  `toggleSidebar`. No message, session, or layout state lives here.
- Built on `zustand`'s `create`. `WorkspaceState` is the only interface
  exported.

## 3. Layout selection demo (`LayoutDemo.tsx`, `LayoutPresetPanel.tsx`, `CustomLayoutBuilder.tsx`, `LayoutWireframe.tsx`, `layout-types.ts`, `layout-presets.ts`)

Reachable only via the "Layout Demo (mock data)" button in
`WorkspaceShell` — a temporary launcher, not part of the shell's real
flow. Opens `LayoutDemo`, a full-screen modal overlay that switches
between three views: the preset panel, the custom builder, and a
"selected preset" confirmation screen.

- **`layout-types.ts`** defines `LayoutSchema`: a 12-column grid (`columns:
  12`), breakpoints at 640/768/1024/1280 (`sm`/`md`/`lg`/`xl`), up to five
  optional region types (`header`, `navigation`, `content`, `sidebar`,
  `footer`), and a fixed seven-category component palette (form-inputs,
  buttons, tables, cards, charts, media, containers). This type did not
  exist anywhere in the codebase or in the proposal document before this
  was built — it was defined fresh to match the shape requested, since no
  prior reference existed.
- **`layout-presets.ts`** exports two hardcoded `LayoutSchema` objects —
  `SINGLE_COLUMN_PRESET` (header/content/footer stacked) and
  `SPLIT_PANEL_PRESET` (header, nav + content + sidebar in one row,
  footer) — both tagged `source: 'ai-generated'` even though nothing
  generates them; see limitations below.
- **`LayoutPresetPanel.tsx`** renders exactly three options: the two
  presets above, each as a real interactive `LayoutWireframe`, plus a
  "Custom" card. Every preset card carries an explicit on-screen banner
  stating the presets are mock data.
- **`LayoutWireframe.tsx`** draws a `LayoutSchema`'s regions on a real CSS
  grid (`gridTemplateColumns`/`gridTemplateRow`, not a static image).
  Clicking a region sets local `selected` state and shows a one-line role
  description for that region type.
- **`CustomLayoutBuilder.tsx`** lets you add/remove any of the five region
  types (one instance of each at a time) and edit each one's `colStart`,
  `colSpan`, and `row` via number inputs, live-rendered through the same
  `LayoutWireframe`. A static component-palette list sits alongside it —
  no drag-and-drop, by design for this pass. Below the grid, a `<pre>`
  block shows `JSON.stringify(schema, null, 2)`, updating on every edit.
  The builder's output and both presets are typed as the same
  `LayoutSchema` — verified in `layout-types.test.ts`, which type-checks a
  hand-built custom layout against `SINGLE_COLUMN_PRESET` under one
  shared interface.

## 4. Known limitations — mock vs. real

- **Chat does not connect to a real backend.** `ConversationPane` shows
  static placeholder text; there is no message list, no streaming, no
  persistence. `PromptBar`'s submit button is permanently disabled and
  wired to nothing.
- **Sidebar sessions are not real.** `SESSION_PLACEHOLDERS` is a hardcoded
  empty array; there is no session storage, list, or switching.
- **Layout presets are hard-coded mock data, not AI-generated**, despite
  being labeled `source: 'ai-generated'` and displayed with an
  "AI-generated (mock)" badge. The orchestrator that would actually
  produce presets from a prompt does not exist yet. `LayoutPresetPanel`
  states this directly in an on-screen banner.
- **The layout demo is disconnected UI.** It is not reachable through any
  real user flow — only through the temporary "Layout Demo (mock data)"
  button — and its output (a `LayoutSchema`, whether from a preset or the
  custom builder) is not consumed by anything; selecting a preset or
  editing a custom layout only updates what's shown on screen in this
  modal.
- **The custom builder supports at most one instance per region type.**
  You cannot add two `content` regions, for example — "add/remove" toggles
  a fixed set of five, it does not create arbitrary new region instances.
- **No drag-and-drop**, in either the component palette or the grid
  editor — explicitly out of scope for this pass per the original request.

## 5. Running this part of the app standalone

From `ui/` (this is a separate package from the repo root — see the root
`CLAUDE.md` for why `npm install` has to be run in both places):

```bash
npm install       # only needed once, or after ui/package.json changes
npm run dev
```

Then open **`http://localhost:5173/workspace.html`** — not `/`, which
serves the unrelated architecture dashboard (`App.tsx`).

Expected result: the three-region shell (sidebar, empty conversation pane,
disabled prompt bar) plus a "Layout Demo (mock data)" button in the top
bar of the main column. Clicking it opens the layout selection modal
described in §3.

Tests for this directory:

```bash
npm test          # vitest, scoped to src/**/*.test.ts — currently just layout-types.test.ts
npm run test:e2e  # playwright, e2e/workspace-shell.spec.ts — starts its own dev server
```
