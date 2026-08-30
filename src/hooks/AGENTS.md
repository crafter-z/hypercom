# src/hooks/

15 hook files + 1 shared module + barrel `index.ts` — each hook owns its React↔Tauri lifecycle.

## File structure

| File | Exports | Call site | Lifecycle |
|------|---------|-----------|-----------|
| `disconnectTracking.ts` | `userClosingPortIds`, `lostPortIds`, `isUserClosingPort()`, `isPortLost()` | shared by useSerialConnection + useSerialReceive | module-level Sets for session-aware disconnect tracking |
| `useSerialPorts.ts` | `useSerialPorts(pollMs=3000)`, `mapPortInfo()`, `mergePorts()` | Sidebar | polling; `mapPortInfo`/`mergePorts` also used by useSimulation |
| `useSerialConnection.ts` | `useSerialConnection()` | Sidebar / TabBar | open/close; routes through `closePort()`; owns reconnect backoff loop; per-port in-flight guard against concurrent open/close |
| `useSerialReceive.ts` | `useSerialReceive()` | `App.tsx` **exactly once** | owns `serial:data` event listener + status handler (writes `lostPortIds` for DisconnectBanner); RX feeds `RxPipeline` (byte-level line aggregation + rAF-batched store writes), NOT direct per-event appends; TTY 端口（`mode==='tty'`）字节**直喂 `ttyService.feed`**（跳过触发引擎/协议解析/行组装），断线走 `ttyService.disconnect`（flush 队列、保留 xterm 实例跨重连） |
| `useSerialSend.ts` | `useSerialSend()`, `sendToPort()` | OperationPanel (hook); `usePopoutBridge` (module fn) | action; module-level `sendToPort` owns the real send (backend call + TX echo + traffic stats + in-memory per-port history `Map<portId, SendHistoryEntry[]>`, cap 50, no SQLite); the hook is a thin wrapper mirroring history into state for ↑/↓ recall; **TTY 分支**（`port.mode==='tty'`）跳过 TX 回显 + `flushNow`（无本地回显，仍走后端发送/流量统计/历史） |
| `usePopoutBridge.ts` | `usePopoutBridge()` | `App.tsx` **exactly once** | pop-out intent bus: listens `popout:send-command` (→ `sendToPort(activeTabId)`) / `popout:open-config` (→ ConfigModal page) / `popout:request-sync` (→ replay `active-tab:changed`); subscribes `useRuleStore.sendCommandSets` + `useAppStore.activeTabId` → emits `command-sets:changed` / `active-tab:changed` refresh signals |
| `useConfigPersistence.ts` | `useConfigPersistence()` | `App.tsx` | load + save config |
| `useSystemStatus.ts` | `useSystemStatus(pollMs=5000)` | StatusBar | polling |
| `useAppInit.ts` | `useAppInit()` | App.tsx | one-shot bootstrap; owns `isValidPaneNode`; loads settings entities (command/highlight/protocol/trigger/tool) from `config` into `useRuleStore` (preset is NOT loaded here — it lives in ParamsSection/GeneralSettings via `storageService` + local state); restores `config.portGroups` into `useAppStore.groups` + backfills `ports.groupId`; restores `config.portMeta` (alias/isHidden/mode) into ports (issue #4-9/11); debounced (500ms) auto-save of groups AND port meta on change (issue #2-3 / #4-9/10 — both write back into `config` so a full `set_config` never clobbers them); session restore via `configService.getSessionSnapshot()` |
| `useSimulation.ts` | `useSimulation()` | Sidebar toolbar | SIM:Loopback virtual port toggle; imports `mapPortInfo`/`mergePorts` from useSerialPorts; **dev-only** — no-op when `DEV_FEATURES_ENABLED` is false (issue #2-9) |
| `useGitBashSim.ts` | `useGitBashSim()` | Sidebar toolbar | debug-only GIT:BASH 模拟终端 toggle (issue #11); mirrors `useSimulation` dev gating (no-op when `DEV_FEATURES_ENABLED` false); local `useState` for the mode flag (no new store field) |
| `useToolOutput.ts` | `useToolOutput()` | App.tsx **exactly once** | `tool:output` / `tool:exit` event listeners; writes TOOL lines to terminal, updates `toolRunning` |
| `useAutoUpdate.ts` | `useAutoUpdate()` | App.tsx **exactly once** | issue #12 自动更新评估：等 `ui.configReady`（`useConfigPersistence.loadConfig` 完成置位；复审替代旧 3s 启发式窗口——config 加载慢于 3s 会按默认 stable 误判用户设置的 none/preview；15s 兜底防信号失联）后按 `shouldAutoCheck`（7 天周期/snooze/首启立即；clock rollback 视为记账损坏放行）决定是否 `runAutoCheck`（检查+记账一体，模块级 in-flight 锁防并发双弹窗）；成功（有无更新同）记 lastCheckAt（**完成时刻**），失败静默（diagLog 落盘、不重置——下次启动重试）；有更新 → `setUIState({ isUpdateOpen, updateCandidate })`。**二轮：会话内每 6h 重评估**（`setInterval`，串口工具常驻挂机覆盖；门控在 shouldAutoCheck，未到期只读 localStorage）。DEV 构建短路（`isUpdateCheckEnabled`） |
| `usePortToolActions.ts` | `usePortToolActions()` | Sidebar + Pane (TabBar menu) | external-tool actions shared by the sidebar port menu and the tab context menu (issue #2-2): `runTool` (unconfigured → jump to config page) / `killTool` / `configTool`; group execution `runToolForGroup` (issue #5-7) |
| `useHotkeys.ts` | `useHotkeys()` | App.tsx (once) | global keydown: Ctrl+L/K/B// + Escape; ignores non-Escape when focus is in a form field |
| `usePowerManagement.ts` | `usePowerManagement()` | App.tsx (once) | mirrors `config.preventScreenOff` / `config.preventSleep` to the OS via backend commands |
| `index.ts` | barrel re-export | all consumers | import from `'../../hooks'` or `'./hooks'` |

## Conventions (root covers lifecycle split rationale)

- RX lines land via `RxPipeline` (module singleton `getRxPipeline()`): byte-level line splitting, per-port queue, ONE rAF-batched `appendTerminalLines` per port per frame, 250ms silence flush for unterminated tails. Single-line writers (`appendTerminalLine`) remain for TX echo (`useSerialSend`), tool output, log replay. `sendToPort` MUST call `getRxPipeline().flushNow(portId)` BEFORE the TX echo so queued RX can't render after the send line (zero-delay cyclic sends otherwise interleave TX1,TX2,RX1). Never write `serial:data` bytes straight into the terminal store.
- The pipeline singleton is app-lifetime per webview: neither `useSerialReceive` cleanup nor `TerminalPopout` cleanup may call `dispose()`. Disconnect cleanup goes through `pipeline.disconnect(portId)` (flush tail + drop per-port state) inside the status handler.
- `useSerialReceive` MUST be called exactly once in `App.tsx`. Calling it twice double-registers the `serial:data` listener → every line gets appended twice.
- `useSerialReceive`'s status handler is the ONLY place that writes to `lostPortIds` (in `disconnectTracking.ts`). A port is marked "lost" only on a connected→disconnected transition within this session; successful `openPort`/`closePort`/reconnect clear it. `isPortLost(portId)` is exported for `DisconnectBanner.tsx` which uses the pure helper `filterLostTabIds(tabs, isPortLost)` — never probe port state from outside the hook.
- `useSerialSend` maintains in-memory per-port send history (`Map<portId, SendHistoryEntry[]>`, cap 50, dedup on content+format). `SendHistoryEntry` lives in `src/types/index.ts`. No SQLite persistence; the old `sendHistoryService` / `SendHistoryItem` were removed. Backend Rust commands survive but are not invoked from the frontend.
- `useSerialConnection.closePort()` is the only sanctioned close path: triggers `stopLogging` and updates port status. Bypassing leaks log file handles + leaves status "connected" stuck.
- `useSerialPorts(3000)` uses `mergePorts()` on every refresh — `mapPortInfo()` always overwrites status to `'disconnected'`; merge preserves alias / group / connection state / baud match AND the **existing port order** (manual sort / drag order survive polling, issue #2-5); genuinely new ports append at the end.
- `mergePorts` status 语义（issue #12 热插拔修复）：① fresh 枚举命中的端口保留 `connected`/`connecting`（真实会话），但**不保留 `error`**——前次 open 失败的错误态在端口重新枚举后被重置为 `disconnected`，否则刷新按钮永远救不回卡死状态；② 从枚举消失的 `connected`/`connecting` 端口经 union-back 保留**最多 `MAX_MISSING_POLLS=3` 轮**（模块级 `ghostMissingPolls` 计数 ≈9s 宽限，容忍瞬时 USB 抖动），超限放弃保留——不产生永久幽灵端口。幽灵计数在端口重新出现时清零。
- Polling hooks accept `pollIntervalMs` as a parameter intentionally — do not hardcode inside the hook.
- `useAppInit` runs once on mount: registers backend command handlers if needed, pulls initial config via `useConfigPersistence`. No longer syncs sendOnEnter (lives only in config). Loads settings entities directly from `config` (`cfg.sendCommandSets` etc., wire format matches store format via camelCase) into `useRuleStore` — including `triggerRules`; no startup `storageService.loadCommandSets()` calls. Session restore uses `configService.getSessionSnapshot()`.
- Pop-out windows are SEPARATE webviews with their own store instances — they never share mutable frontend state with the main window, only intents/signals (`popoutEventService` in `src/services/tauri.ts`). Sending from a pop-out MUST go through `popout:send-command` → main's `sendToPort`; a direct `serialService.sendSerialData` call from the pop-out would skip the TX echo / traffic stats / send history (the backend emits no TX event).
- Log settings are synced to LogManager internally by the backend `set_config`/`reset_config` commands (`sync_log_manager_from_config()`); the frontend no longer syncs them (`syncLogSettingsToBackend` deleted).
- Inside hook callbacks/effects, prefer `use{App,Operation,Terminal,Rule}Store.getState()` over selector-bound locals when the value must be live.

## Anti-patterns

- Calling `useSerialReceive` more than once per app lifetime.
- Registering an ad-hoc `listen('serial:data', …)` outside `useSerialReceive`.
- Bypassing `RxPipeline` in a `serial:data` handler (per-event `appendTerminalLine` fragments lines across multi-event responses AND re-renders the terminal at event rate).
- Calling `getRxPipeline().dispose()` anywhere — the singleton is app-lifetime; per-port cleanup goes through `pipeline.disconnect(portId)` in the status handler.
- Appending the TX echo before `getRxPipeline().flushNow(portId)` — queued RX then overtakes the send line (zero-delay cyclic sends interleave TX1,TX2,RX1).
- Subscribing the whole `useTerminalStore` from a component that owns a hook — same re-render pathology as in any component.
- Bypassing `closePort()` to remove a tab — corrupts log lifecycle + port status.
- Mutating `lostPortIds` from anywhere except the status handler inside `useSerialReceive`. The set encapsulates session-aware disconnect tracking; external mutation breaks `DisconnectBanner` correctness.
- Re-introducing global display fields (`displayFormat`, `encoding`, `scrollLocked`, `showTimestamp`, `loopInterval`) in `useOperationStore` — those live per-tab in `useTerminalStore`.
