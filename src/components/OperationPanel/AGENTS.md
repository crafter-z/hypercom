# src/components/OperationPanel/

Send area + serial params. Split into 3 view sections (send / params) and the `useCyclicSend` hook — the old standalone `RulesSection` (highlight dropdown + loop controls) was removed: its highlight dropdown was a dead control (the highlight engine filters by each set's `isEnabled`, never reading `activeHighlightSetId`), and its command-set select + loop toggle were merged into `SendSection`'s compact header. `OperationPanel.tsx` owns the top strip (connect / clear screen / log replay / log save-open / font-size slider). The panel height is drag-resizable: `OperationPanelResizeHandle` (in `src/components/shared/`, mounted between `MainDisplay` and `OperationPanel` in `App.tsx`) writes `ui.operationPanelHeight`, which `OperationPanel.tsx` applies as an inline height (the collapsed state still pins to the header via CSS).

## Files

| File | Lines | Role |
|------|------:|-----|
| `OperationPanel.tsx` | ~230 | container + top strip: connect / clear screen / replay controls (targets active tab) / log save-as, open-file, open-dir / font-size slider; mounts `SendSection` + `ParamsSection` (no `RulesSection`) |
| `SendSection.tsx` | ~360 | compact header (`.op-send-header`: card title on the left; command-set `<select>` + loop icon-toggle + edit icon on the right, one line) above the quick-send pill row + send textarea + HEX toggle (bidirectional content conversion via `textToHexPreview`/`hexToTextPreview`) + HEX input sanitization (`sanitizeHexInput`) + line terminator selector + file-send button; the loop toggle (`handleToggleLoop`) flips `isLoopSending` and pulses while running; repeat count is NOT here — it lives per command set (`SendCommandSet.repeatCount`); Enter semantics governed by `config.sendOnEnter` (plain Enter sends by default; Shift/Ctrl+Enter always insert newline) |
| `ParamsSection.tsx` | 130 | baudRate / dataBits / parity / stopBits / handshake / DTR / RTS; preset apply dropdown only (preset management moved to `ConfigModal/pages/GeneralSettings.tsx`) |
| `hooks/useCyclicSend.ts` | ~155 | cyclic send loop; reads `useRuleStore.sendCommandSets` via `getState`; round boundary detected by `currentCmdIdx === length-1` (index resets to 0 each round so per-command `delay` keeps applying and `completedRounds` counts rounds, not commands); repeat limit from the active set's `repeatCount` (0 = follow `isLoop`); error retry fixed at 500ms |

## Conventions (root covers selector discipline)

- Operation fields live on `useOperationStore` with NO `op` prefix — selectors look like `s => s.baudRate`, not `s => s.opBaudRate`.
- `useCyclicSend` reads `useRuleStore.getState().sendCommandSets` (NOT via a subscribing selector) — entry mutations would re-mount the controller and reset progress.
- HEX parse/convert helpers live in `src/utils/sendUtils.ts` (`textToHexPreview`, `hexToTextPreview`, `sanitizeHexInput`, `computeByteCount`, `parseHexBytes`). `src/utils/hexUtils.ts` still provides the low-level `stringToHex` / `hexToString`.
- HEX toggle on the checkbox converts content both ways: string→hex on check (via `textToHexPreview`), hex→string on uncheck (via `hexToTextPreview`). HEX-mode input is sanitized.
- Enter semantics: plain Enter sends by default; Shift+Enter and Ctrl+Enter always insert newline. When `config.sendOnEnter` is off (settings toggle), Enter also inserts newline and sending is only via the Send button. The "Enter behavior toggle" button was removed; it's now a setting checkbox in GeneralSettings.
- Send history: in-memory per-port (cap 50, `Map<portId, SendHistoryEntry[]>` in `useSerialSend`); "clear send history" button removed. ↑/↓ recall still works.
- Log replay (`useLogReplay` in `src/components/MainDisplay/hooks/useLogReplay.ts`) is driven from OperationPanel's strip; targets the active tab.
- Timing for cyclic send is single-sourced from the command set: per-command `delay` (intra-round), `loopDelay` (inter-round), and `repeatCount` (round limit; 0 = follow `isLoop`). No global interval or repeat field exists in `useOperationStore` (`loopRepeatCount` was removed — repeat count is now per-set).
- The section components are defined at module level — never inline them in `OperationPanel.tsx`'s body.
- `.op-section > *` carries `flex-shrink: 0`: when the panel is dragged short, section children keep their natural height and the section scrolls. Removing this re-introduces the overlap bug where `.op-send-row` (which has `min-height: 0`) collapsed to 0 height and its 发送/文件/HEX controls spilled onto the quick-send pills.
- Panel height lives in `ui.operationPanelHeight` (default 200, clamped [160, 600] by `OperationPanelResizeHandle`) and is applied inline in `OperationPanel.tsx`. The old static `--operation-panel-height` CSS variable is gone — don't reintroduce a fixed height in CSS.

## Anti-patterns

- Defining section components inside `OperationPanel.tsx` function body — input focus loss on every keystroke.
- Subscribing to `useRuleStore` without a selector — every rule CRUD re-renders all sections.
- Calling `invoke('send_data', ...)` directly — go through `tauriService.send` (`src/services/tauri.ts`).
- Reading `useOperationStore.sendInput` via a non-selector inside `useCyclicSend` — selector subscriptions break the loop on every typing keystroke.
- Hardcoding cyclic intervals instead of routing through the command set's `delay` / `loopDelay`.
- Re-introducing `displayFormat`, `encoding`, `scrollLocked`, `showTimestamp`, or `loopInterval` into `useOperationStore` — those live per-tab in `useTerminalStore`.
- Writing display state from OperationPanel sections — display controls live in `TerminalFilterBar` (per-tab, writes via `useTerminalStore.getState()`).