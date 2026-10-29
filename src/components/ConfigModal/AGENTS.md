# src/components/ConfigModal/

Multi-page settings modal. Split into `pages/` (10 settings pages), `editors/` (3 row form editors), `hooks/` (the shared entity-page contract), and `RuleSetAccordion.tsx` (the shared row shell).

## Files

| File | Role |
|---|---|---|
| `ConfigModal.tsx` | tab switcher + full save; X/Cancel/Escape use shared Save/Discard/Continue guard, preserving committed plugin state |
| `hooks/useEntityPage.ts` | unified `useEntityPage({kind})` session-draft API backed by `utils/entityEditor.ts` |
| `RuleSetAccordion.tsx` | sortable row shell, insert above/below, row and collection save/discard, dirty/error status |
| `pages/GeneralSettings.tsx` | close behavior + max display lines + language + theme + power flags + Enter semantics + reconnect retries + **auto-update tri-state radio** (`updateCheckMode: none/stable/preview`) + fonts + config path |
| `pages/LogSettings.tsx` | file path template, shard threshold, per-session new file, directory-change migration dialog (DirChangeDialog), directory/subdir mode, timestamp/direction, format, encoding, split size |
| `pages/BackupSettings.tsx` | config bundle import/export (`version: 2`); no plugin code/private data; import reads back backend-authoritative state and only restores grants for the same installation identity |
| `pages/DisplaySettings.tsx` | preset baud rates / port type badge / default line ending / send prefix / timestamp mode+format; background image (enable → path → opacity / blur) |
| `pages/HighlightSettings.tsx` | draft highlight sets and nested rules; committed arrays alone drive rendering |
| `pages/CommandSettings.tsx` | draft command sets, nested drag/insert; dense order shared with panel and new cyclic runs |
| `pages/ProtocolSettings.tsx` | protocol templates: frame head/length/checksum/tail |
| `pages/ToolSettings.tsx` | per-port external tool command template (`{port}` placeholder) |
| `pages/TriggerSettings.tsx` | staged reminder/auto-reply rules; explicit save only, no debounce or unmount writes |
| `pages/PluginSettings.tsx` | directory/ZIP install, upgrade, uninstall, pregrant while disabled, enable after queued grants persist; actions bind reviewed installGeneration, snapshots order by revision; proxy uses normal footer save |
| `editors/HighlightRuleEditor.tsx` | row form for highlight rule |
| `editors/SendCmdEditor.tsx` | row form for send command |
| `editors/ProtocolTemplateEditor.tsx` | field-by-field template form |

## Entity page contract (`hooks/useEntityPage.ts`)

Five entity pages use `useEntityPage<T>({kind})`; never create page-local persistence or edit committed runtime arrays.

1. Drafts and expanded entity IDs survive page unmount. Mount never reloads over dirty state.
2. Create/update/delete/enable/reorder are staged. `items` is the draft; `useRuleStore` arrays remain committed runtime.
3. `save(id)` commits only that entity; `save()` commits the collection including deletion/order. Footer save commits all categories. Failed validation/CAS retains drafts; late edits stay dirty.
4. Discard affects only its requested scope. Shared close guard awaits saves or remote discard ACKs; failure/new edits prevent closing.
5. Use `SortableEditorList` for handle-only pointer/keyboard sorting; `commandOrder` normalizes command ranks. Array order is authoritative for other management lists. Object property order is not an edit (`jsonEqual`).

## Conventions (root covers i18n rules)

- Runtime rules live in `useRuleStore`; pages use `useEntityPage` drafts, not runtime setters. `useAppStore.config` entity arrays are last persisted baseline.
- `entityEditor` and `useConfigPersistence` serialize CAS writes through `configWriteQueue`; publish runtime only after acceptance. Plugin actions remain immediate/backend-authoritative. Backup import confirms destructive replacement, handles drafts, adopts backend state and reloads.
- Numeric inputs take their range from `CONFIG_BOUNDS` (`src/utils/bounds.ts`, the frontend's single source; the Rust side mirrors it and `bounds.test.ts` asserts the two tables match). Page-local ranges (e.g. a command set's `loopDelay`) are declared once per page as a `[min, max]` pair so the `clampNumber` arguments and the `min`/`max` attributes cannot drift.
- Each row editor is a small presentational component declared at module level. NEVER inline `<Editor>` JSX inside a page body — rerender churn causes input focus loss.
- Pages use `useTranslation()`'s `t()` for visible strings. Do not translate protocol vocabulary (`None/Even/Odd`, `Xon/Xoff`, encoding names, units like `ms/px/MB`, acronyms `SIM/VCP/HEX/DTR/RTS`).

## Anti-patterns

- Subscribing the whole `useRuleStore` — every CRUD action re-renders every page.
- Editing `useRuleStore` arrays or `useAppStore.config` entity baselines directly from forms.
- Bypassing the shared editor CAS/save/leave contract with CRUD invokes, auto-save, or unmount writes.
- Defining editor components inside page bodies — focus loss guaranteed.
- Hard-coding strings instead of `t('namespace.key')` — page text won't switch with language toggle.
- Adding a second persistence mechanism to a page (a bespoke debounce, a save-on-unmount, a manual ✓ handler) instead of `useEntityPage`.
