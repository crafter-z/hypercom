# src/stores/

Six Zustand stores, no god store. Split by domain so a write in one domain cannot re-render subscribers of another. `useAppStore` / `useRuleStore` / `useOperationStore` / `useToastStore` use Immer; `useTerminalStore` / `useSystemStore` are plain shallow-set (no line arrays, no proxies).

## Where to look

| Store | File | Job |
|-------|------|-----|
| `useAppStore` | `useAppStore.ts` | ports / groups / tabs / `paneTree` / `config`(只读快照). `setGroups` bulk-loads persisted groups at startup; group changes auto-save (500ms debounce in `useAppInit`); port alias/isHidden persisted via `config.portMeta` (issue #4-9); `setPortMode(portId, mode)` writes `Port.mode` (`'trx' \| 'tty'`, issue #11), persisted via `portMeta` (no-op when port missing). Exports `AppStoreState`（非 React 消费者引用状态形状）and the close-set query `getClosingTabIds` / `CloseScope`. |
| `useSystemStore` | `useSystemStore.ts` | 运行期系统态：`systemStatus`、`trafficStats`、`simulationMode`、`ui.*`（含 `configReady`）. 高频写点（5s 系统轮询 / 每端口 1s 流量 flush / 拖拽 resize）集中在这里，所以它必须与 `useAppStore` 分开，否则每次流量 flush 都会唤醒端口/标签订阅者。 |
| `useOperationStore` | `useOperationStore.ts` | serial params + send — `baudRate`, `dataBits`, `parity`, `stopBits`, `handshake`, `dtr`, `rts`, `ignoreEmptyChars`, `sendIsHex`, `sendAppendLineEnding`, `sendInput`, `cyclicLoops`（每端口循环发送开关 `Record<portId, boolean>`，issue #12；NO `op` prefix; NO `sendOnEnter`/`quickSendInlineCount` — those live in `useAppStore.config`; NO `displayFormat`/`encoding`/`scrollLocked`/`showTimestamp`/`loopInterval` — those live per-tab in `useTerminalStore`; NO `loopRepeatCount` — repeat count is per-command-set `SendCommandSet.repeatCount`; 旧全局 `isLoopSending` 布尔已删除，改用 `setCyclicLoop(portId, running)` 逐端口启停） |
| `useTerminalStore` | `useTerminalStore.ts` | pure display state (`scrollLocked`, `showTimestamp`, `displayFormat`, `encoding`, `connectedAt`) per port. 方案B（issue #14）：line buffer moved OUT into `TerminalViewportManager`'s ring buffer (`utils/terminal/viewportManager.ts`). Interface: `ensureTerminal` / `setTerminalConfig` / `setTerminalEncoding` / `setTerminalConnectedAt` / `releaseTerminal`. `setTerminalEncoding` updates `term.encoding`; re-decode is lazy (`getLineText` at render time) — no buffer walk. |
| `useRuleStore` | `useRuleStore.ts` | highlight rule sets + send-command sets + protocol templates + trigger rules + port tool configs + CRUD + active-set ids. Entities persist in config.json (loaded at startup by `useAppInit` from `config`, saved via `storageService` config-backed commands). |
| `useToastStore` | `useToastStore.ts` | notification center + transient toasts (`push`, max 5 visible); module-level `notifyError` / `notifySuccess` / `notifyInfo` for non-React callers. |

## Conventions (root covers selector discipline)

- **活动标签只有一个来源**：`useAppStore.activeTabId`（渲染侧 `tab.id === activeTabId` 派生）。`TabItem` 没有 `isActive` —— 双表示会漂移，且切换要遍历整个 tabs 数组。
- **关闭标签/端口后的回收走 `releaseTerminalState(portId)`**（`releaseTerminalState.ts`）：一次性清掉 `useTerminalStore.terminals` 条目、流量统计（含聚合器里未 flush 的字节）、以及 `useSerialSend` 的 per-port TX 历史。关闭路径有多条（关标签、批量关闭），任何一条漏调都会留下幽灵端口。触发点是**关标签**，不是断连——断连后标签仍在，终端显示态（滚动锁/编码）要跨重连保留。
- 关闭范围语义的唯一实现是 `getClosingTabIds(tabId, scope)`（`'self' | 'toLeft' | 'toRight' | 'others'`）：`toLeft`/`toRight` 按**所属叶子的 tabIds 顺序**（屏幕顺序）且不碰别的分屏；固定标签只被 `'self'` 关闭。4 个关闭动作（`closeTab` / `closeTabsToLeft` / `closeTabsToRight` / `closeOtherTabs`）共用它。
- `sendOnEnter` and `quickSendInlineCount` live ONLY in `useAppStore.config`. SendSection reads them via `useAppStore(s => s.config.sendOnEnter)` / `useAppStore(s => s.config.quickSendInlineCount)`. They were removed from `useOperationStore` to eliminate dual-source ambiguity. The dead `quickSendSlots` field was deleted entirely (quick-send is command-set driven; `quickSendInlineCount` = inline strip size, 0 hides it).
- `appendTerminalLines(portId, lines[])` (module-level in `utils/terminal/viewportManager.ts`) is the RX batch-write entry (fed by `RxPipeline`'s rAF tick — writes into the ring buffer, NOT the Zustand store). 方案B（issue #14）：the ring buffer trims overflow O(1) via head-pointer advance + byte-budget drain; never reintroduce per-line `shift()` trimming or an Immer store line array.
- 内存上限（issue #16 改版）：`maxDisplayLines` 每端口终端最大显示行数（默认 100000），缓冲超限**逐行覆盖最旧**（滚动窗口）——无字节预算、无软兜底双闸、无内存裁剪 toast。
- `setTerminalEncoding(portId, encoding)` updates `term.encoding`. 方案B（issue #14）：re-decode is lazy — `getLineText(line, encoding)` decodes `rawData` at render time, so encoding switch = next render, no buffer walk. Callers switching encoding MUST flush the RX pipeline tail under the OLD label first (`getRxPipeline().flushAndReset(portId)`), or a partially-buffered line corrupts at the seam.
- Per-tab display state (`scrollLocked`, `showTimestamp`, `displayFormat`, `encoding`) lives in `useTerminalStore`. Display controls must use `useTerminalStore.getState().setTerminalConfig(portId, ...)` / `setTerminalEncoding(portId, encoding)` / `useSystemStore.getState().setUIState(...)` for panel layout. Never reintroduce global display fields in `useOperationStore`.
- **分屏树算法在 `utils/paneTree.ts`**：`findLeafById` / `findLeafByTabId` / `findBranchById` / `findParentBranch` / `collectLeaves` / `countLeaves` / `pruneTree` / `newPaneId`。store 只做状态编排，不要再把树算法搬回 `useAppStore.ts`。
- `pruneTree` auto-runs after every tree mutation: ① drops non-root empty leaves → ② collapses single-child branches (size inherits) → ③ empty root branch → degenerate `'main'` leaf.
- `focusedPaneId` references a LEAF ID in the tree (never a flat array index). 任何改动 `paneTree` 的动作收尾都要 `revalidateFocus`：悬空 id 会让 `openTab` 把标签推进 `state.tabs` 却挂不到任何叶子（孤儿标签）。
- Tree mutation actions: `splitPane`, `closeTab`, `resizeChildren(branchId, childIndex, deltaFraction)`. Use these — never write tree state by hand.
- **全量保存配置走 `useConfigPersistence.saveConfig(patch?)`**：内部从活数据源拼安全快照（`useRuleStore` 实体 + `useAppStore.groups` + 由 `ports` 派生的 `portMeta` + 后端读回的 `portPresets`），因为 `set_config` 是整体替换。不要在别处回写 `store.config` 的实体数组来「防覆盖」。
- 测试用 `resetStoresForTests()`（`resetStores.ts`）而不是手抄每个 store 的默认字段；它按模块加载时的快照整份替换。
- In callbacks/effects needing latest value without subscribing: `useXStore.getState().y`.

## Anti-patterns

- Subscribing without a selector — every `appendTerminalLine` re-renders consumer, causing input focus loss.
- Test code using `state.panes[...]` or `state.panes.length` — that schema is gone; assert on `state.paneTree`, narrow with `as BranchPane` for `children`.
- Mutating tree state by hand instead of `splitPane`/`closeTab`/`resizeChildren`.
- Re-introducing the `op`-prefixed operation field names (`opBaudRate` etc.).
- Re-introducing `displayFormat`, `encoding`, `scrollLocked`, `showTimestamp`, or `loopInterval` into `useOperationStore`. Those fields are per-tab in `useTerminalStore` and must stay there.
- Putting `ui.*` / `systemStatus` / `trafficStats` / `simulationMode` back into `useAppStore` — they belong to `useSystemStore` (high-frequency writers).
- Calling a store with no selector inside a hook that owns a high-frequency listener (saps perf worse than in a render fn).
