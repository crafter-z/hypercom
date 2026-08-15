# src-tauri/src/commands/

11 domain files + `mod.rs` re-export hub. All Tauri commands return `Result<T, CommandError>`.

## Where to look

| File | Commands |
|------|----------|
| `serial.rs` | `open_port`, `close_port`, `send_data`, `send_file`, `set_serial_params`, `set_flow_control`, `attempt_reconnect`, `run_port_tool`, `kill_port_tool`, `cancel_file_send`. `send_file`: per-port cancel token in `AppState.file_send_cancel` (set by `cancel_file_send`), `tokio::fs::read`, `yield_now()` when `delay_ms==0`, and an **unconditional** terminal `serial:file_progress{done:true}` after the loop (covers normal / cancel / write-error / empty). `run_port_tool`: close→spawn→stream stdout/stderr→reopen 闭环；read thread joined **outside** the serial lock; streams read by bytes (`read_until(b'\n')` + `from_utf8_lossy`, so non-UTF-8 flasher output isn't truncated); reopen failure emits `serial:status error`. `{port}` template substitution; `AppState.tool_processes` holds the `Child` for `kill_port_tool`. **GIT: 路由（issue #11）**：`send_serial_data`/`send_file` 对 `GIT:` 开头端口走 `SerialManager::send_data`/`write_raw`（写 pty stdin）。 |
| `simulation.rs` | `enable_simulation`, `disable_simulation`. **Dev-only** (issue #2-9): in release builds (`cfg(not(debug_assertions))`) both commands return `CommandError::Serial` without touching the serial manager. |
| `tty_sim.rs` | `enable_gitbash_sim`, `disable_gitbash_sim`, `resize_gitbash_sim` — 模拟终端（git bash pty）控制（issue #11）。**Dev-only**（镜像 `simulation.rs` 的 issue #2-9 双层门控）：release 构建（`cfg(not(debug_assertions))`）三个命令直接返回 `CommandError::Serial`。`enable_*` 校验 `find_bash()` 存在后 `set_gitbash_sim(true)` 并返回 `"GIT:BASH"`；`disable_*` 遍历 `tty_sim_ports` 逐个 `close_port`（锁外 join 读线程）后 `set_gitbash_sim(false)`；`resize_*` 走 `SerialManager::resize_tty_sim`。依赖 Cargo crate `portable-pty` 0.9（Windows = ConPTY）。 |
| `config.rs` | `get_config`, `set_config`, `reset_config`, `update_session_snapshot`, `get_session_snapshot`, `get_config_path`. `set_config`/`reset_config` auto-sync LogManager via `sync_log_manager_from_config()`. `update_session_snapshot` writes the separate `session.json` (not config.json, no `.bak`). |
| `log.rs` | `start_logging`, `stop_logging`, `save_log_as`, `export_terminal_log`, `get_log_files`, `set_log_split_size`, `set_log_split_enabled`, `set_log_filename_format`, `set_log_auto_save`, `set_log_encoding`, `open_path`, `open_log_directory`, `migrate_log_directory`. Note: `save_log_as` and `export_terminal_log` scope restriction removed (user-chosen save dialog path only needs valid parent). |
| `storage.rs` | settings entities CRUD (command sets / highlight sets / protocol templates / trigger rules / port presets / tool configs) + `save_port_groups` (whole-list replace of port groups, issue #2-3 — read back via `get_config`'s `AppConfig.port_groups`, no separate load command) + `save_port_meta` (whole-list replace of port meta `{portId, alias, isHidden}`, issue #4-9 — read back via `AppConfig.port_meta`). Synchronous ConfigManager operations — lock `config_manager`, mutate the entity Vec in `AppConfig`, save config.json. NO SQLite/async/transactions. |
| `diag.rs` | `get_diag_log_path`, `read_diag_log(limit?)`, `clear_diag_log`, `append_diag_log(entries)` — 应用自身维测日志的读取/清空 + 前端 `console.*` 转发追加；底层由 `crate::diaglog::DiagLogger`（全局 logger，落盘 + 轮转）提供 |
| `system_cmds.rs` | `get_system_status`, `prevent_sleep`, `prevent_screen_off` |
| `file.rs` | `write_text_file`, `read_text_file`. `validate_config_path()` restricts import paths to config directory. |
| `update.rs` | `check_for_update`, `download_and_install_update`（自动更新，issue #12）。**通道是运行时参数**：JS `check()` 无法指定 endpoint → 本模块经 `app.updater_builder().endpoints(vec![url])` 按 channel 选 endpoint——`stable` 直连 `releases/latest/download/latest.json`（GitHub「最新非 prerelease」指针）；`preview` 先经 GitHub API（`api.github.com/releases?per_page=100`，未认证限流 60/h/IP 超限静默降级）用纯函数 `find_latest_preview_tag` 取最新 `vX.Y.Z-preview.N` tag 再 tag-pinned URL。**门控与 simulation.rs 同向但相反**：release（`cfg(not(debug_assertions))`）才执行真实逻辑，debug 直接返回 Ok(None)/Ok(())（前端 `import.meta.env.DEV` 自动短路外另有前端 `manualCheck` 不过门控——显式意图，依赖本层 debug 兜底）。下载进度经 `Emitter` 发 `update:progress` 事件（`UpdateProgressPayload` camelCase：downloaded/total/phase）。错误统一 `CommandError::Other`。 |
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
- `eprintln!` for error logging — use the `log` crate (`error!` / `warn!`). Backend uses `log` → `diaglog::DiagLogger` (全局 logger，落盘 + 轮转，替换原 env_logger), not print macros.
- Adding a 7th domain file without classifying its failure mode in `CommandError`.
- Bypassing the `tauri` service module in the frontend and calling `invoke('<cmd>', ...)` directly.