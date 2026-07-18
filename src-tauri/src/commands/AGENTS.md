# src-tauri/src/commands/

6 domain files + `mod.rs` re-export hub. All Tauri commands return `Result<T, CommandError>`.

## Where to look

| File | Commands |
|------|----------|
| `serial.rs` | `open_port`, `close_port`, `send_data`, `get_port_status` |
| `simulation.rs` | `enable_simulation`, `disable_simulation` |
| `config.rs` | `get_config`, `save_config`, `reset_config` |
| `log.rs` | `start_logging`, `stop_logging`, `save_as`, `open_file`, `open_directory` |
| `storage.rs` | highlight rule sets + send command sets + protocol templates CRUD |
| `system_cmds.rs` | `get_system_status`, `prevent_sleep`, `prevent_screen_off` |
| `mod.rs` | `CommandError` enum (thiserror) + `pub use domain::*;` re-exports |

## Conventions

- `CommandError` variants: `Serial` / `Config` / `Log` / `Storage` / `System` / `Lock` / `Io` / `Other`. Manual `impl serde::Serialize` so the frontend gets the error string via `invoke`.
- Map errors with `map_err(|e| CommandError::Domain(e.to_string()))`. Pick the matching variant by domain; fall back to `CommandError::Other` only for genuinely domain-less errors.
- `pub use <domain>::*;` in `mod.rs` — register the command in `lib.rs::invoke_handler!` (or `generate_handler!`), do not leak per-domain `pub mod` renames.
- `src-tauri/src/system.rs` `win32_power` module wraps Win32 `SetThreadExecutionState` FFI. Used by `system_cmds.rs` only — do not duplicate FFI elsewhere.

## Anti-patterns

- Returning `Result<T, String>` — frontend no longer parses raw strings; serialization contract is broken.
- Holding a `std::sync::MutexGuard` on `state.serial_manager` / `state.storage_manager` / `state.logger` across `.await` — `MutexGuard` is `!Send`, the Tauri future must be `Send`. Pattern: extract + clone, drop guard, then `.await`. See `log.rs`.
- `eprintln!` for error logging — use the `log` crate (`error!` / `warn!`). Backend uses `log`/`env_logger`, not print macros.
- Adding a 7th domain file without classifying its failure mode in `CommandError`.
- Bypassing the `tauri` service module in the frontend and calling `invoke('<cmd>', ...)` directly.