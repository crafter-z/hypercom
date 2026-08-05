# PROJECT KNOWLEDGE BASE — HyperCom

**Generated:** 2026-08-02 · **Stack:** Tauri v2 (2.11.x) + React 18 + Rust (tokio + serialport)

## OVERVIEW

HyperCom — modern serial-port debug tool. Rust owns I/O; React owns UI. State in 4 Zustand stores; 11 hooks in individual files under `src/hooks/` own the Tauri bridge. Backend commands split into 9 domain files + `CommandError` enum. `paneTree: PaneNode` (recursive) replaced the flat `panes` array on 2026-07. Per-tab display state (scrollLocked/displayFormat/encoding/showTimestamp) lives in `useTerminalStore`, NOT in `useOperationStore`. Decorations disabled — custom TitleBar drives window controls. Cross-platform power management (Win32/macOS/Linux). Conditional trigger engine (pattern match → alert/auto-respond, per-port scoping via `portId`, wired in `useSerialReceive` — issue #3-1).

## STRUCTURE

```
hypercom/
├── src/                          # React frontend
│   ├── main.tsx, App.tsx         # entrypoints (App.tsx owns AppInit + SerialReceive + global right-click disable)
│   ├── i18n.ts                   # i18next + react-i18next, 266 keys × zh-CN/en-US
│   ├── services/tauri.ts         # invoke wrapper layer (6 service modules)
│   ├── hooks/                    # 11 hooks in individual files + barrel index.ts + disconnectTracking.ts
│   ├── stores/                   # 4 Zustand + Immer stores (no god store)
│   │   ├── useAppStore.ts        # tabs / ports / paneTree / config / groups + tree helpers
│   │   ├── useOperationStore.ts  # serial params + send (NO `op` prefix; NO display state fields)
│   │   ├── useTerminalStore.ts   # terminal buffer + appendTerminalLine + setTerminalEncoding
│   │   └── useRuleStore.ts       # highlight + send-command + trigger rule sets + CRUD
│   ├── utils/                    # highlightEngine / protocolParser / triggerEngine / hexUtils / rxAssembler / rxPipeline / diagLog + their tests
│   ├── types/index.ts            # shared TS types
│   └── components/               # MainDisplay / ConfigModal / OperationPanel / Sidebar / TitleBar / StatusBar / shared
├── src-tauri/src/                # Rust backend
│   ├── main.rs, lib.rs           # entrypoint + AppState + command registration + setup
│   ├── system.rs                 # cross-platform power mgmt (Win32 FFI / macOS caffeinate / Linux systemd-inhibit)
│   ├── diaglog.rs                # 应用自身诊断日志（全局 log::Log，落盘 + 轮转 + 读/清/追加）
│   ├── commands/                 # 9 domain files + mod.rs (CommandError enum + re-exports)
│   ├── serial/mod.rs             # serialport + SIM:Loopback virtual port (505 lines)
│   ├── logger/mod.rs             # BufWriter + rotation + path templating (501 lines)
│   └── config/mod.rs             # JSON config + 8 settings entity types + session.json + versioning + validation + path + backup
└── plans/                        # design docs (see "Key design reference" below)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add frontend state field | `src/stores/use{App,Operation,Terminal,Rule}Store.ts` | pick correct store only; god store is deprecated |
| Add Tauri command | `src-tauri/src/commands/<domain>.rs` + register in `lib.rs` | return `Result<T, CommandError>`, NOT `String` |
| Cross `.await` lock | extract + clone + drop the `MutexGuard` first | see pattern in `commands/log.rs` |
| Add serial hook | `src/hooks/<hookName>.ts` + export from `index.ts` | follow 11-hook lifecycle; do not revive `useSerialData`-style |
| 应用自身诊断日志 | `src-tauri/src/diaglog.rs` + `commands/diag.rs` + `src/utils/diagLog.ts` + `shared/DiagnosticLogDialog.tsx` | 后端 `log::*` + 前端 `console.*`（`setupDiagLogCapture` 拦截转发）统一落盘 `%APPDATA%/hypercom/diag/hypercom-debug.log`（512KB 轮转保留 3 份）；查看入口在「关于 → 诊断日志」，开关 `config.diagnosticLogEnabled` |
| Split pane recursively | `useAppStore.splitPane` action via tree helpers | NO flat `state.panes` anywhere |
| Pane tree traversal | module-top exports in `useAppStore.ts` (`findLeafById` … `countLeaves`) | do not hand-roll tree walks |
| Highlight engine | `src/utils/highlightEngine.ts` + tests | state in `useRuleStore`, persisted via `storageService` |
| ConfigModal page edit | `src/components/ConfigModal/pages/*.tsx` | rule state in `useRuleStore`; persisted via config.json (`storageService` wraps config-backed commands) |
| Cyclic send | `src/components/OperationPanel/hooks/useCyclicSend.ts` | reads `useRuleStore.sendCommandSets` via `getState`; timing via per-command `delay` + set `loopDelay` only (no global interval) |
| Cross-platform power | `src-tauri/src/system.rs` | Win32 `SetThreadExecutionState` / macOS `caffeinate` / Linux `systemd-inhibit` |
| Multi-encoding | backend `encoding_rs::GBK`, frontend `TextDecoder` + `setTerminalEncoding` | RX 切行/解码/批写统一走 `RxPipeline`（每端口按 label 缓存 decoder，`ignoreBOM:true`）；切换编码 live re-decode |
| RX 高频接收管线 | `src/utils/rxAssembler.ts` + `rxPipeline.ts` | 字节级行聚合（CR/LF/跨事件 CRLF/4KB 强制发射）+ rAF 批写 + 250ms 静默 flush（时间戳=最后事件时间）；`getRxPipeline()` 每 webview 一个单例，cleanup 不得 dispose |
| 滚动锁定 / 快捷跳转 | `TerminalView.tsx` 显式意图状态机 + `.terminal-jump-btn` | `scrollLocked` 仅由图钉按钮/跳转按钮/手势 settle 写入，**无 onScroll 隐式解锁**；跳转按钮钉在滚动条两端（到顶解锁、到底锁定跟随） |
| DisconnectBanner | `src/components/StatusBar/DisconnectBanner.tsx` + `hooks/disconnectTracking.ts` `isPortLost`/`filterLostTabIds` | suppresses startup false alarm for session-restored tabs |
| Conditional triggers | `src/utils/triggerEngine.ts` + `useRuleStore.triggerRules` + `ConfigModal/pages/TriggerSettings.tsx` | pattern match (contains/exact/regex/hex) → alert/auto-respond; per-port via `portId` (empty=all); persisted in config.json; **wired in `useSerialReceive`** (issue #3-1) |
| Add translation | `src/i18n.ts` | add key under `zh-CN` and `en-US`; don't translate protocol acronyms (None/Even/Xon/RTS/GBK/...) |
| Loopback virtual port | `useSimulation` hook + `commands/simulation.rs` | flask icon in sidebar toolbar |
| External tool (flasher) | `commands/serial.rs` `run_port_tool`/`kill_port_tool` + `useToolOutput` hook + `ToolSettings` page | close→spawn→stream→reopen 闭环；`{port}` 模板替换；配置在设置弹窗「外部工具」页；触发在侧边栏右键菜单 |
| Resize operation panel | `src/components/shared/OperationPanelResizeHandle.tsx` + `ui.operationPanelHeight` | vertical drag handle between MainDisplay and OperationPanel; default 280px (issue #2-6), clamp [160,600] |
| 标签页批量开关串口 / 标签外部工具菜单 | `TabBar.tsx` 右键菜单 + `Pane.tsx` 接线 + `usePortToolActions` | 「打开/断开所有标签页」遍历全局 tabs 逐个 open/close（100ms 节流）；工具三入口与侧边栏同源（`usePortToolActions`），文案复用 `sidebar.port.contextMenu.*` key |
| 串口分组持久化 | `config/mod.rs` `port_groups` + `commands/storage.rs` `save_port_groups` + `useAppInit` | 分组是第 7 类 config 实体；启动经 `get_config` 恢复并回填 `ports.groupId`；groups 变更 500ms 防抖自动保存（无手动「保存布局」按钮） |
| 端口自然排序 | `src/utils/portSort.ts` + `Sidebar.tsx` `sortMode` | `naturalCompare` 数字段按数值比较（COM1<COM2<COM12）；排序是持久开关→派生序渲染；`mergePorts` 按 existing 顺序合并，轮询不冲掉排序/拖拽顺序 |
| 模拟串口仅调试模式 | `src/utils/devMode.ts` + `commands/simulation.rs` | 前端 `DEV_FEATURES_ENABLED = import.meta.env.DEV` 隐藏全部 SIM UI；后端 release（`cfg(not(debug_assertions))`）命令直接报错；仅 `npm run tauri dev` 可用 |
| 终端搜索字符级高亮 | `terminalSearch.ts` `markSearchMatchesInHtml` | HTML tag/实体感知的 `<mark>` 叠加层，只在命中行应用；匹配计算仅搜索栏打开时进行 + `findMatchesIncremental` 前缀收窄 |
| First-run config creation | `config/mod.rs` `ConfigManager::new` | config.json created on first run with default `AppConfig` (empty entity arrays); no database |
| Config versioning / migration | `config/mod.rs` `migrate()` + `config_version` field | fresh schema (`config_version = 1`), forward-compatible, additive |
| Config path customization | CLI `--config` / `HYPERCOM_CONFIG` env / portable mode | resolution order in `ConfigManager::new` |
| Config validation | `config/mod.rs` `validate_and_clamp()` | runs on `set_config` to enforce bounds |
| Config backup / recovery | `config/mod.rs` `save()` writes `.bak` / `new()` falls back to `.bak` | corrupt JSON auto-recovered |
| Session snapshot update | `update_session_snapshot` dedicated command | writes separate `session.json` (not config.json); avoids full config save + `.bak` churn |

## CODE MAP

Frontend (manual review; TypeScript LSP unavailable in this environment):

| Symbol | File | Type | Role |
|--------|------|------|------|
| `useAppStore` | `src/stores/useAppStore.ts:266` | Zustand store | tabs / ports / `paneTree` / config / groups |
| `useOperationStore` | `src/stores/useOperationStore.ts:29` | Zustand store | serial params + send (NO `op` prefix; NO display state) |
| `useTerminalStore` | `src/stores/useTerminalStore.ts:22` | Zustand store | line buffer + `appendTerminalLine` (单行：TX/工具/回放) + `appendTerminalLines` (RX 批写) + `setTerminalEncoding` (re-decode on switch) |
| `useRuleStore` | `src/stores/useRuleStore.ts:32` | Zustand store | highlight + send-command rule sets + CRUD |
| `findLeafById` / `findLeafByTabId` / `findParentBranch` / `findBranchById` / `collectLeaves` / `countLeaves` | `src/stores/useAppStore.ts:25-85` | pure fns | recursive `PaneNode` tree traversal |
| 11 hooks: `useSerialPorts` / `useSerialConnection` / `useSerialReceive` / `useSerialSend` / `useConfigPersistence` / `useSystemStatus` / `useAppInit` / `useSimulation` / `useToolOutput` / `usePopoutBridge` / `usePortToolActions` | `src/hooks/*.ts` + barrel `index.ts` | hooks | Tauri bridge — see `src/hooks/AGENTS.md`; RX → `RxPipeline` 批写，TX 回显前 `flushNow` 排空队列保时序；`useAppInit` 还负责分组/端口元数据（备注名/隐藏）恢复 + 防抖自动保存（issue #2-3 / #4-9/10）；`usePortToolActions` 是侧边栏/标签页外部工具菜单的共享动作源（issue #2-2） |
| `RxLineAssembler` / `RxPipeline` / `getRxPipeline` | `src/utils/rxAssembler.ts`, `src/utils/rxPipeline.ts` | RX 管线 | 字节级行聚合 + rAF 批写 + 静默/断线/编码切换 flush；主窗与弹出窗各自模块单例 |
| `ReassemblerSegment` | `src/utils/protocolParser.ts` | type | `ProtocolFrameReassembler.feed()` 返回有序段数组（frame/raw 按流顺序），不再是 `{frames, flushedBytes}` |
| Pop-out intent bridge | `src/hooks/usePopoutBridge.ts` + `popoutEventService` in `src/services/tauri.ts` | pop-outs are separate webviews: exchange intents (`popout:send-command` / `popout:open-config` / `popout:request-sync`) + refresh signals (`command-sets:changed` / `active-tab:changed`), never shared mutable state; sends route through module-level `sendToPort` so TX echo/traffic/history work |
| `evaluateTriggers` | `src/utils/triggerEngine.ts` | pure fn | conditional trigger matching engine (contains/exact/regex/hex) |
| `tauri` service modules | `src/services/tauri.ts` | service | wrapped `invoke` calls (6 modules) |

Backend:

| Symbol | File | Type | Role |
|--------|------|------|------|
| `CommandError` | `src-tauri/src/commands/mod.rs:20` | enum (thiserror) | Serial/Config/Log/System/Lock/Io/Other; manual `serde::Serialize` |
| All Tauri commands (9 domain files) | `src-tauri/src/commands/*.rs` | Tauri cmd | see `src-tauri/src/commands/AGENTS.md` |
| `ConfigManager` + `AppConfig` | `src-tauri/src/config/mod.rs` | struct | holds all settings entities (8 Vec fields) + session.json + versioning + validation + path resolution + backup/recovery |
| `AppState` | `src-tauri/src/lib.rs` | struct | holds `serial_manager` / `logger` / `config_manager` behind `std::sync::Mutex` |
| `win32_power` / `macos_power` / `linux_power` | `src-tauri/src/system.rs` | mod | cross-platform `prevent_sleep` / `prevent_screen_off` |

Subdir guides: [`src/stores/AGENTS.md`](src/stores/AGENTS.md) · [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) · [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) · [`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md) · [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md) · [`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md)

---

## Detailed gotchas

## Build & verify

```bash
# Run the full app (frontend + backend)
npm run tauri dev

# TypeScript check only (fast, no Rust)
npx tsc --noEmit

# Rust check only (fast, skips codegen)
cargo check
# or full build:
cargo build

# Both must pass before committing.
# Run cargo commands inside src-tauri/:
cargo check --manifest-path src-tauri/Cargo.toml
```

On Windows PowerShell, `npm` may be blocked by execution policy — use:
```powershell
cmd /c "npm run tauri dev"
```

## Two-compiler project

- Frontend: React 18 + TypeScript + Vite (`src/`)
- Backend: Rust + Tauri v2 (`src-tauri/`)
- Tauri v2 uses ```invoke` for frontend→backend calls and `app.emit` for backend→frontend events
- `@tauri-apps/api` (npm) and `tauri` (Cargo) must be same minor version. Currently both **2.11.x**.

## Zustand: always use selectors

**Critical**: Calling any store without a selector subscribes to the ENTIRE store. Every serial data event will re-render that component, causing input focus loss and jank.

State is split across **4 Zustand stores**. Always pick the right store and subscribe with a selector.

### useAppStore — tabs, ports, panes, config, groups

```tsx
// WRONG — re-renders on every appendTerminalLine
const { ports, openTab } = useAppStore();

// CORRECT — only subscribes to specific fields
const ports = useAppStore(s => s.ports);
const openTab = useAppStore(s => s.openTab);
```

### useOperationStore — baudRate, dataBits, parity, stopBits, handshake, dtr, rts, sendInput, sendIsHex, sendAppendLineEnding, ...

Operation fields have **NO `op` prefix**. They were renamed from `opBaudRate` to `baudRate`, `opDataBits` to `dataBits`, etc.

**Note**: `sendOnEnter` and `quickSendInlineCount` do NOT live here. They are in `useAppStore.config` only. SendSection reads them via `useAppStore(s => s.config.sendOnEnter)` / `useAppStore(s => s.config.quickSendInlineCount)`. Display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) and `loopInterval` are also NOT here — they live per-tab in `useTerminalStore`. The cyclic-send repeat count (`loopRepeatCount`) is also NOT here — it moved to per-command-set `SendCommandSet.repeatCount` (config.json), read by `useCyclicSend` from the active set.

```tsx
const baudRate = useOperationStore(s => s.baudRate);
const sendInput = useOperationStore(s => s.sendInput);
const setOpState = useOperationStore(s => s.setOpState);
```

### useTerminalStore — terminals, appendTerminalLine, clearTerminal, setTerminalConfig, setTerminalEncoding, ensureTerminal

Hooks that need to write terminal lines without subscribing should use `getState()`:

```tsx
// Inside a hook callback (no re-render needed)
useTerminalStore.getState().appendTerminalLine(portId, line);

// In a component that renders terminal content
const terminals = useTerminalStore(s => s.terminals);
```

### useRuleStore — highlightRuleSets, sendCommandSets, triggerRules + CRUD

```tsx
const highlightRuleSets = useRuleStore(s => s.highlightRuleSets);
const activeHighlightSetId = useRuleStore(s => s.activeHighlightSetId);
const addHighlightRuleSet = useRuleStore(s => s.addHighlightRuleSet);
```

Use `useAppStore.getState()`, `useOperationStore.getState()`, `useTerminalStore.getState()`, or `useRuleStore.getState()` inside callbacks/effects when you need the latest value without subscribing.

## Components: define at module level

React components defined inside parent functions cause DOM destruction on every re-render because the function identity changes:

```tsx
// WRONG — input loses focus on every keystroke
const Parent = () => {
  const Child = (props) => <input ... />;  // new function every render
  return <Child />;
};

// CORRECT
const Child = (props) => <input ... />;
const Parent = () => <Child />;
```

## Flexbox scrolling: min-height:0 chain

For terminal scrolling to work, every flex ancestor in the column chain must have `min-height: 0`:

```
.pane-container-inner       (flex:1, flex column, min-height:0)
  └─ .terminal-view-container (flex:1, flex column, min-height:0)
       └─ .terminal-view       (flex:1, min-height:0, overflow-y:auto) ← scrolls
```

Without `min-height: 0`, flex children default to `min-height: auto` and won't shrink below content size.

## Rust: no MutexGuard across .await

`std::sync::MutexGuard` is `!Send`. Tauri async commands require the future to be `Send`. Always drop the lock before `.await`:

```rust
// WRONG
let mgr = state.serial_manager.lock().unwrap();
mgr.some_async_method().await;  // MutexGuard held across await

// CORRECT
let cfg = {
    let mgr = state.config_manager.lock().unwrap();
    mgr.get_config().clone()  // extract & clone, then drop MutexGuard
};
some_async_fn(&cfg).await;
```

## Port list polling: preserve state with mergePorts

`useSerialPorts(3000)` polls every 3s. `mapPortInfo()` always sets `status: 'disconnected'`. Use `mergePorts()` to preserve existing port state (status, alias, group, baud rate, etc.) when refreshing the list.

## Hooks: useSerialReceive vs useSerialSend

The old `useSerialData` hook was split into two hooks with different lifecycles:

- **`useSerialReceive()`** — Owns the serial data event listener lifecycle. Called **once** in `App.tsx`. Listens to `serial:data` events and feeds them into the **RX pipeline** (`getRxPipeline()`: byte-level line aggregation + rAF-batched `appendTerminalLines`); on `disconnected` it calls `pipeline.disconnect(portId)` (flush tail + drop per-port state). Holds NO store selector subscriptions. Never call this more than once.
- **`useSerialSend()`** — Returns a send action. Called in `OperationPanel`. Writes to the serial port and appends the sent line to the terminal via `useTerminalStore.getState().appendTerminalLine()`. The actual work lives in the **module-level exported `sendToPort(portId, data, isHex, lineEnding, silent?)`** (TX echo + traffic stats + in-memory history) so non-hook callers — the pop-out intent bridge — reuse the exact same pipeline instead of calling the backend directly. It drains the RX pipeline queue (`flushNow`) BEFORE the TX echo so batched RX can't overtake the send order.

Both hooks write to the terminal store through `getState()` to avoid re-rendering the hook owner on every line.

The full hook set in `src/hooks/` (11 hooks, individual files):

| Hook | Purpose | Called in |
|------|---------|-----------|
| `useSerialPorts` | Polls port list every 3s | Sidebar |
| `useSerialConnection` | open/close port, routes through `closePort()` | Sidebar / TabBar |
| `useSerialReceive` | `serial:data` event listener → `RxPipeline` (byte-level line aggregation + rAF batch) + status handler (`lostPortIds` for DisconnectBanner) | App.tsx (once) |
| `useSerialSend` | Send action | OperationPanel |
| `useConfigPersistence` | Load/save config to backend | App.tsx |
| `useSystemStatus` | Polls CPU/memory every 5s | StatusBar |
| `useAppInit` | One-shot app bootstrap | App.tsx |
| `useSimulation` | Toggle SIM:Loopback virtual port | Sidebar toolbar |
| `useToolOutput` | `tool:output` / `tool:exit` event listeners | App.tsx (once) |
| `usePopoutBridge` | pop-out intent bus: `popout:send-command` → `sendToPort(activeTabId)`, `popout:open-config` → ConfigModal page, `popout:request-sync` → replay `active-tab:changed`; broadcasts `command-sets:changed` / `active-tab:changed` on store changes | App.tsx (once) |

## Rust backend: CommandError and commands/ split

All Tauri commands return `Result<T, CommandError>` instead of `Result<T, String>`. `CommandError` is a `thiserror` enum defined in `commands/mod.rs` with variants per domain:

```rust
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("Serial error: {0}")]
    Serial(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("Log error: {0}")]
    Log(String),
    #[error("System error: {0}")]
    System(String),
    #[error("Lock error: {0}")]
    Lock(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}
```

It implements `serde::Serialize` manually so the frontend receives the error string via `invoke`.

Commands are split into 9 domain files under `src-tauri/src/commands/`:

| File | Domain |
|------|--------|
| `serial.rs` | open_port, close_port, send_data, set_serial_params, set_flow_control, send_file, cancel_file_send, attempt_reconnect, run_port_tool, kill_port_tool |
| `simulation.rs` | enable_simulation, disable_simulation |
| `config.rs` | get_config, set_config, reset_config, update_session_snapshot, get_session_snapshot, get_config_path |
| `diag.rs` | get_diag_log_path, read_diag_log, clear_diag_log, append_diag_log（应用自身诊断日志） |
| `log.rs` | start_logging, stop_logging, save_log_as, export_terminal_log, get_log_files, set_log_split_size, set_log_split_enabled, set_log_filename_format, set_log_auto_save, set_log_encoding, open_path, open_log_directory, migrate_log_directory |
| `storage.rs` | settings entities CRUD (command sets / highlight sets / protocol templates / trigger rules / port presets / tool configs) + save_port_groups + save_port_meta — synchronous ConfigManager operations on config.json |
| `file.rs` | write_text_file, read_text_file（配置导入导出） |
| `popout.rs` | open_popout, close_popout, set_popout_always_on_top |
| `system_cmds.rs` | get_system_status, prevent_sleep, prevent_screen_off |

`mod.rs` re-exports all commands and defines `CommandError`.

`src-tauri/src/system.rs` contains the `win32_power` module (Win32 `SetThreadExecutionState` FFI) used by `system_cmds.rs`. It was extracted from the old `commands/mod.rs` during the refactor.

## GBK decoding

GBK encoding uses `encoding_rs::GBK` on the Rust side. The old code returned U+FFFD placeholder characters for non-ASCII bytes. The frontend now receives proper UTF-8 from the backend and decodes with `TextDecoder` for other encodings.

## closeTab lifecycle

Closing a tab routes through `useSerialConnection.closePort()`, which calls `stopLogging` and updates the port status. Never bypass this by directly removing the tab from the store, or the log file handle leaks and the port status stays "connected".

## Commit conventions

```
type(scope): description

type: feat | fix | docs | style | refactor | perf | test | chore
scope: ui | backend | store | hooks | plans
```

## Key design reference

- `plans/04-data-flow.md` — 8 annotated data flow sequences
- `plans/08-defects.md` — active bug tracker
- `plans/09-release-workflow.md` — GitHub Actions release + updater workflow (tag-triggered build, RELEASE_NOTES.md unified notes, secrets, troubleshooting)

## Other gotchas

- `tauri.conf.json` has `"decorations": false` — custom TitleBar handles window controls via `@tauri-apps/api/window`
- `tsconfig.json` enforces `noUnusedLocals` and `noUnusedParameters` — unused vars are compile errors
- Serial data events carry `data: number[]` (bytes). Frontend decodes with `TextDecoder`. For HEX display, raw bytes are stored in `TerminalLine.rawData`.
- **RX 管线（2026-08-04 重构）**：`serial:data` 事件不再「一事件一行」，而是进 `getRxPipeline()`（每 webview 一个模块单例）：`RxLineAssembler` 字节级切行（CR/LF/跨事件 CRLF/4KB 强制发射）→ 每端口队列 → rAF tick 每端口一次 `appendTerminalLines`（高频下把 store 更新压到每帧一次）→ 250ms 静默 flush 未终结尾部（时间戳取最后事件时间）。`sendToPort` 在 TX 回显前 `flushNow` 排空队列保收发时序；断线走 `pipeline.disconnect`；编码切换前必须 `flushAndReset`（旧编码冲刷尾部，`TerminalFilterBar` 已接线）。**不得**在 hook/弹窗 cleanup 里 `dispose()` 单例。`StreamingDecoderCache` 已删除。
- **滚动锁定（2026-08-04 重设计）**：`scrollLocked` 只由显式意图写入——图钉按钮、`.terminal-jump-btn` 跳转按钮（滚动条两端：到顶解锁、到底锁定并点亮）、手势 settle（滚轮/滚动键/滚动条拖拽/中键，120ms 静默后按 atBottom 50px 容差判定）。`TerminalView` **没有 onScroll 处理器**——程序化滚动/挂载/测量滞后/内容增长产生的 scroll 事件不再碰锁定状态。搜索栏打开时抑制跟随，关闭时若锁定则滚回最新。
- ConfigModal's rule/command editors save to config.json via `storageService` (which wraps config-backed commands). Load on mount via `useEffect`. Rule state lives in `useRuleStore`.
- **config.json is the single source of truth for ALL settings entities** (2026-08 migration: the SQLite layer was removed entirely). The 8 entity types (`SendCommandSetEntry`, `HighlightRuleSetEntry`, `ProtocolTemplateEntry`, `TriggerRuleEntry`, `PortPresetEntry`, `PortToolConfigEntry`, `PortGroupEntry`, `PortMetaEntry`, all `#[serde(rename_all = "camelCase")]`) live as 8 `Vec` fields on `AppConfig` (`send_command_sets`, `highlight_rule_sets`, `protocol_templates`, `trigger_rules`, `port_presets`, `port_tool_configs`, `port_groups`, `port_meta`). `commands/storage.rs` CRUD is synchronous: lock `config_manager` → mutate the Vec via `get_config_mut()` → `save()` writes config.json atomically (tmp + rename + `.bak`). `port_groups` is a whole-list replace (`save_port_groups`, issue #2-3) — groups auto-save via a 500ms-debounced store subscription in `useAppInit`; there is no manual «save layout» button. `port_meta`（备注名/隐藏状态）同款整体替换（`save_port_meta`, issue #4-9）。The session snapshot was split out into a separate `session.json` (next to config.json) via `load_session_snapshot()`/`save_session_snapshot()`; `update_session_snapshot` writes session.json and does NOT trigger a config `.bak`. `LogManager` is initialized FROM `ConfigManager` in `AppState::new()`, and `set_config`/`reset_config` auto-sync log settings via `sync_log_manager_from_config()` — the frontend no longer syncs log settings (`syncLogSettingsToBackend` deleted). Log line prefix format is configurable (issue #3-4): `log_include_timestamp` / `log_include_direction` (`#[serde(default = "default_true")]` — old config.json without them reads back as `true`) control whether `PortLogWriter::write_line` emits `[timestamp] ` / `RX|TX ` prefixes; both off → bare data line. They lock at `create_writer` time (like encoding) and sync via `sync_log_manager_from_config`. The dead `background_image` config field was removed entirely (issue #3-5).
- ConfigModal pages (GeneralSettings, LogSettings, DisplaySettings, BackupSettings) use **per-field selectors** instead of subscribing to the whole config — this prevents unnecessary re-renders when unrelated config fields change.
- SIM:Loopback virtual port is available when `enable_simulation` is called (flask icon in sidebar toolbar)
- CSS is split across `src/styles/` (10 component CSS files + `base.css`). `src/styles.css` is just an `@import` entry point, not the main stylesheet.
- `src/utils/hexUtils.ts` provides `hexToString` and `stringToHex` for HEX send/parse.
- ConfigModal split into 10 files: `ConfigModal.tsx`, `RuleSetAccordion.tsx`, `pages/` (6 settings pages), `editors/` (HighlightRuleEditor, SendCmdEditor).
- OperationPanel split into section components: `OperationPanel.tsx`, `SendSection.tsx`, `ParamsSection.tsx` (the old `RulesSection.tsx` was removed — its command-set select + loop toggle merged into `SendSection`'s compact header, its highlight dropdown was a dead control). The compose-row file button doubles as a **cancel** button while a transfer is in progress (`serialService.cancelFileSend` → backend `cancel_file_send`); the success toast is driven by the `serial:file_progress` `done` event (`sent>=total>0`), so cancel / empty clear the bar silently.
- Serial backend hardening (see `src-tauri/src/commands/AGENTS.md`): `send_file` is cancellable via `cancel_file_send` (per-port token in `AppState.file_send_cancel`) and always emits a terminal `done:true`; `run_port_tool` joins the read thread **outside** the global serial lock and reads tool streams by bytes (`read_until` + `from_utf8_lossy`); `serial/mod.rs` exposes `build_tx_bytes` as the single source of truth for transmitted bytes (used by `send_data` and the TX log); `open_port` guards stale handles and the SIM read thread emits `disconnected` on exit.
- Serial unit tests live in `serial/mod.rs::tests` with **explicit** imports — never `use super::*`: the glob drags the `serialport` FFI into the test binary and the Windows `cargo test` harness then fails to load with `0xc0000139` (no embedded app manifest, unlike the app binary). Tests that touch `serialport` types / `SerialManager` are `#[cfg(not(target_os = "windows"))]` and run on Linux/macOS CI; the FFI-free hex-parser / `build_tx_bytes` tests run everywhere.
- MainDisplay split into: `MainDisplay.tsx`, `Pane.tsx`, `TabBar.tsx`, `TerminalView.tsx`, `TerminalFilterBar.tsx`, `ResizeHandle.tsx`.
- Sidebar split into: `Sidebar.tsx`, `AliasDialog.tsx`.
- Per-tab display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) lives in `useTerminalStore`, NOT in `useOperationStore`. Display controls (TerminalFilterBar, encoding select) must write via `useTerminalStore.getState().setTerminalConfig(portId, ...)` or `setTerminalEncoding(portId, encoding)`. Never reintroduce global display fields in `useOperationStore`.
- `src/utils/sendUtils.ts` provides `textToHexPreview` / `hexToTextPreview` / `sanitizeHexInput` / `computeByteCount` / `parseHexBytes` / `getLineEndingBytes` for HEX send/parse (pure, unit-tested).

## Pane tree (2026-07 refactor)

`panes: SplitPane[]` 平铺数组已替换为 `paneTree: PaneNode`（单根递归树）。

```ts
type PaneNode = LeafPane | BranchPane;
interface LeafPane   { id: string; type: 'leaf';   tabIds: string[];    size: number; }
interface BranchPane { id: string; type: 'branch'; direction: SplitDirection; children: PaneNode[]; size: number; }
```

- `focusedPaneId` 引用树中的**叶子 id**（不再是扁平数组索引）
- 树辅助函数全部在 `src/stores/useAppStore.ts` 顶层 export：`findLeafById`、`findLeafByTabId`、`findParentBranch`、`findBranchById`、`collectLeaves`、`countLeaves`、`pruneTree`（私有）
- `pruneTree` 会自动：① 删除非根空叶子 → ② 折叠只有 1 个子节点的分支为该子节点（继承 size）→ ③ 根分支为空时退化为空叶 `'main'`
- `MainDisplay.tsx` 用 `renderNode(node, parentBranch)` 递归渲染；分支 flex 容器内 ResizeHandle 调用 `resizeChildren(branchId, childIndex, deltaFraction)` action
- `useTabDragEnd` 用 `findLeafByTabId` / `findLeafById` 树遍历，不要再用 `state.panes.find(...)`
- 新 splitPane：找焦点叶子 → 在父分支子数组里替换为含 [源叶(0.5), 新叶(0.5)] 的新分支；焦点叶是根时整树替换
- 测试断言：`state.paneTree.type === 'branch'` 后 `as BranchPane` 再断 `children` — 严禁再用 `state.panes[0]` / `state.panes.length`

## i18n (2026-07 基础设施)

- `src/i18n.ts` 已就位 — i18next + react-i18next，扁平 dotted key（`keySeparator: false`），250 keys × zh-CN/en-US

  > 2026-07-21 起新增 `general.configPath` key（通用设置页显示配置文件路径），UI/UX overhaul 批次后达 250 keys。
- `main.tsx` 第 5 行 `import './i18n'` 副作用初始化
- `useAppStore.subscribe((state) => ...)` 监听 `config.language` 变化 → `i18n.changeLanguage`
- 组件用：`import { useTranslation } from 'react-i18next'` + `const { t } = useTranslation()` + `{t('namespace.key')}` / `t('namespace.key', { var: value })`
- **类组件**（如 `App.tsx` 的 `AppErrorBoundary`）不能使用 hook，直接 `import i18n from './i18n'` 后 `i18n.t('key')` —— 但不会随语言切换重渲染（仅在错误边界这种边缘场景可接受）
- 不翻译的字符串：协议词汇 `None/Even/Odd/Mark/Space`、`Xon/Xoff`、`RTS/CTS`；编码名 `ASCII/UTF-8/GBK/ISO-8859-1`；单位 `ms/px/MB`；首字母缩写 `SIM/VCP/HEX/DTR/RTS` —— 这些在 i18n.ts 中也无对应 key
- ✅ 全部 30 个组件 `.tsx` 文件已接入 `t()`（2026-07-21 完成）— 新增组件文本必须先查 `src/i18n.ts` 现有 key，不够用则在 zh-CN 和 en-US 两侧同时新增 key
- 切换语言时全部界面实时切换，无硬编码中文残留
