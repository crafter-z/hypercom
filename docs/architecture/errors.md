# 错误处理（CommandError）

后端所有 Tauri 命令返回 `Result<T, CommandError>`，不得返回 `String`。`CommandError` 是 thiserror 枚举，定义于 `src-tauri/src/commands/mod.rs`，手动实现 `serde::Serialize`——前端经 `invoke` 收到的是格式化后的错误字符串。

## 变体定义

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

## 映射表

| 变体 | 错误格式 | 触发条件 | i18n key |
|------|---------|---------|----------|
| `Serial` | `Serial error: {details}` | `commands/serial.rs`（list ports / open / close / send / set params / set flow control / attempt reconnect）、`commands/simulation.rs`（close sim port）。包装 `serial/mod.rs` 错误 | `toast.error.serial` |
| `Config` | `Config error: {details}` | `commands/config.rs`（set / reset config）。包装 `config::ConfigManager` 持久化错误 | `toast.error.config` |
| `Log` | `Log error: {details}` | `commands/log.rs`（set directory / save as / export / list files / start / stop logging / open path）。包装 `logger` 错误 | `toast.error.log` |
| `Storage` | `Storage error: {details}` | `commands/storage.rs` 各 CRUD（命令集/高亮集/协议模板/触发规则/端口预设/工具配置/分组/端口元数据）。包装 `config::ConfigManager` 持久化错误（SQLite 已于 2026-08 移除，现为 config.json 实体 CRUD） | `toast.error.storage` |
| `System` | `System error: {details}` | `commands/system_cmds.rs`（prevent screen off / prevent sleep）。包装 Win32 `SetThreadExecutionState` 失败 | `toast.error.system` |
| `Lock` | `Lock error: {details}` | 任何对 `AppState` 获取 `std::sync::Mutex` 的 Tauri 命令（serial/config/log/simulation/storage 全部持锁命令） | `toast.error.lock` |
| `Io` | `IO error: {details}` | `commands/log.rs`（canonicalize export parent / log root / target、写导出文件、spawn explorer/open/xdg-open） | `toast.error.io` |
| `Other` | `{details}` | `commands/log.rs`（export path 无父目录）。无领域可归属的校验失败兜底 | `toast.error.other` |

## i18n

`src/i18n.ts` 中 zh-CN/en-US 双侧均定义了上述 8 个 `toast.error.*` key，保证每个变体有稳定翻译键。

## 消费路径

- `CommandError` 手动序列化为普通字符串，前端收到形如 `"Serial error: Port COM3 is not available"` 的消息。
- `notifyError()`（`src/stores/useToastStore.ts`）提取消息原样展示；`toast.error.*` 键在需要变体级标签时作结构化兜底。
- **新增后端命令应复用匹配其领域的既有变体，而非引入新的 `Other` 错误。**
