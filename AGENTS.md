# PROJECT KNOWLEDGE BASE — HyperCom

**Generated:** 2026-07-28 · **Stack:** Tauri v2 (2.11.x) + React 18 + Rust (tokio + sqlx + serialport)

## OVERVIEW

HyperCom — modern serial-port debug tool replacing SSCOM/SuperCom. Rust owns I/O; React owns UI. State in 4 Zustand stores; 10 hooks in individual files under `src/hooks/` own the Tauri bridge. Backend commands split into 7 domain files + `CommandError` enum. `paneTree: PaneNode` (recursive) replaced the flat `panes` array on 2026-07. Per-tab display state (scrollLocked/displayFormat/encoding/showTimestamp) lives in `useTerminalStore`, NOT in `useOperationStore`. Decorations disabled — custom TitleBar drives window controls. Cross-platform power management (Win32/macOS/Linux). Conditional trigger engine (pattern match → auto-respond/alert/bookmark).

## STRUCTURE

```
hypercom/
├── src/                          # React frontend
│   ├── main.tsx, App.tsx         # entrypoints (App.tsx owns AppInit + SerialReceive + global right-click disable)
│   ├── i18n.ts                   # i18next + react-i18next, 266 keys × zh-CN/en-US
│   ├── services/tauri.ts         # invoke wrapper layer (6 service modules)
│   ├── hooks/                    # 10 hooks in individual files + barrel index.ts + disconnectTracking.ts
│   ├── stores/                   # 4 Zustand + Immer stores (no god store)
│   │   ├── useAppStore.ts        # tabs / ports / paneTree / config / groups + tree helpers
│   │   ├── useOperationStore.ts  # serial params + send (NO `op` prefix; NO display state fields)
│   │   ├── useTerminalStore.ts   # terminal buffer + appendTerminalLine + setTerminalEncoding
│   │   └── useRuleStore.ts       # highlight + send-command + trigger rule sets + CRUD
│   ├── utils/                    # highlightEngine / protocolParser / triggerEngine / hexUtils + their tests
│   ├── types/index.ts            # shared TS types
│   └── components/               # MainDisplay / ConfigModal / OperationPanel / Sidebar / TitleBar / StatusBar / shared
├── src-tauri/src/                # Rust backend
│   ├── main.rs, lib.rs           # entrypoint + AppState + command registration + setup
│   ├── system.rs                 # cross-platform power mgmt (Win32 FFI / macOS caffeinate / Linux systemd-inhibit)
│   ├── commands/                 # 7 domain files + mod.rs (CommandError enum + re-exports)
│   ├── serial/mod.rs             # serialport + SIM:Loopback virtual port (505 lines)
│   ├── logger/mod.rs             # BufWriter + rotation + path templating (501 lines)
│   ├── storage/mod.rs            # SQLite via sqlx (8 tables), WAL+FK pragmas
│   └── config/mod.rs             # JSON config + versioning + validation + path + backup (475 lines)
└── plans/                        # design docs (see "Key design reference" below)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add frontend state field | `src/stores/use{App,Operation,Terminal,Rule}Store.ts` | pick correct store only; god store is deprecated |
| Add Tauri command | `src-tauri/src/commands/<domain>.rs` + register in `lib.rs` | return `Result<T, CommandError>`, NOT `String` |
| Cross `.await` lock | extract + clone + drop the `MutexGuard` first | see pattern in `commands/log.rs` |
| Add serial hook | `src/hooks/<hookName>.ts` + export from `index.ts` | follow 10-hook lifecycle; do not revive `useSerialData`-style |
| Split pane recursively | `useAppStore.splitPane` action via tree helpers | NO flat `state.panes` anywhere |
| Pane tree traversal | module-top exports in `useAppStore.ts` (`findLeafById` … `countLeaves`) | do not hand-roll tree walks |
| Highlight engine | `src/utils/highlightEngine.ts` + tests | state in `useRuleStore`, persisted via `storageService` |
| ConfigModal page edit | `src/components/ConfigModal/pages/*.tsx` | rule state in `useRuleStore`; SQLite via `storageService` |
| Cyclic send | `src/components/OperationPanel/hooks/useCyclicSend.ts` | reads `useRuleStore.sendCommandSets` via `getState`; timing via per-command `delay` + set `loopDelay` only (no global interval) |
| Cross-platform power | `src-tauri/src/system.rs` | Win32 `SetThreadExecutionState` / macOS `caffeinate` / Linux `systemd-inhibit` |
| Multi-encoding | backend `encoding_rs::GBK`, frontend `TextDecoder` + `setTerminalEncoding` | serial_data carries UTF-8 bytes; live re-decode on switch |
| DisconnectBanner | `src/components/StatusBar/DisconnectBanner.tsx` + `hooks/disconnectTracking.ts` `isPortLost`/`filterLostTabIds` | suppresses startup false alarm for session-restored tabs |
| Conditional triggers | `src/utils/triggerEngine.ts` + `useRuleStore.triggerRules` + `ConfigModal/pages/TriggerSettings.tsx` | pattern match (contains/exact/regex/hex) → alert/auto-respond/bookmark; SQLite persisted |
| Add translation | `src/i18n.ts` | add key under `zh-CN` and `en-US`; don't translate protocol acronyms (None/Even/Xon/RTS/GBK/...) |
| Loopback virtual port | `useSimulation` hook + `commands/simulation.rs` | flask icon in sidebar toolbar |
| External tool (flasher) | `commands/serial.rs` `run_port_tool`/`kill_port_tool` + `useToolOutput` hook + `ToolSettings` page | close→spawn→stream→reopen 闭环；`{port}` 模板替换；配置在设置弹窗「外部工具」页；触发在侧边栏右键菜单 |
| Resize operation panel | `src/components/shared/OperationPanelResizeHandle.tsx` + `ui.operationPanelHeight` | vertical drag handle between MainDisplay and OperationPanel; default 200px, clamp [160,600] |
| First-run database creation | `storage/mod.rs` `create_pool()` `.create_if_missing(true)` | sqlx won't create a missing `data.db` without it; pool built synchronously in `lib.rs` setup (`block_on`) |
| Config versioning / migration | `config/mod.rs` `migrate()` + `config_version` field | forward-compatible, additive |
| Config path customization | CLI `--config` / `HYPERCOM_CONFIG` env / portable mode | resolution order in `ConfigManager::new` |
| Config validation | `config/mod.rs` `validate_and_clamp()` | runs on `set_config` to enforce bounds |
| Config backup / recovery | `config/mod.rs` `save()` writes `.bak` / `new()` falls back to `.bak` | corrupt JSON auto-recovered |
| Session snapshot update | `update_session_snapshot` dedicated command | avoids full config save race |

## CODE MAP

Frontend (manual review; TypeScript LSP unavailable in this environment):

| Symbol | File | Type | Role |
|--------|------|------|------|
| `useAppStore` | `src/stores/useAppStore.ts:266` | Zustand store | tabs / ports / `paneTree` / config / groups |
| `useOperationStore` | `src/stores/useOperationStore.ts:29` | Zustand store | serial params + send (NO `op` prefix; NO display state) |
| `useTerminalStore` | `src/stores/useTerminalStore.ts:22` | Zustand store | line buffer + `appendTerminalLine` + `setTerminalEncoding` (re-decode on switch) |
| `useRuleStore` | `src/stores/useRuleStore.ts:32` | Zustand store | highlight + send-command rule sets + CRUD |
| `findLeafById` / `findLeafByTabId` / `findParentBranch` / `findBranchById` / `collectLeaves` / `countLeaves` | `src/stores/useAppStore.ts:25-85` | pure fns | recursive `PaneNode` tree traversal |
| 10 hooks: `useSerialPorts` / `useSerialConnection` / `usePinStatesSubscriber` / `useSerialReceive` / `useSerialSend` / `useConfigPersistence` / `useSystemStatus` / `useAppInit` / `useSimulation` / `useToolOutput` | `src/hooks/*.ts` + barrel `index.ts` | hooks | Tauri bridge — see `src/hooks/AGENTS.md` |
| `evaluateTriggers` | `src/utils/triggerEngine.ts` | pure fn | conditional trigger matching engine (contains/exact/regex/hex) |
| `tauri` service modules | `src/services/tauri.ts` | service | wrapped `invoke` calls (6 modules) |

Backend:

| Symbol | File | Type | Role |
|--------|------|------|------|
| `CommandError` | `src-tauri/src/commands/mod.rs:20` | enum (thiserror) | Serial/Config/Log/Storage/System/Lock/Io/Other; manual `serde::Serialize` |
| All Tauri commands (7 domain files) | `src-tauri/src/commands/*.rs` | Tauri cmd | see `src-tauri/src/commands/AGENTS.md` |
| `StorageManager` + row structs (`SendCommandRow` … `TriggerRuleRow`) | `src-tauri/src/storage/mod.rs` | struct / models | SQLite pool (8 tables, WAL+FK); see `src-tauri/src/storage/AGENTS.md` |
| `ConfigManager` + `AppConfig` | `src-tauri/src/config/mod.rs` | struct | versioning + validation + path resolution + backup/recovery (475 lines) |
| `AppState` | `src-tauri/src/lib.rs` | struct | holds `serial_manager` / `storage_manager` / `logger` / `config_manager` behind `std::sync::Mutex` |
| `win32_power` / `macos_power` / `linux_power` | `src-tauri/src/system.rs` | mod | cross-platform `prevent_sleep` / `prevent_screen_off` |

Subdir guides: [`src/stores/AGENTS.md`](src/stores/AGENTS.md) · [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) · [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) · [`src-tauri/src/storage/AGENTS.md`](src-tauri/src/storage/AGENTS.md) · [`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md) · [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md) · [`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md)

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

**Note**: `sendOnEnter` and `quickSendSlots` do NOT live here. They are in `useAppStore.config` only. SendSection reads them via `useAppStore(s => s.config.sendOnEnter)`. Display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) and `loopInterval` are also NOT here — they live per-tab in `useTerminalStore`.

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
let pool = {
    let mgr = state.storage_manager.lock().unwrap();
    mgr.pool().unwrap().clone()  // extract & clone, then drop MutexGuard
};
some_async_fn(&pool).await;
```

## Database init: synchronous, create-if-missing (2026-07 fix)

The SQLite pool is created **synchronously** in `lib.rs` `setup` via `tauri::async_runtime::block_on(create_pool + init_schema_on_pool)`, then injected with `set_pool`. Do **not** spawn it async — frontend `useAppInit` loads command/highlight/protocol sets and `ParamsSection` loads port presets immediately on mount; an async spawn races them, they fail with `Database not initialized`, and presets never retry (the preset dropdown stays permanently empty). `create_pool` uses `SqliteConnectOptions::create_if_missing(true)` because sqlx will not create a missing `data.db` by default (first run would otherwise fail to open the DB forever).

## Port list polling: preserve state with mergePorts

`useSerialPorts(3000)` polls every 3s. `mapPortInfo()` always sets `status: 'disconnected'`. Use `mergePorts()` to preserve existing port state (status, alias, group, baud rate, etc.) when refreshing the list.

## Hooks: useSerialReceive vs useSerialSend

The old `useSerialData` hook was split into two hooks with different lifecycles:

- **`useSerialReceive()`** — Owns the serial data event listener lifecycle. Called **once** in `App.tsx`. Listens to `serial_data` events, decodes bytes, and calls `useTerminalStore.getState().appendTerminalLine()`. Never call this more than once.
- **`useSerialSend()`** — Returns a send action. Called in `OperationPanel`. Writes to the serial port and appends the sent line to the terminal via `useTerminalStore.getState().appendTerminalLine()`.

Both hooks write to the terminal store through `getState()` to avoid re-rendering the hook owner on every line.

The full hook set in `src/hooks/` (10 hooks, individual files):

| Hook | Purpose | Called in |
|------|---------|-----------|
| `useSerialPorts` | Polls port list every 3s | Sidebar |
| `useSerialConnection` | open/close port, routes through `closePort()` | Sidebar / TabBar |
| `usePinStatesSubscriber` | `serial:pin_states` event listener (DTR/RTS/CTS/DSR/RLSD/RI) | App.tsx (once) |
| `useSerialReceive` | `serial_data` event listener | App.tsx (once) |
| `useSerialSend` | Send action | OperationPanel |
| `useConfigPersistence` | Load/save config to backend | App.tsx |
| `useSystemStatus` | Polls CPU/memory every 5s | StatusBar |
| `useAppInit` | One-shot app bootstrap | App.tsx |
| `useSimulation` | Toggle SIM:Loopback virtual port | Sidebar toolbar |
| `useToolOutput` | `tool:output` / `tool:exit` event listeners | App.tsx (once) |

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
    #[error("Storage error: {0}")]
    Storage(String),
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

Commands are split into 7 domain files under `src-tauri/src/commands/`:

| File | Domain |
|------|--------|
| `serial.rs` | open_port, close_port, send_data, get_port_status |
| `simulation.rs` | enable_simulation, disable_simulation |
| `config.rs` | get_config, set_config, reset_config, update_session_snapshot, get_config_path |
| `log.rs` | start_logging, stop_logging, save_log_as, export_terminal_log, get_log_files, set_log_split_size, set_log_split_enabled, set_log_filename_format, set_log_auto_save, set_log_encoding, open_path, open_log_directory |
| `storage.rs` | highlight rule sets + send command sets CRUD |
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

## Other gotchas

- `tauri.conf.json` has `"decorations": false` — custom TitleBar handles window controls via `@tauri-apps/api/window`
- `tsconfig.json` enforces `noUnusedLocals` and `noUnusedParameters` — unused vars are compile errors
- Serial data events carry `data: number[]` (bytes). Frontend decodes with `TextDecoder`. For HEX display, raw bytes are stored in `TerminalLine.rawData`.
- ConfigModal's rule/command editors save to SQLite via `storageService`. Load on mount via `useEffect`. Rule state lives in `useRuleStore`.
- ConfigModal pages (GeneralSettings, LogSettings, DisplaySettings, BackupSettings) use **per-field selectors** instead of subscribing to the whole config — this prevents unnecessary re-renders when unrelated config fields change.
- SIM:Loopback virtual port is available when `enable_simulation` is called (flask icon in sidebar toolbar)
- CSS is split across `src/styles/` (10 component CSS files + `base.css`). `src/styles.css` is just an `@import` entry point, not the main stylesheet.
- `src/utils/hexUtils.ts` provides `hexToString` and `stringToHex` for HEX send/parse.
- ConfigModal split into 10 files: `ConfigModal.tsx`, `RuleSetAccordion.tsx`, `pages/` (6 settings pages), `editors/` (HighlightRuleEditor, SendCmdEditor).
- OperationPanel split into section components: `OperationPanel.tsx`, `SendSection.tsx`, `ParamsSection.tsx`, `RulesSection.tsx`.
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
