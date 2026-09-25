# src/components/ConfigModal/

Multi-page settings modal. Split into `pages/` (9 settings pages), `editors/` (3 row form editors), `hooks/` (the shared entity-page contract), and `RuleSetAccordion.tsx` (the shared row shell).

## Files

| File | Role |
|---|---|---|
| `ConfigModal.tsx` | tab switcher (9 pages) + dialog open/close (pointerdown 记录起点，框选松手界外不关闭) + **save boundary** (update-channel bookkeeping, then `saveConfig`) |
| `hooks/useEntityPage.ts` | **the** load / dirty / save / delete contract for every entity page (see below) |
| `RuleSetAccordion.tsx` | presentational row shell: chevron + inline rename + header slot + ✓ save + delete, collapsible body. `description` / `countLabel` / `onAddItem` are optional so pages whose editor edits the entity itself render no child-CRUD furniture |
| `pages/GeneralSettings.tsx` | close behavior + max display lines + language + theme + power flags + Enter semantics + reconnect retries + **auto-update tri-state radio** (`updateCheckMode: none/stable/preview`) + fonts + config path |
| `pages/LogSettings.tsx` | file path template, shard threshold, per-session new file, directory-change migration dialog (DirChangeDialog), directory/subdir mode, timestamp/direction, format, encoding, split size |
| `pages/BackupSettings.tsx` | backup interval/directory + import/export config bundle (`version: 2` = one embedded `AppConfig`) |
| `pages/DisplaySettings.tsx` | preset baud rates / port type badge / default line ending / send prefix / timestamp mode+format; background image (enable → path → opacity / blur) |
| `pages/HighlightSettings.tsx` | bind `useRuleStore` highlight sets + manage rules |
| `pages/CommandSettings.tsx` | bind `useRuleStore` send-command sets + manage commands (loop toggle, loop delay, repeat count) |
| `pages/ProtocolSettings.tsx` | protocol templates: frame head/length/checksum/tail |
| `pages/ToolSettings.tsx` | per-port external tool command template (`{port}` placeholder) |
| `pages/TriggerSettings.tsx` | conditional trigger rules: pattern match → alert/auto-respond; optional per-port scoping (`portId` dropdown, empty = all); the only auto-saved entity page |
| `editors/HighlightRuleEditor.tsx` | row form for highlight rule |
| `editors/SendCmdEditor.tsx` | row form for send command |
| `editors/ProtocolTemplateEditor.tsx` | field-by-field template form |

## Entity page contract (`hooks/useEntityPage.ts`)

Five pages (highlight sets, command sets, protocol templates, tool configs, trigger rules) manage a list of entities. They all go through this hook — do **not** hand-roll a load/save/delete skeleton in a page:

1. **Mount** → load the whole list and replace the store, *unless* the user mutated the store while the load was in flight (immer keeps the array reference stable until a mutation, so reference equality is the test). An empty backend result always replaces: skipping it resurrects entities the user deleted (they reappear on the next open and get written back to config.json).
2. **Edits** mutate the store immediately; the store is the single source of truth for the whole-list save in `ConfigModal.handleSave`.
3. **Persistence** is either manual (row ✓) or debounced-auto (`autoSaveDebounceMs`) — never both. Only trigger rules use `autoSaveDebounceMs: 300` (plus an unmount flush, so closing the dialog never drops the last keystroke); for auto-saved collections a newly created row is also persisted immediately, because a create must not depend on the debounce window.
4. **Delete** = store drop + backend delete; a failed delete keeps the row gone from the store and toasts the error.

Pages may only *extend* the contract through `autoSaveDebounceMs`; any other divergence is a bug. Row ✓ has no success toast (errors always toast).

## Conventions (root covers i18n rules)

- All rule/command state lives in `useRuleStore` (highlight rule sets, send-command sets, protocol templates, trigger rules, port tool configs). Pages read via selectors; mutations route through store actions; pages never write `useAppStore.config`'s entity arrays.
- Persistence: entity CRUD is single-entity via `storageService` (invoke → `commands/storage.rs`, which mutates the `AppConfig` entity arrays and writes config.json — NOT a database); the whole-list write happens only at the modal's save boundary through `useConfigPersistence.saveConfig`, which builds a safe snapshot (live rule entities, `groups`, `ports`-derived `portMeta`, backend `portPresets`) instead of trusting the startup `config` snapshot. Direct invoke from a page is forbidden — go through `src/services/tauri.ts`.
- Numeric inputs take their range from `CONFIG_BOUNDS` (`src/utils/bounds.ts`, the frontend's single source; the Rust side mirrors it and `bounds.test.ts` asserts the two tables match). Page-local ranges (e.g. a command set's `loopDelay`) are declared once per page as a `[min, max]` pair so the `clampNumber` arguments and the `min`/`max` attributes cannot drift.
- Each row editor is a small presentational component declared at module level. NEVER inline `<Editor>` JSX inside a page body — rerender churn causes input focus loss.
- Pages use `useTranslation()`'s `t()` for visible strings. Do not translate protocol vocabulary (`None/Even/Odd`, `Xon/Xoff`, encoding names, units like `ms/px/MB`, acronyms `SIM/VCP/HEX/DTR/RTS`).

## Anti-patterns

- Subscribing the whole `useRuleStore` — every CRUD action re-renders every page.
- Storing rule state inside `useAppStore.config` — that store is a read-only startup snapshot; use `useRuleStore`.
- Bypassing `storageService` and invoking Rust commands inline — they return `CommandError` and need typed mapping at the service layer.
- Defining editor components inside page bodies — focus loss guaranteed.
- Hard-coding strings instead of `t('namespace.key')` — page text won't switch with language toggle.
- Adding a second persistence mechanism to a page (a bespoke debounce, a save-on-unmount, a manual ✓ handler) instead of `useEntityPage`.
