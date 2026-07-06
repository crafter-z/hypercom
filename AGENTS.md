# AGENTS.md

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

### useOperationStore — baudRate, dataBits, parity, stopBits, handshake, dtr, rts, sendInput, displayFormat, encoding, ...

Operation fields have **NO `op` prefix**. They were renamed from `opBaudRate` to `baudRate`, `opDataBits` to `dataBits`, etc.

```tsx
const baudRate = useOperationStore(s => s.baudRate);
const sendInput = useOperationStore(s => s.sendInput);
const setOpState = useOperationStore(s => s.setOpState);
```

### useTerminalStore — terminals, appendTerminalLine, clearTerminal, setTerminalConfig, ensureTerminal

Hooks that need to write terminal lines without subscribing should use `getState()`:

```tsx
// Inside a hook callback (no re-render needed)
useTerminalStore.getState().appendTerminalLine(portId, line);

// In a component that renders terminal content
const terminals = useTerminalStore(s => s.terminals);
```

### useRuleStore — highlightRuleSets, sendCommandSets + CRUD

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

## Port list polling: preserve state with mergePorts

`useSerialPorts(3000)` polls every 3s. `mapPortInfo()` always sets `status: 'disconnected'`. Use `mergePorts()` to preserve existing port state (status, alias, group, baud rate, etc.) when refreshing the list.

## Hooks: useSerialReceive vs useSerialSend

The old `useSerialData` hook was split into two hooks with different lifecycles:

- **`useSerialReceive()`** — Owns the serial data event listener lifecycle. Called **once** in `App.tsx`. Listens to `serial_data` events, decodes bytes, and calls `useTerminalStore.getState().appendTerminalLine()`. Never call this more than once.
- **`useSerialSend()`** — Returns a send action. Called in `OperationPanel`. Writes to the serial port and appends the sent line to the terminal via `useTerminalStore.getState().appendTerminalLine()`.

Both hooks write to the terminal store through `getState()` to avoid re-rendering the hook owner on every line.

The full hook set in `src/hooks/useTauri.ts` (8 hooks):

| Hook | Purpose | Called in |
|------|---------|-----------|
| `useSerialPorts` | Polls port list every 3s | Sidebar |
| `useSerialConnection` | open/close port, routes through `closePort()` | Sidebar / TabBar |
| `useSerialReceive` | `serial_data` event listener | App.tsx (once) |
| `useSerialSend` | Send action | OperationPanel |
| `useConfigPersistence` | Load/save config to backend | App.tsx |
| `useSystemStatus` | Polls CPU/memory every 5s | StatusBar |
| `useAppInit` | One-shot app bootstrap | App.tsx |
| `useSimulation` | Toggle SIM:Loopback virtual port | Sidebar toolbar |

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

Commands are split into 6 domain files under `src-tauri/src/commands/`:

| File | Domain |
|------|--------|
| `serial.rs` | open_port, close_port, send_data, get_port_status |
| `simulation.rs` | enable_simulation, disable_simulation |
| `config.rs` | get_config, save_config, reset_config |
| `log.rs` | start_logging, stop_logging, save_as, open_file, open_directory |
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

## Key files to read first

- `plans/02-architecture.md` — full frontend layout with flexbox chain
- `plans/03-backend.md` — Rust modules, commands, DB schema, events
- `plans/04-data-flow.md` — 8 annotated data flow sequences
- `plans/05-components.md` — component tree, props, type reference
- `plans/06-status.md` — per-file/per-feature completion
- `plans/07-roadmap.md` — prioritized remaining tasks
- `plans/08-defects.md` — active bug tracker
- `plans/09-reference.md` — file index, deps, naming conventions

> Note: some plan files predate the store/hook/component split refactor. Cross-check with the actual source in `src/stores/`, `src/hooks/useTauri.ts`, and `src/components/` when the docs disagree with the code.

## Other gotchas

- `tauri.conf.json` has `"decorations": false` — custom TitleBar handles window controls via `@tauri-apps/api/window`
- `tsconfig.json` enforces `noUnusedLocals` and `noUnusedParameters` — unused vars are compile errors
- Serial data events carry `data: number[]` (bytes). Frontend decodes with `TextDecoder`. For HEX display, raw bytes are stored in `TerminalLine.rawData`.
- ConfigModal's rule/command editors save to SQLite via `storageService`. Load on mount via `useEffect`. Rule state lives in `useRuleStore`.
- SIM:Loopback virtual port is available when `enable_simulation` is called (flask icon in sidebar toolbar)
- CSS is split across `src/styles/` (10 component CSS files + `base.css`). `src/styles.css` is just an `@import` entry point, not the main stylesheet.
- `src/utils/hexUtils.ts` provides `hexToString` and `stringToHex` for HEX send/parse.
- ConfigModal split into 10 files: `ConfigModal.tsx`, `RuleSetAccordion.tsx`, `pages/` (6 settings pages), `editors/` (HighlightRuleEditor, SendCmdEditor).
- OperationPanel split into section components: `OperationPanel.tsx`, `SendSection.tsx`, `ParamsSection.tsx`, `RulesSection.tsx`.
- MainDisplay split into: `MainDisplay.tsx`, `Pane.tsx`, `TabBar.tsx`, `TerminalView.tsx`, `ResizeHandle.tsx`.
- Sidebar split into: `Sidebar.tsx`, `AliasDialog.tsx`.

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

- `src/i18n.ts` 已就位 — i18next + react-i18next，扁平 dotted key（`keySeparator: false`），218 keys × zh-CN/en-US
- `main.tsx` 第 5 行 `import './i18n'` 副作用初始化
- `useAppStore.subscribe((state) => ...)` 监听 `config.language` 变化 → `i18n.changeLanguage`
- 组件用：`import { useTranslation } from 'react-i18next'` + `const { t } = useTranslation()` + `{t('namespace.key')}` / `t('namespace.key', { var: value })`
- **类组件**（如 `App.tsx` 的 `AppErrorBoundary`）不能使用 hook，直接 `import i18n from './i18n'` 后 `i18n.t('key')` —— 但不会随语言切换重渲染（仅在错误边界这种边缘场景可接受）
- 不翻译的字符串：协议词汇 `None/Even/Odd/Mark/Space`、`Xon/Xoff`、`RTS/CTS`；编码名 `ASCII/UTF-8/GBK/ISO-8859-1`；单位 `ms/px/MB`；首字母缩写 `SIM/VCP/HEX/DTR/RTS` —— 这些在 i18n.ts 中也无对应 key
- ⚠️ 7 个文件已替换为 `t()`；15 个文件保留中文硬编码（暂未完成 i18n 接入，不影响编译运行）— 新增组件如需文本，先查 `src/i18n.ts` 现有 key 是否够用
- 切换语言时已替换的文件实时切换，未替换的继续显示中文
