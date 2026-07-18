# src/components/ConfigModal/

Multi-page settings modal. Split into `pages/` (6 settings), `editors/` (3 row form editors), and `RuleSetAccordion.tsx`.

## Files

| File | Lines | Role |
|------|------:|-----|
| `ConfigModal.tsx` | 112 | tab switcher (6 pages) + dialog open/close |
| `RuleSetAccordion.tsx` | 78 | collapsed rule-set listing |
| `pages/GeneralSettings.tsx` | 92 | theme + language + ports refresh interval |
| `pages/LogSettings.tsx` | 56 | file path template, shard threshold, auto-start |
| `pages/BackupSettings.tsx` | 33 | import/export config file |
| `pages/DisplaySettings.tsx` | 45 | timestamp / TX·RX coloring / display format defaults |
| `pages/HighlightSettings.tsx` | 126 | bind `useRuleStore` highlight sets + manage rules |
| `pages/CommandSettings.tsx` | 142 | bind `useRuleStore` send-command sets + manage commands |
| `pages/ProtocolSettings.tsx` | 132 | protocol templates: frame head/length/checksum/tail |
| `editors/HighlightRuleEditor.tsx` | 35 | row form for highlight rule |
| `editors/SendCmdEditor.tsx` | 30 | row form for send command |
| `editors/ProtocolTemplateEditor.tsx` | 164 | field-by-field template form |

## Conventions (root covers i18n rules)

- All rule/command state lives in `useRuleStore` (highlight rule sets, send-command sets, protocol templates). Pages read via selectors; mutations route through store actions.
- Persistence: `useEffect` onLoad reads via `storageService` (invoke → `commands/storage.rs`); saves happen on the action itself, not on unmount. Direct SQLite/invoke from a page is forbidden — go through `src/services/tauri.ts`.
- Each row editor is a small presentational component declared at module level. NEVER inline `<Editor>` JSX inside a page body — rerender churn causes input focus loss.
- Pages use `useTranslation()`'s `t()` for visible strings. Do not translate protocol vocabulary (`None/Even/Odd/Mark/Space`, `Xon/Xoff`, encoding names, units like `ms/px/MB`, acronyms `SIM/VCP/HEX/DTR/RTS`).

## Anti-patterns

- Subscribing the whole `useRuleStore` — every CRUD action re-renders every page.
- Storing rule state inside `useAppStore.config` — that store is for general user-side config; use the dedicated `useRuleStore`.
- Bypassing `storageService` and invoking Rust commands inline — they return `CommandError` and need typed mapping at the service layer.
- Defining editor components inside page bodies — focus loss guaranteed.
- Hard-coding strings instead of `t('namespace.key')` — page text won't switch with language toggle.