# src/stores/

4 Zustand stores, no god store. Split by domain to avoid cross-domain re-render re-renders. useAppStore uses Immer; useTerminalStore is plain shallow-set (方案B moved the line buffer out of the store — no Immer, no line arrays).

## Where to look

| Store | File:line | Job |
|-------|-----------|-----|
| `useAppStore` | `useAppStore.ts:266` | tabs / ports / `paneTree` / config / groups — `setGroups` bulk-loads persisted groups at startup; group changes auto-save (500ms debounce in `useAppInit`); port alias/isHidden persisted via `config.portMeta` (issue #4-9); `setPortMode(portId, mode)` writes `Port.mode` (`'trx' | 'tty'`, issue #11), persisted via `portMeta` (no-op when port missing) |
| `useOperationStore` | `useOperationStore.ts:29` | serial params + send — `baudRate`, `dataBits`, `parity`, `stopBits`, `handshake`, `dtr`, `rts`, `ignoreEmptyChars`, `sendIsHex`, `sendAppendLineEnding`, `sendInput`, `cyclicLoops`（每端口循环发送开关 `Record<portId, boolean>`，issue #12；NO `op` prefix; NO `sendOnEnter`/`quickSendInlineCount` — those live in `useAppStore.config`; NO `displayFormat`/`encoding`/`scrollLocked`/`showTimestamp`/`loopInterval` — those live per-tab in `useTerminalStore`; NO `loopRepeatCount` — repeat count is per-command-set `SendCommandSet.repeatCount`; 旧全局 `isLoopSending` 布尔已删除，改用 `setCyclicLoop(portId, running)` 逐端口启停） |
| `useTerminalStore` | `useTerminalStore.ts:22` | pure display state (`scrollLocked`, `showTimestamp`, `displayFormat`, `encoding`, `connectedAt`) per port. 方案B（issue #14）：line buffer moved OUT into `TerminalViewportManager`'s ring buffer (`utils/terminal/viewportManager.ts`). Interface: `ensureTerminal` / `setTerminalConfig` / `setTerminalEncoding` / `setTerminalConnectedAt`. `setTerminalEncoding` updates `term.encoding`; re-decode is lazy (`getLineText` at render time) — no buffer walk. |
| `useRuleStore` | `useRuleStore.ts:32` | highlight rule sets + send-command sets + protocol templates + trigger rules + port tool configs + CRUD + active-set ids. Entities persist in config.json (loaded at startup by `useAppInit` from `config`, saved via `storageService` config-backed commands). |

## Conventions (root covers selector discipline)

- `sendOnEnter` and `quickSendInlineCount` live ONLY in `useAppStore.config`. SendSection reads them via `useAppStore(s => s.config.sendOnEnter)` / `useAppStore(s => s.config.quickSendInlineCount)`. They were removed from `useOperationStore` to eliminate dual-source ambiguity. The dead `quickSendSlots` field was deleted entirely (quick-send is command-set driven; `quickSendInlineCount` = inline strip size, 0 hides it).
- `appendTerminalLines(portId, lines[])` (module-level in `utils/terminal/viewportManager.ts`) is the RX batch-write entry (fed by `RxPipeline`'s rAF tick — writes into the ring buffer, NOT the Zustand store). 方案B（issue #14）：the ring buffer trims overflow O(1) via head-pointer advance + byte-budget drain; never reintroduce per-line `shift()` trimming or an Immer store line array.
- 内存上限（issue #16 改版）：`maxDisplayLines` 每端口终端最大显示行数（默认 100000），缓冲超限**逐行覆盖最旧**（滚动窗口）——无字节预算、无软兜底双闸、无内存裁剪 toast。
- `setTerminalEncoding(portId, encoding)` updates `term.encoding`. 方案B（issue #14）：re-decode is lazy — `getLineText(line, encoding)` decodes `rawData` at render time, so encoding switch = next render, no buffer walk. Callers switching encoding MUST flush the RX pipeline tail under the OLD label first (`getRxPipeline().flushAndReset(portId)`), or a partially-buffered line corrupts at the seam.
- Per-tab display state (`scrollLocked`, `showTimestamp`, `displayFormat`, `encoding`) was migrated from `useOperationStore` to `useTerminalStore` in the UI/UX overhaul. Display controls must use `useTerminalStore.getState().setTerminalConfig(portId, ...)` or `setTerminalEncoding(portId, encoding)`. Never reintroduce global display fields in `useOperationStore`.
- **Recursive pane tree helpers exported at module top of `useAppStore.ts`**: `findLeafById` (25), `findLeafByTabId` (37), `findBranchById` (49), `findParentBranch` (60), `collectLeaves` (75), `countLeaves` (81). Use these; don't hand-roll tree walks.
- `pruneTree` is private; auto-runs after every tree mutation: ① drops non-root empty leaves → ② collapses single-child branches (size inherits) → ③ empty root branch → degenerate `'main'` leaf.
- `focusedPaneId` references a LEAF ID in the tree (never a flat array index).
- Tree mutation actions: `splitPane`, `closeTab`, `resizeChildren(branchId, childIndex, deltaFraction)`. Use these — never write tree state by hand.
- `useAppStore.test.ts` (678 lines, vitest) exercises `splitPane` / `closeTab` / `resizeChildren` / `pruneTree`. Run with `npm run test:run`.
- In callbacks/effects needing latest value without subscribing: `useXStore.getState().y`.

## Anti-patterns

- Subscribing without a selector — every `appendTerminalLine` re-renders consumer, causing input focus loss.
- Test code using `state.panes[...]` or `state.panes.length` — that schema is gone; assert on `state.paneTree`, narrow with `as BranchPane` for `children`.
- Mutating tree state by hand instead of `splitPane`/`closeTab`/`resizeChildren`.
- Re-introducing the `op`-prefixed operation field names (`opBaudRate` etc.).
- Re-introducing `displayFormat`, `encoding`, `scrollLocked`, `showTimestamp`, or `loopInterval` into `useOperationStore`. Those fields are per-tab in `useTerminalStore` and must stay there.
- Calling a store with no selector inside a hook that owns a high-frequency listener (saps perf worse than in a render fn).