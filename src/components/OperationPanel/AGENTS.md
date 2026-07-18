# src/components/OperationPanel/

Send area + serial params + rule quick access. Split into 4 view sections, a `ViewStrip` mode toggle, and the `useCyclicSend` hook.

## Files

| File | Lines | Role |
|------|------:|-----|
| `OperationPanel.tsx` | 142 | container; binds active rule/command set; mounts section components |
| `SendSection.tsx` | 150 | ASCII / HEX send textarea, line terminator selector, send button → `useSerialSend` |
| `ViewStrip.tsx` | 118 | mode strip: switch manual vs cyclic-send view |
| `ParamsSection.tsx` | 79 | baudRate / dataBits / parity / stopBits / handshake / DTR / RTS (binds `useOperationStore`) |
| `RulesSection.tsx` | 112 | active highlight rule-set + active command-set quick toggles |
| `hooks/useCyclicSend.ts` | 119 | cyclic send loop; per-command interval + overall replay interval; reads from `useRuleStore.sendCommandSets` via `getState` |

## Conventions (root covers selector discipline)

- Operation fields live on `useOperationStore` with NO `op` prefix — selectors look like `s => s.baudRate`, not `s => s.opBaudRate`.
- `useCyclicSend` reads `useRuleStore.getState().sendCommandSets` (NOT via a subscribing selector) — entry mutations would re-mount the controller and reset progress.
- `ViewStrip` owns the local UI mode switch (`'manual' | 'cyclic'`); not shared with global store.
- HEX parse lives in `src/utils/hexUtils.ts` (`stringToHex` / `hexToString`); `SendSection` validates HEX input boundaries before invoking `useSerialSend`.
- The 4 section components are defined at module level — never inline them in `OperationPanel.tsx`'s body.

## Anti-patterns

- Defining section components inside `OperationPanel.tsx` function body — input focus loss on every keystroke.
- Subscribing to `useRuleStore` without a selector — every rule CRUD re-renders all sections.
- Calling `invoke('send_data', ...)` directly — go through `tauriService.send` (`src/services/tauri.ts`).
- Reading `useOperationStore.sendInput` via a non-selector inside `useCyclicSend` — selector subscriptions break the loop on every typing keystroke.
- Hardcoding polling/cyclic intervals instead of routing through `useOperationStore` config fields.