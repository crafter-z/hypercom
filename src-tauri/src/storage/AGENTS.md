# src-tauri/src/storage/

SQLite via sqlx (`runtime-tokio`, `sqlite`). Single 887-line `mod.rs` — largest backend file. 7 tables (was 9; `port_groups` and `port_group_members` removed). WAL + FK pragmas set at pool init.

## Models (top-level structs at `mod.rs`)

| Struct (line) | SQLite table | Notes |
|---------------|--------------|-------|
| `SendCommandRow` (18) | `send_commands` | FK → `send_command_sets` |
| `HighlightRuleRow` (30) | `highlight_rules` | FK → `highlight_rule_sets` |
| `SendCommandSet` (44) | `send_command_sets` | parent row for send commands |
| `HighlightRuleSet` (53) | `highlight_rule_sets` | parent row for highlight rules |
| `ProtocolTemplateRow` (61) | `protocol_templates` | frame head/length/checksum/tail |
| `SendHistoryRow` (81) | `send_history` | send history per port |
| `PortPresetRow` (91) | `port_presets` | baud rate / data bits presets (`ON CONFLICT` preserves `created_at`) |
| `StorageManager` (106) | — | holds `Pool<Sqlite>`; accessed via `state.storage_manager.lock()` |

## Conventions (root covers the MutexGuard+clone pattern)

- Rule-set & command-set rows are nested. Parent stores metadata; child rows belong via FK. On save, **replace all children in a transaction** — old children leak if you append incrementally. `save_command_set_to_db` and `save_highlight_set_to_db` now do this atomically.
- Typed reads: `sqlx::query_as::<_, Row>`. Writes: `sqlx::query` with bound params. Never interpolate values into SQL.
- WAL mode + FK pragmas set at pool init (`PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON`). Do not switch to DELETE in production.
- `port_presets` uses `ON CONFLICT` to preserve `created_at` on upsert.
- Schema migrations: **append-only**. New table or column = new `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` step. Do not mutate existing columns.
- Pool clone before `.await`: `let pool = { let mgr = state.storage_manager.lock().unwrap(); mgr.pool().unwrap().clone() };` — see `commands/storage.rs`.

## Anti-patterns

- Returning `sqlx` rows from Tauri commands — convert to the DTO structs above and let `serde::Serialize` handle the wire format.
- `unwrap()` on `Row::get` for an optional column — use `try_get::<T, _>(name)` even when "sure".
- Sharing the immutable `StorageManager` guard across `await` — the future is `!Send`.
- Adding an 8th table without a matching `CommandError::Storage` mapping path through `commands/storage.rs`.
- Modifying the open log file path through SQLite — log paths live in the `config` module and JSON config, not in SQLite.