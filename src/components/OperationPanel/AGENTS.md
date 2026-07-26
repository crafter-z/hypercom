# src/components/OperationPanel/

Send area + serial params + rule quick access. Split into 4 view sections and the `useCyclicSend` hook. `OperationPanel.tsx` owns the top strip (connect / clear screen / log replay / log save-open / font-size slider). The panel height is drag-resizable: `OperationPanelResizeHandle` (in `src/components/shared/`, mounted between `MainDisplay` and `OperationPanel` in `App.tsx`) writes `ui.operationPanelHeight`, which `OperationPanel.tsx` applies as an inline height (the collapsed state still pins to the header via CSS).

## Files

| File | Lines | Role |
|------|------:|-----|
| `OperationPanel.tsx` | 230 | container + top strip: connect / clear screen / replay controls (targets active tab) / log save-as, open-file, open-dir / font-size slider; binds active rule/command set; mounts section components |
| `SendSection.tsx` | 303 | send textarea + HEX toggle (bidirectional content conversion via `textToHexPreview`/`hexToTextPreview`) + HEX input sanitization (`sanitizeHexInput`) + line terminator selector + file-send button; Enter semantics governed by `config.sendOnEnter` setting (plain Enter sends by default; Shift+Enter / Ctrl+Enter always insert newline); no connect / clear-screen / history-clear buttons (moved to strip or removed) |
| `ParamsSection.tsx` | 130 | baudRate / dataBits / parity / stopBits / handshake / DTR / RTS; preset apply dropdown only (preset management moved to `ConfigModal/pages/GeneralSettings.tsx`) |
| `RulesSection.tsx` | 119 | active highlight rule-set + active command-set quick toggles; start/stop cyclic + repeat count; timing from per-command `delay` + command-set `loopDelay` only (no separate interval input) |
| `hooks/useCyclicSend.ts` | 154 | cyclic send loop; reads `useRuleStore.sendCommandSets` via `getState`; timing driven solely by per-command `delay` + command-set `loopDelay`; error retry fixed at 500ms |

## Conventions (root covers selector discipline)

- Operation fields live on `useOperationStore` with NO `op` prefix — selectors look like `s => s.baudRate`, not `s => s.opBaudRate`.
- `useCyclicSend` reads `useRuleStore.getState().sendCommandSets` (NOT via a subscribing selector) — entry mutations would re-mount the controller and reset progress.
- HEX parse/convert helpers live in `src/utils/sendUtils.ts` (`textToHexPreview`, `hexToTextPreview`, `sanitizeHexInput`, `computeByteCount`, `parseHexBytes`). `src/utils/hexUtils.ts` still provides the low-level `stringToHex` / `hexToString`.
- HEX toggle on the checkbox converts content both ways: string→hex on check (via `textToHexPreview`), hex→string on uncheck (via `hexToTextPreview`). HEX-mode input is sanitized.
- Enter semantics: plain Enter sends by default; Shift+Enter and Ctrl+Enter always insert newline. When `config.sendOnEnter` is off (settings toggle), Enter also inserts newline and sending is only via the Send button. The "Enter behavior toggle" button was removed; it's now a setting checkbox in GeneralSettings.
- Send history: in-memory per-port (cap 50, `Map<portId, SendHistoryEntry[]>` in `useSerialSend`); "clear send history" button removed. ↑/↓ recall still works.
- Log replay (`useLogReplay` in `src/components/MainDisplay/hooks/useLogReplay.ts`) is driven from OperationPanel's strip; targets the active tab.
- Timing for cyclic send is single-sourced from the command set's per-command `delay` and `loopDelay`. No global interval field exists.
- The 4 section components are defined at module level — never inline them in `OperationPanel.tsx`'s body.
- Panel height lives in `ui.operationPanelHeight` (default 200, clamped [160, 600] by `OperationPanelResizeHandle`) and is applied inline in `OperationPanel.tsx`. The old static `--operation-panel-height` CSS variable is gone — don't reintroduce a fixed height in CSS.

## Anti-patterns

- Defining section components inside `OperationPanel.tsx` function body — input focus loss on every keystroke.
- Subscribing to `useRuleStore` without a selector — every rule CRUD re-renders all sections.
- Calling `invoke('send_data', ...)` directly — go through `tauriService.send` (`src/services/tauri.ts`).
- Reading `useOperationStore.sendInput` via a non-selector inside `useCyclicSend` — selector subscriptions break the loop on every typing keystroke.
- Hardcoding cyclic intervals instead of routing through the command set's `delay` / `loopDelay`.
- Re-introducing `displayFormat`, `encoding`, `scrollLocked`, `showTimestamp`, or `loopInterval` into `useOperationStore` — those live per-tab in `useTerminalStore`.
- Writing display state from OperationPanel sections — display controls live in `TerminalFilterBar` (per-tab, writes via `useTerminalStore.getState()`).