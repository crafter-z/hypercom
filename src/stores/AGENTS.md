# src/stores/

4 Zustand + Immer stores, no god store. Split by domain to avoid cross-domain re-renders.

## Where to look

| Store | File:line | Job |
|-------|-----------|-----|
| `useAppStore` | `useAppStore.ts:248` | tabs / ports / `paneTree` / config / groups |
| `useOperationStore` | `useOperationStore.ts:35` | serial params + send — `baudRate`, `dataBits`, `parity`, `stopBits`, `handshake`, `dtr`, `rts`, `sendInput`, `displayFormat`, `encoding` (NO `op` prefix) |
| `useTerminalStore` | `useTerminalStore.ts:20` | line buffer + `appendTerminalLine` + `ensureTerminal` + `setTerminalConfig` |
| `useRuleStore` | `useRuleStore.ts:32` | highlight rule sets + send-command sets + CRUD + active-set ids |

## Conventions (root covers selector discipline)

- **Recursive pane tree helpers exported at module top of `useAppStore.ts`**: `findLeafById` (25), `findLeafByTabId` (37), `findBranchById` (49), `findParentBranch` (60), `collectLeaves` (75), `countLeaves` (81). Use these; don't hand-roll tree walks.
- `pruneTree` is private; auto-runs after every tree mutation: ① drops non-root empty leaves → ② collapses single-child branches (size inherits) → ③ empty root branch → degenerate `'main'` leaf.
- `focusedPaneId` references a LEAF ID in the tree (never a flat array index).
- Tree mutation actions: `splitPane`, `closeTab`, `resizeChildren(branchId, childIndex, deltaFraction)`. Use these — never write tree state by hand.
- `useAppStore.test.ts` (547 lines, vitest) exercises `splitPane` / `closeTab` / `resizeChildren` / `pruneTree`. Run with `npm run test:run`.
- In callbacks/effects needing latest value without subscribing: `useXStore.getState().y`.

## Anti-patterns

- Subscribing without a selector — every `appendTerminalLine` re-renders consumer, causing input focus loss.
- Test code using `state.panes[...]` or `state.panes.length` — that schema is gone; assert on `state.paneTree`, narrow with `as BranchPane` for `children`.
- Mutating tree state by hand instead of `splitPane`/`closeTab`/`resizeChildren`.
- Re-introducing the `op`-prefixed operation field names (`opBaudRate` etc.).
- Calling a store with no selector inside a hook that owns a high-frequency listener (saps perf worse than in a render fn).