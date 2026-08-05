# HyperCom Backend Error Codes

Reference mapping for `CommandError` variants in `src-tauri/src/commands/mod.rs`.

## Variant definition

```rust
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("Serial error: {0}")]
    Serial(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("Log error: {0}")]
    Log(String),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("System error: {0}")]
    System(String),
    #[error("Lock error: {0}")]
    Lock(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}
```

## Mapping table

| Variant | Error message format | Trigger conditions | i18n key |
|---------|----------------------|--------------------|----------|
| `Serial` | `Serial error: {details}` | `commands/serial.rs:17` (list ports), `commands/serial.rs:41` (open), `commands/serial.rs:53` (close), `commands/serial.rs:79` (send data), `commands/serial.rs:136` (set params), `commands/serial.rs:148` (set flow control), `commands/serial.rs:165` (attempt reconnect), `commands/simulation.rs:35` (close sim port). All wrap errors from `serial/mod.rs`. | `toast.error.serial` |
| `Config` | `Config error: {details}` | `commands/config.rs:28` (set config), `commands/config.rs:40` (reset config). Wraps `config::ConfigManager` persistence errors. | `toast.error.config` |
| `Log` | `Log error: {details}` | `commands/log.rs:17` (set directory), `commands/log.rs:33` (save as), `commands/log.rs:63` (export outside log dir), `commands/log.rs:80` (list files), `commands/log.rs:143` (start logging), `commands/log.rs:155` (stop logging), `commands/log.rs:178` (open path outside log dir), `commands/log.rs:185` (path does not exist). | `toast.error.log` |
| `Storage` | `Storage error: {details}` | `commands/storage.rs` 各 CRUD 命令（命令集 / 高亮集 / 协议模板 / 触发规则 / 端口预设 / 工具配置 / 分组 / 端口元数据）。SQLite 已移除（2026-08），现为 config.json 实体 CRUD：Wraps `config::ConfigManager` persistence errors。 | `toast.error.storage` |
| `System` | `System error: {details}` | `commands/system_cmds.rs:69` (prevent screen off), `commands/system_cmds.rs:76` (prevent sleep). Wraps Win32 `SetThreadExecutionState` failures. | `toast.error.system` |
| `Lock` | `Lock error: {details}` | Any Tauri command that acquires a `std::sync::Mutex` on `AppState`: `commands/serial.rs:14`, `38`, `50`, `71`, `126`, `145`, `162`; `commands/config.rs:12`, `25`, `37`; `commands/log.rs:14`, `30`, `49`, `77`, `89`, `100`, `111`, `123`, `134`, `140`, `152`, `168`, `223`; `commands/simulation.rs:12`, `25`, `32`, `40`; `commands/storage.rs:38`, `84`, `127`, `168`, `213`, `255`, `297`, `336`, `356`. | `toast.error.lock` |
| `Io` | `IO error: {details}` | `commands/log.rs:58` (canonicalize export parent), `commands/log.rs:61` (canonicalize log root), `commands/log.rs:68` (write export file), `commands/log.rs:173` (canonicalize target), `commands/log.rs:176` (canonicalize log root), `commands/log.rs:197/204/211` (spawn explorer/open/xdg-open). | `toast.error.io` |
| `Other` | `{details}` | `commands/log.rs:56` (export path has no parent directory). Fallback for domain-less validation failures. | `toast.error.other` |

## i18n additions

The following keys were added to `src/i18n.ts` for both `zh-CN` and `en-US` so that every variant has a stable translation key:

- `toast.error.serial`
- `toast.error.config`
- `toast.error.log`
- `toast.error.storage`
- `toast.error.system`
- `toast.error.lock`
- `toast.error.io`
- `toast.error.other`

## Notes

- `CommandError` is manually serialized to a plain string via `serde::Serialize`, so the frontend receives the formatted message (e.g. `"Serial error: Port COM3 is not available"`).
- `notifyError()` in `src/stores/useToastStore.ts` extracts the message and displays it verbatim; the i18n keys above are used as structured fallbacks when a variant-specific label is needed.
- New backend commands should reuse the existing variant that matches their domain rather than introducing new `Other` errors.
