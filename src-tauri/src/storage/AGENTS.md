# src-tauri/src/storage/

SQLite via sqlx (`runtime-tokio`, `sqlite`). Single 785-line `mod.rs` — largest backend file.

## Models (top-level structs at `mod.rs`)

| Struct (line) | SQLite table | Notes |
|---------------|--------------|-------|
| `PortGroupRow` (18) | `port_groups` | sidebar grouping |
| `SendCommandRow` (26) | `send_commands` | FK → `send_command_sets` |
| `HighlightRuleRow` (38) | `highlight_rules` | FK → `highlight_rule_sets` |
| `SendCommandSet` (52) | `send_command_sets` | parent row for send commands |
| `HighlightRuleSet` (61) | `highlight_rule_sets` | parent row for highlight rules |
| `ProtocolTemplateRow` (69) | `protocol_templates` | frame head/length/checksum/tail |
| `StorageManager` (90) | — | holds `Pool<Sqlite>`; accessed via `state.storage_manager.lock()` |

## Conventions (root covers the MutexGuard+clone pattern)

- Rule-set & command-set rows are nested. Parent stores metadata; child rows belong via FK. On save, **replace all children in a transaction** — old children leak if you append incrementally.
- Typed reads: `sqlx::query_as::<_, Row>`. Writes: `sqlx::query` with bound params. Never interpolate values into SQL.
- WAL mode is set at pool init (`PRAGMA journal_mode=WAL`). Do not switch to DELETE in production.
- Schema migrations: **append-only**. New table or column = new `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` step. Do not mutate existing columns.
- Pool clone before `.await`: `let pool = { let mgr = state.storage_manager.lock().unwrap(); mgr.pool().unwrap().clone() };` — see `commands/storage.rs`.

## Anti-patterns

- Returning `sqlx` rows from Tauri commands — convert to the DTO structs above and let `serde::Serialize` handle the wire format.
- `unwrap()` on `Row::get` for an optional column — use `try_get::<T, _>(name)` even when "sure".
- Sharing the immutable `StorageManager` guard across `await` — the future is `!Send`.
- Adding a 7th table without a matching `CommandError::Storage` mapping path through `commands/storage.rs`.
- Modifying the open log file path through SQLite — log paths live in the `config` module and JSON config, not in SQLite.