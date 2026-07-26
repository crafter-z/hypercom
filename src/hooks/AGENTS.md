# src/hooks/

Single file: `useTauri.ts` (959 lines) — 9 hooks that own the React↔Tauri lifecycle.

## Where to look

| Hook (line) | Call site | Lifecycle |
|-------------|-----------|-----------|
| `useSerialPorts(pollMs=3000)` (248) | Sidebar | polling |
| `useSerialConnection()` (279) | Sidebar / TabBar | open/close; routes through `closePort()` |
| `usePinStatesSubscriber()` (410) | `App.tsx` **exactly once** | `serial:pin_states` event listener |
| `useSerialReceive()` (447) | `App.tsx` **exactly once** | owns `serial_data` event listener + status handler (manages `lostPortIds` for DisconnectBanner) |
| `useSerialSend()` (646) | OperationPanel | action; in-memory per-port send history (`Map<portId, SendHistoryEntry[]>`, cap 50, no SQLite) |
| `useConfigPersistence()` (770) | `App.tsx` | load + save |
| `useSystemStatus(pollMs=5000)` (811) | StatusBar | polling |
| `useAppInit()` (856) | `App.tsx` | one-shot bootstrap |
| `useSimulation()` (935) | Sidebar toolbar | SIM:Loopback virtual port toggle |
| `useToolOutput()` (965) | `App.tsx` **exactly once** | `tool:output` / `tool:exit` event listeners; writes TOOL lines to terminal, updates `toolRunning` |

## Conventions (root covers lifecycle split rationale)

- Both `useSerialReceive` and `useSerialSend` write lines via `useTerminalStore.getState().appendTerminalLine` — NOT via hook selector. Prevents re-rendering the owner every frame.
- `useSerialReceive` MUST be called exactly once in `App.tsx`. Calling it twice double-registers the `serial_data` listener → every line gets appended twice.
- `useSerialReceive`'s status handler is the ONLY place that writes to `lostPortIds` (module-level `Set<string>`). A port is marked "lost" only on a connected→disconnected transition within this session; successful `openPort`/`closePort`/reconnect clear it. `isPortLost(portId)` is exported for `DisconnectBanner.tsx` which uses the pure helper `filterLostTabIds(tabs, isPortLost)` — never probe port state from outside the hook.
- `useSerialSend` maintains in-memory per-port send history (`Map<portId, SendHistoryEntry[]>`, cap 50, dedup on content+format). `SendHistoryEntry` lives in `src/types/index.ts`. No SQLite persistence; the old `sendHistoryService` / `SendHistoryItem` were removed. Backend Rust commands survive but are not invoked from the frontend.
- `useSerialConnection.closePort()` is the only sanctioned close path: triggers `stopLogging` and updates port status. Bypassing leaks log file handles + leaves status "connected" stuck.
- `useSerialPorts(3000)` uses `mergePorts()` on every refresh — `mapPortInfo()` always overwrites status to `'disconnected'`; merge preserves alias / group / connection state / baud match.
- Polling hooks accept `pollIntervalMs` as a parameter intentionally — do not hardcode inside the hook.
- `useAppInit` runs once on mount: registers backend command handlers if needed, pulls initial config via `useConfigPersistence`. No longer syncs sendOnEnter/quickSendSlots (those live only in config).
- `useConfigPersistence` syncs all 6 log settings to backend via `syncLogSettingsToBackend()` (not just autoSave).
- Inside hook callbacks/effects, prefer `use{App,Operation,Terminal,Rule}Store.getState()` over selector-bound locals when the value must be live.

## Anti-patterns

- Calling `useSerialReceive` more than once per app lifetime.
- Registering an ad-hoc `listen('serial_data', …)` outside `useSerialReceive`.
- Subscribing the whole `useTerminalStore` from a component that owns a hook — same re-render pathology as in any component.
- Bypassing `closePort()` to remove a tab — corrupts log lifecycle + port status.
- Mutating `lostPortIds` from anywhere except the status handler inside `useSerialReceive`. The set encapsulates session-aware disconnect tracking; external mutation breaks `DisconnectBanner` correctness.
- Re-introducing global display fields (`displayFormat`, `encoding`, `scrollLocked`, `showTimestamp`, `loopInterval`) in `useOperationStore` — those live per-tab in `useTerminalStore`.
- Splitting `useTauri.ts` into per-hook files. The 9-hook lifecycle is intentionally co-located; extraction was deferred on purpose.