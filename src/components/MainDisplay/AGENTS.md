# src/components/MainDisplay/

Recursive pane tree (2026-07 refactor). `MainDisplay` renders the tree; leaves wrap tabs; branches fork by row/column.

## Files

| File | Lines | Job |
|------|------:|-----|
| `MainDisplay.tsx` | 171 | `renderNode(node, parentBranch)` recursion; root toggle for empty `'main'` leaf |
| `Pane.tsx` | 308 | leaf shell: TabBar + terminal container; renders `TtyView` for `mode==='tty'` ports, else `TerminalView`; blocks pop-out for TTY ports (`tty.popoutUnsupported` toast) |
| `TtyView.tsx` | 111 | xterm.js TTY host (issue #11): creates `Terminal` + FitAddon per port (fonts/theme from config + CSS vars), `term.open` + ResizeObserver+rAF-debounced fit, onData→`ttyService.send`, onResize→`ttyService.resize`; owns the Terminal instance (dispose on unmount, `ttyService.detach` keeps it) |
| `TabBar.tsx` | 234 | tabs + `@dnd-kit/sortable` horizontal reorder + cross-pane drag + split buttons (right-end `.tab-bar-split-group`, sticky so it never scrolls away; accepts `onSplitVertical`/`onSplitHorizontal` props) |
| `TerminalView.tsx` | 482 | `@tanstack/react-virtual` + highlight engine + right-click export (TXT/CSV); explicit-intent scroll lock (NO onScroll handler) + scrollbar-end quick-jump buttons; orchestrates `TerminalFilterBar` for per-tab display controls |
| `TerminalRow.tsx` | — | one virtualized row; `React.memo` + primitive props (`prevLine`/`displayFormat`/`showTimestamp`/`connectedAt`) so only newly-rendered rows do highlight work under batched appends; search hit-rows get the character-level `<mark>` layer via `markSearchMatchesInHtml` (`searchQuery`/`searchCaseSensitive` props — empty query while search closed) |
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
- `TerminalFilterBar` owns per-tab display controls (scroll-lock / timestamp / HEX-text / encoding select) via `useTerminalStore.getState().setTerminalConfig(portId, ...)` / `setTerminalEncoding(portId, encoding)`. TerminalView is a thin orchestrator; it does NOT own display state. Encoding changes MUST flush the RX pipeline tail under the OLD label first (`getRxPipeline().flushAndReset(portId)`) — already wired in `TerminalFilterBar.handleEncodingChange`.
- **Scroll lock is explicit-intent only.** `scrollLocked` (per-tab in `useTerminalStore`) is written by exactly three paths: the pin toggle, the `.terminal-jump-btn` buttons, and `settle()` ~120ms after a user scroll gesture (wheel / keyboard nav / scrollbar-drag / middle-click autoscroll). TerminalView has NO `onScroll` handler — raw scroll events also fire for programmatic scrolls, mount-at-top, virtualizer lag and content growth, and letting them write the lock was the root cause of the implicit-unlock bugs. Auto-follow (jump to bottom on new rows) is suppressed while paused, during a gesture, or while the search bar is open; closing search re-pins if locked.
- Quick-jump buttons ride the scrollbar ends inside the `.terminal-scroll-wrap` wrapper: top → unlock + `scrollToIndex(0)`, bottom → lock + `scrollToBottom()`. The wrapper preserves the flex `min-height: 0` chain.
- **Search (Ctrl+F) is performance-gated** (issue #2-8): match indices compute ONLY while the search bar is open (`useTerminalSearch`), never in the background — a stale query would otherwise rescan the whole buffer on every RX batch. Query extension narrows the scan to previous matches ∪ new lines (`findMatchesIncremental`). Character-level highlight: `markSearchMatchesInHtml` wraps query occurrences in `<mark class="terminal-search-mark">` on hit rows only — it is HTML-tag/entity aware (works over highlight-engine spans and protocol coloring, splitting cross-span matches). Known edge: F3 re-opening a closed search needs a second press to navigate (matches compute after opening).
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
- Re-introducing an `onScroll`-driven `scrollLocked` write in TerminalView — that heuristic (atBottom + programmatic-scroll guard) permanently unlocked during fast output and on tab remount. Lock changes come only from the pin button / jump buttons / user-gesture `settle()`.
- Passing the whole `terminal` object or the `lines` array into `TerminalRow` — defeats its `React.memo` (both change identity on every RX batch). Pass `prevLine` + the primitives it needs.
- Calling `setTerminalConfig(portId, { encoding: ... })` alone for encoding switches — use `setTerminalEncoding(portId, encoding)` which also re-decodes existing lines from `rawData`.