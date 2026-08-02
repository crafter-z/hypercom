# src/hooks/

11 hook files + 1 shared module + barrel `index.ts` — each hook owns its React↔Tauri lifecycle.

## File structure

| File | Exports | Call site | Lifecycle |
|------|---------|-----------|-----------|
| `disconnectTracking.ts` | `userClosingPortIds`, `lostPortIds`, `isUserClosingPort()`, `isPortLost()` | shared by useSerialConnection + useSerialReceive | module-level Sets for session-aware disconnect tracking |
| `useSerialPorts.ts` | `useSerialPorts(pollMs=3000)`, `mapPortInfo()`, `mergePorts()` | Sidebar | polling; `mapPortInfo`/`mergePorts` also used by useSimulation |
| `useSerialConnection.ts` | `useSerialConnection()` | Sidebar / TabBar | open/close; routes through `closePort()`; owns reconnect backoff loop |
| `usePinStatesSubscriber.ts` | `usePinStatesSubscriber()` | `App.tsx` **exactly once** | `serial:pin_states` event listener |
| `useSerialReceive.ts` | `useSerialReceive()` | `App.tsx` **exactly once** | owns `serial:data` event listener + status handler (writes `lostPortIds` for DisconnectBanner) |
| `useSerialSend.ts` | `useSerialSend()`, `sendToPort()` | OperationPanel (hook); `usePopoutBridge` (module fn) | action; module-level `sendToPort` owns the real send (backend call + TX echo + traffic stats + in-memory per-port history `Map<portId, SendHistoryEntry[]>`, cap 50, no SQLite); the hook is a thin wrapper mirroring history into state for ↑/↓ recall |
| `usePopoutBridge.ts` | `usePopoutBridge()` | `App.tsx` **exactly once** | pop-out intent bus: listens `popout:send-command` (→ `sendToPort(activeTabId)`) / `popout:open-config` (→ ConfigModal page) / `popout:request-sync` (→ replay `active-tab:changed`); subscribes `useRuleStore.sendCommandSets` + `useAppStore.activeTabId` → emits `command-sets:changed` / `active-tab:changed` refresh signals |
| `useConfigPersistence.ts` | `useConfigPersistence()` | `App.tsx` | load + save config |
| `useSystemStatus.ts` | `useSystemStatus(pollMs=5000)` | StatusBar | polling |
| `useAppInit.ts` | `useAppInit()` | `App.tsx` | one-shot bootstrap; owns `isValidPaneNode`; loads settings entities (command/highlight/protocol/trigger/preset/tool) from `config` into `useRuleStore`; session restore via `configService.getSessionSnapshot()` |
| `useSimulation.ts` | `useSimulation()` | Sidebar toolbar | SIM:Loopback virtual port toggle; imports `mapPortInfo`/`mergePorts` from useSerialPorts |
| `useToolOutput.ts` | `useToolOutput()` | `App.tsx` **exactly once** | `tool:output` / `tool:exit` event listeners; writes TOOL lines to terminal, updates `toolRunning` |
| `index.ts` | barrel re-export | all consumers | import from `'../../hooks'` or `'./hooks'` |

## Conventions (root covers lifecycle split rationale)

- Both `useSerialReceive` and `useSerialSend` write lines via `useTerminalStore.getState().appendTerminalLine` — NOT via hook selector. Prevents re-rendering the owner every frame.
- `useSerialReceive` MUST be called exactly once in `App.tsx`. Calling it twice double-registers the `serial:data` listener → every line gets appended twice.
- `useSerialReceive`'s status handler is the ONLY place that writes to `lostPortIds` (in `disconnectTracking.ts`). A port is marked "lost" only on a connected→disconnected transition within this session; successful `openPort`/`closePort`/reconnect clear it. `isPortLost(portId)` is exported for `DisconnectBanner.tsx` which uses the pure helper `filterLostTabIds(tabs, isPortLost)` — never probe port state from outside the hook.
- `useSerialSend` maintains in-memory per-port send history (`Map<portId, SendHistoryEntry[]>`, cap 50, dedup on content+format). `SendHistoryEntry` lives in `src/types/index.ts`. No SQLite persistence; the old `sendHistoryService` / `SendHistoryItem` were removed. Backend Rust commands survive but are not invoked from the frontend.
- `useSerialConnection.closePort()` is the only sanctioned close path: triggers `stopLogging` and updates port status. Bypassing leaks log file handles + leaves status "connected" stuck.
- `useSerialPorts(3000)` uses `mergePorts()` on every refresh — `mapPortInfo()` always overwrites status to `'disconnected'`; merge preserves alias / group / connection state / baud match.
- Polling hooks accept `pollIntervalMs` as a parameter intentionally — do not hardcode inside the hook.
- `useAppInit` runs once on mount: registers backend command handlers if needed, pulls initial config via `useConfigPersistence`. No longer syncs sendOnEnter (lives only in config). Loads settings entities directly from `config` (`cfg.sendCommandSets` etc., wire format matches store format via camelCase) into `useRuleStore` — including `triggerRules`; no startup `storageService.loadCommandSets()` calls. Session restore uses `configService.getSessionSnapshot()`.
- Pop-out windows are SEPARATE webviews with their own store instances — they never share mutable frontend state with the main window, only intents/signals (`popoutEventService` in `src/services/tauri.ts`). Sending from a pop-out MUST go through `popout:send-command` → main's `sendToPort`; a direct `serialService.sendSerialData` call from the pop-out would skip the TX echo / traffic stats / send history (the backend emits no TX event).
- Log settings are synced to LogManager internally by the backend `set_config`/`reset_config` commands (`sync_log_manager_from_config()`); the frontend no longer syncs them (`syncLogSettingsToBackend` deleted).
- Inside hook callbacks/effects, prefer `use{App,Operation,Terminal,Rule}Store.getState()` over selector-bound locals when the value must be live.

## Anti-patterns

- Calling `useSerialReceive` more than once per app lifetime.
- Registering an ad-hoc `listen('serial:data', …)` outside `useSerialReceive`.
- Subscribing the whole `useTerminalStore` from a component that owns a hook — same re-render pathology as in any component.
- Bypassing `closePort()` to remove a tab — corrupts log lifecycle + port status.
- Mutating `lostPortIds` from anywhere except the status handler inside `useSerialReceive`. The set encapsulates session-aware disconnect tracking; external mutation breaks `DisconnectBanner` correctness.
- Re-introducing global display fields (`displayFormat`, `encoding`, `scrollLocked`, `showTimestamp`, `loopInterval`) in `useOperationStore` — those live per-tab in `useTerminalStore`.
