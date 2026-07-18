# src/components/MainDisplay/

Recursive pane tree (2026-07 refactor). `MainDisplay` renders the tree; leaves wrap tabs; branches fork by row/column.

## Files

| File | Lines | Job |
|------|------:|-----|
| `MainDisplay.tsx` | 177 | `renderNode(node, parentBranch)` recursion; root toggle for empty `'main'` leaf |
| `Pane.tsx` | 165 | leaf shell: TabBar + terminal container |
| `TabBar.tsx` | 192 | tabs + `@dnd-kit/sortable` horizontal reorder + cross-pane drag |
| `TerminalView.tsx` | 252 | `@tanstack/react-virtual` + highlight engine + right-click export (TXT/CSV) |
| `ResizeHandle.tsx` | 34 | drag handler → `resizeChildren(branchId, childIndex, delta)` store action |
| `hooks/useTabDragEnd.ts` | 72 | end-of-drag move; uses `findLeafByTabId` / `findLeafById` from `useAppStore.ts` |

## Conventions (root covers flexbox `min-height: 0` chain)

- New pane split: find focused leaf → replace it in the parent branch's `children` array with a new branch `[source-leaf(0.5), new-leaf(0.5)]`. If focused leaf IS the root → replace the entire tree.
- `focusedPaneId` references a leaf ID in the tree (never a flat index). Set in `useAppStore.openTab`, cleared on `closeTab`.
- `useTabDragEnd` uses tree helpers from `useAppStore.ts` — DO NOT reintroduce `state.panes.find(...)`.
- Drag a tab onto a ResizeHandle → produces a new pane split by handoff (interfaces with `MainDisplay`'s drag state).
- Right-click menu lives in `TerminalView` and exports TXT/CSV via `@tauri-apps/plugin-dialog`'s `save()` + Rust `std::fs::write`.
- `renderNode` is module-level, NOT defined inside `MainDisplay.tsx`'s body — defining render components inline causes DOM reset on identity churn.

## Anti-patterns

- Mutating the tree by hand — go through `splitPane` / `closeTab` / `resizeChildren` actions in `useAppStore`.
- Defining `TreeNodeComponent` inside `MainDisplay.tsx`'s function body — identity churn resets DOM and input focus.
- Skipping `min-height: 0` on any flex column ancestor of `.terminal-view` — scroll breaks.
- Direct DOM height mutation to "fix" sizing — use `ResizeHandle` + `resizeChildren`. Size is a fraction stored in the tree, not a pixel value.
- Closing a tab without going through `closePort()` — bypass leaks the log file handle + leaves port status "connected".