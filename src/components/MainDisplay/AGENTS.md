# src/components/MainDisplay/

Recursive pane tree (2026-07 refactor). `MainDisplay` renders the tree; leaves wrap tabs; branches fork by row/column.

## Files

| File | Lines | Job |
|------|------:|-----|
| `MainDisplay.tsx` | 171 | `renderNode(node, parentBranch)` recursion; root toggle for empty `'main'` leaf |
| `Pane.tsx` | 191 | leaf shell: TabBar + terminal container |
| `TabBar.tsx` | 234 | tabs + `@dnd-kit/sortable` horizontal reorder + cross-pane drag + split buttons (right-end `.tab-bar-split-group`, sticky so it never scrolls away; accepts `onSplitVertical`/`onSplitHorizontal` props) |
| `TerminalView.tsx` | 339 | `@tanstack/react-virtual` + highlight engine + right-click export (TXT/CSV); orchestrates `TerminalFilterBar` for per-tab display controls |
| `TerminalFilterBar.tsx` | 171 | direction/keyword filter + per-tab display controls (scroll-lock / show-timestamp / HEX-text segmented / encoding select); writes via `useTerminalStore.getState()` |
| `ResizeHandle.tsx` | 39 | drag handler → `resizeChildren(branchId, childIndex, delta)` store action |
| `hooks/useTabDragEnd.ts` | 80 | end-of-drag move; uses `findLeafByTabId` / `findLeafById` from `useAppStore.ts` |
| `hooks/useLogReplay.ts` | 66 | log replay (targets active tab); invoked from OperationPanel strip |

## Conventions (root covers flexbox `min-height: 0` chain)

- New pane split: find focused leaf → replace it in the parent branch's `children` array with a new branch `[source-leaf(0.5), new-leaf(0.5)]`. If focused leaf IS the root → replace the entire tree.
- Split buttons live in `TabBar` (not in a separate toolbar). They accept `onSplitVertical`/`onSplitHorizontal` props. Click sequence: focus the pane (set `focusedPaneId`) → then call `splitPane`. The `.tab-bar-split-group` is sticky-pinned at the right end so it never scrolls away.
- `focusedPaneId` references a leaf ID in the tree (never a flat index). Set in `useAppStore.openTab`, cleared on `closeTab`.
- `useTabDragEnd` uses tree helpers from `useAppStore.ts` — DO NOT reintroduce `state.panes.find(...)`.
- Drag a tab onto a ResizeHandle → produces a new pane split by handoff (interfaces with `MainDisplay`'s drag state).
- `TerminalFilterBar` owns per-tab display controls (scroll-lock / timestamp / HEX-text / encoding select) via `useTerminalStore.getState().setTerminalConfig(portId, ...)` / `setTerminalEncoding(portId, encoding)`. TerminalView is a thin orchestrator; it does NOT own display state.
- Encoding changes go through `setTerminalEncoding(portId, encoding)` (re-decodes existing lines from `rawData`). The old OperationPanel "encoding sync effect" pattern was removed — there is no write-back from `useOperationStore`.
- Right-click menu lives in `TerminalView` and exports TXT/CSV via `@tauri-apps/plugin-dialog`'s `save()` + Rust `std::fs::write`.
- `renderNode` is module-level, NOT defined inside `MainDisplay.tsx`'s body — defining render components inline causes DOM reset on identity churn.

## Anti-patterns

- Mutating the tree by hand — go through `splitPane` / `closeTab` / `resizeChildren` actions in `useAppStore`.
- Defining `TreeNodeComponent` inside `MainDisplay.tsx`'s function body — identity churn resets DOM and input focus.
- Skipping `min-height: 0` on any flex column ancestor of `.terminal-view` — scroll breaks.
- Direct DOM height mutation to "fix" sizing — use `ResizeHandle` + `resizeChildren`. Size is a fraction stored in the tree, not a pixel value.
- Closing a tab without going through `closePort()` — bypass leaks the log file handle + leaves port status "connected".
- Writing display state (encoding/displayFormat/scrollLocked/showTimestamp) from OperationPanel or any `useOperationStore` field — display controls are per-tab in `TerminalFilterBar` via `useTerminalStore`.
- Calling `setTerminalConfig(portId, { encoding: ... })` alone for encoding switches — use `setTerminalEncoding(portId, encoding)` which also re-decodes existing lines from `rawData`.