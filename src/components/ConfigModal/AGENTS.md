# src/components/ConfigModal/

Multi-page settings modal. Split into `pages/` (7 settings), `editors/` (3 row form editors), and `RuleSetAccordion.tsx`.

## Files

| File | Lines | Role |
|------|------:|-----|
| `ConfigModal.tsx` | 112 | tab switcher (7 pages) + dialog open/close |
| `RuleSetAccordion.tsx` | 78 | collapsed rule-set listing |
| `pages/GeneralSettings.tsx` | 92 | theme + language + ports refresh interval |
| `pages/LogSettings.tsx` | ~190 | file path template, shard threshold, auto-start, encoding (ASCII/UTF-8/GBK/ISO-8859-1), directory-change migration dialog (DirChangeDialog) |
| `pages/BackupSettings.tsx` | 33 | import/export config file |
| `pages/DisplaySettings.tsx` | 45 | timestamp / TX·RX coloring / display format defaults |
| `pages/HighlightSettings.tsx` | 126 | bind `useRuleStore` highlight sets + manage rules |
| `pages/CommandSettings.tsx` | 142 | bind `useRuleStore` send-command sets + manage commands |
| `pages/ProtocolSettings.tsx` | 132 | protocol templates: frame head/length/checksum/tail |
| `pages/ToolSettings.tsx` | 100 | per-port external tool command template config (`{port}` placeholder) |
| `pages/TriggerSettings.tsx` | ~200 | conditional trigger rules: pattern match → alert/auto-respond; optional per-port scoping (`portId` dropdown, empty=all) |
| `editors/HighlightRuleEditor.tsx` | 35 | row form for highlight rule |
| `editors/SendCmdEditor.tsx` | 30 | row form for send command |
| `editors/ProtocolTemplateEditor.tsx` | 164 | field-by-field template form |

## Conventions (root covers i18n rules)

- All rule/command state lives in `useRuleStore` (highlight rule sets, send-command sets, protocol templates, trigger rules). Pages read via selectors; mutations route through store actions.
- Persistence: `useEffect` onLoad reads via `storageService` (invoke → `commands/storage.rs`, which is config-backed — it mutates `AppConfig` entity arrays and writes config.json, NOT a database); saves happen on the action itself, not on unmount. Direct invoke from a page is forbidden — go through `src/services/tauri.ts`.
- Each row editor is a small presentational component declared at module level. NEVER inline `<Editor>` JSX inside a page body — rerender churn causes input focus loss.
- Pages use `useTranslation()`'s `t()` for visible strings. Do not translate protocol vocabulary (`None/Even/Odd/Mark/Space`, `Xon/Xoff`, encoding names, units like `ms/px/MB`, acronyms `SIM/VCP/HEX/DTR/RTS`).

## Anti-patterns

- Subscribing the whole `useRuleStore` — every CRUD action re-renders every page.
- Storing rule state inside `useAppStore.config` — that store is for general user-side config; use the dedicated `useRuleStore`.
- Bypassing `storageService` and invoking Rust commands inline — they return `CommandError` and need typed mapping at the service layer.
- Defining editor components inside page bodies — focus loss guaranteed.
- Hard-coding strings instead of `t('namespace.key')` — page text won't switch with language toggle.