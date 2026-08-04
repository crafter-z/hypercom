# src-tauri/src/commands/

7 domain files + `mod.rs` re-export hub. All Tauri commands return `Result<T, CommandError>`.

## Where to look

| File | Commands |
|------|----------|
| `serial.rs` | `open_port`, `close_port`, `send_data`, `send_file`, `set_serial_params`, `set_flow_control`, `attempt_reconnect`, `run_port_tool`, `kill_port_tool`, `cancel_file_send`. `send_file`: per-port cancel token in `AppState.file_send_cancel` (set by `cancel_file_send`), `tokio::fs::read`, `yield_now()` when `delay_ms==0`, and an **unconditional** terminal `serial:file_progress{done:true}` after the loop (covers normal / cancel / write-error / empty). `run_port_tool`: close→spawn→stream stdout/stderr→reopen 闭环；read thread joined **outside** the serial lock; streams read by bytes (`read_until(b'\n')` + `from_utf8_lossy`, so non-UTF-8 flasher output isn't truncated); reopen failure emits `serial:status error`. `{port}` template substitution; `AppState.tool_processes` holds the `Child` for `kill_port_tool`. |
| `simulation.rs` | `enable_simulation`, `disable_simulation`. **Dev-only** (issue #2-9): in release builds (`cfg(not(debug_assertions))`) both commands return `CommandError::Serial` without touching the serial manager. |
| `config.rs` | `get_config`, `set_config`, `reset_config`, `update_session_snapshot`, `get_session_snapshot`, `get_config_path`. `set_config`/`reset_config` auto-sync LogManager via `sync_log_manager_from_config()`. `update_session_snapshot` writes the separate `session.json` (not config.json, no `.bak`). |
| `log.rs` | `start_logging`, `stop_logging`, `save_log_as`, `export_terminal_log`, `get_log_files`, `set_log_split_size`, `set_log_split_enabled`, `set_log_filename_format`, `set_log_auto_save`, `set_log_encoding`, `open_path`, `open_log_directory`, `migrate_log_directory`. Note: `save_log_as` and `export_terminal_log` scope restriction removed (user-chosen save dialog path only needs valid parent). |
| `storage.rs` | settings entities CRUD (command sets / highlight sets / protocol templates / trigger rules / port presets / tool configs) + `save_port_groups` (whole-list replace of port groups, issue #2-3 — read back via `get_config`'s `AppConfig.port_groups`, no separate load command). Synchronous ConfigManager operations — lock `config_manager`, mutate the entity Vec in `AppConfig`, save config.json. NO SQLite/async/transactions. |
| `system_cmds.rs` | `get_system_status`, `prevent_sleep`, `prevent_screen_off` |
| `file.rs` | `write_text_file`, `read_text_file`. `validate_config_path()` restricts import paths to config directory. |
| `mod.rs` | `CommandError` enum (thiserror) + `pub use domain::*;` re-exports |

## Conventions

- `CommandError` variants: `Serial` / `Config` / `Log` / `System` / `Lock` / `Io` / `Other`. Manual `impl serde::Serialize` so the frontend gets the error string via `invoke`.
- `AppState` holds `config_manager: Mutex<ConfigManager>` in addition to `serial_manager`, `logger`. Config commands (`config.rs`) and settings-entity CRUD (`storage.rs`) access it directly.
- Map errors with `map_err(|e| CommandError::Domain(e.to_string()))`. Pick the matching variant by domain; fall back to `CommandError::Other` only for genuinely domain-less errors.
- `pub use <domain>::*;` in `mod.rs` — register the command in `lib.rs::invoke_handler!` (or `generate_handler!`), do not leak per-domain `pub mod` renames.
- `src-tauri/src/system.rs` `win32_power` module wraps Win32 `SetThreadExecutionState` FFI. Used by `system_cmds.rs` only — do not duplicate FFI elsewhere.

## Anti-patterns

- Returning `Result<T, String>` — frontend no longer parses raw strings; serialization contract is broken.
- Holding a `std::sync::MutexGuard` on `state.serial_manager` / `state.logger` / `state.config_manager` across `.await` — `MutexGuard` is `!Send`, the Tauri future must be `Send`. Pattern: extract + clone, drop guard, then `.await`. See `log.rs`.
- `eprintln!` for error logging — use the `log` crate (`error!` / `warn!`). Backend uses `log`/`env_logger`, not print macros.
- Adding a 7th domain file without classifying its failure mode in `CommandError`.
- Bypassing the `tauri` service module in the frontend and calling `invoke('<cmd>', ...)` directly.