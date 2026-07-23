# src/hooks/

Single file: `useTauri.ts` (871 lines) — 9 hooks that own the React↔Tauri lifecycle.

## Where to look

| Hook (line) | Call site | Lifecycle |
|-------------|-----------|-----------|
| `useSerialPorts(pollMs=3000)` (115) | Sidebar | polling |
| `useSerialConnection()` (142) | Sidebar / TabBar | open/close; routes through `closePort()` |
| `useSerialReceive()` (212) | `App.tsx` **exactly once** | owns `serial_data` event listener |
| `useSerialSend()` (327) | OperationPanel | action |
| `useConfigPersistence()` (369) | `App.tsx` | load + save |
| `useSystemStatus(pollMs=5000)` (410) | StatusBar | polling |
| `useAppInit()` (438) | `App.tsx` | one-shot bootstrap |
| `useSimulation()` (474) | Sidebar toolbar | SIM:Loopback virtual port toggle |

## Conventions (root covers lifecycle split rationale)

- Both `useSerialReceive` and `useSerialSend` write lines via `useTerminalStore.getState().appendTerminalLine` — NOT via hook selector. Prevents re-rendering the owner every frame.
- `useSerialReceive` MUST be called exactly once in `App.tsx`. Calling it twice double-registers the `serial_data` listener → every line gets appended twice.
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
- Splitting `useTauri.ts` into per-hook files. The 8-hook lifecycle is intentionally co-located; extraction was deferred on purpose.