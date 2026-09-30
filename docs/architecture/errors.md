# 错误处理（CommandError）

命令层的所有 Tauri 命令（`#[tauri::command]`）返回 `Result<T, CommandError>`，不得返回 `String`。`CommandError` 是 thiserror 枚举，定义于 `src-tauri/src/commands/mod.rs`，手动实现 `serde::Serialize`——前端经 `invoke` 收到的是格式化后的错误字符串。

命令层之外的模块各用自己的错误类型：`system.rs` 电源适配层返回 `Result<(), String>`，`serial/` / `logger/` / `config::ConfigManager` 返回 `anyhow::Result`（一律经 `e.to_string()` 落进对应变体）——这些都由命令层 `map_err` 收敛为 `CommandError`。

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
    #[error("System error: {0}")]
    System(String),
    #[error("Lock error: {0}")]
    Lock(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.to_string().as_ref())
    }
}
```

> 旧的 `Storage` 变体已删除：`commands/storage.rs` 各实体的持久化失败统一走 `Config`（存储即 config.json 实体 CRUD），加锁失败走 `Lock`。

## 映射表

| 变体 | 错误格式 | 触发条件（命令 / 文件） |
|------|---------|------------------------|
| `Serial` | `Serial error: {details}` | `commands/serial.rs`：`list_available_ports` / `open_serial_port` / `close_serial_port` / `send_serial_data` / `send_file` / `set_serial_params` / `attempt_reconnect` / `set_flow_control` / `run_port_tool`；`commands/simulation.rs`：`disable_simulation`（关模拟端口）；`commands/tty_sim.rs`：`disable_gitbash_sim` / `resize_gitbash_sim`；`commands/system_cmds.rs`：`dev_only(capability)` 门控（release 构建下拒绝模拟串口 / Git Bash 模拟终端等调试能力）。包装 `serial/` 各模块错误 |
| `Config` | `Config error: {details}` | `commands/config.rs`：`set_config` / `update_session_snapshot`；`commands/storage.rs`：各实体 `save_*` / `delete_*`（经共享助手 `save_entity` / `delete_entity` → `mutate_config` → `mutate`）落盘失败。包装 `config::ConfigManager` 持久化错误 |
| `Log` | `Log error: {details}` | `commands/log.rs`：`save_log_as` / `export_terminal_log` / `get_log_files` / `start_logging` / `stop_logging` / `open_path`（路径越出日志目录、目标不存在）/ `open_log_directory`（内部即 `open_path`）/ `migrate_log_directory`（旧目录不存在）。包装 `logger` 错误 |
| `System` | `System error: {details}` | `commands/system_cmds.rs`：`prevent_screen_off` / `prevent_sleep`（包装 `system.rs` 的 Win32 `SetThreadExecutionState` / 子进程后端失败）；`commands/popout.rs`：`open_popout` / `close_popout` / `set_popout_always_on_top` 的建窗、销毁、置顶失败 |
| `Lock` | `Lock error: {details}` | 任何对 `AppState` 内 `Mutex` 字段加锁失败的 Tauri 命令（`serial` / `simulation` / `tty_sim` / `config` / `storage` / `log` / `popout` 的持锁路径）。注意 `log_manager` 是 `Arc<LogManager>`、无外层 `Mutex`，其写路径不发 `Lock` 错误 |
| `Io` | `IO error: {details}` | `commands/file.rs`：`write_text_file` / `read_text_file` 的 canonicalize 与读写；`commands/log.rs`：canonicalize 父目录 / 写导出文件 / 建·读迁移目录 / spawn `explorer`·`open`·`xdg-open`（`open_log_directory` 走同一路径）；`commands/serial.rs`：`send_file` 的 stat 与读文件、`run_port_tool` 的 spawn / 取管道 / 等待 / 杀进程 |
| `Other` | `{details}` | 无领域可归属的失败：`serial.rs` / `system_cmds.rs` 的 `spawn_blocking` 任务 panic / join 失败；`file.rs` / `log.rs` 的「路径无父目录」；`popout.rs` 的未知 kind、找不到弹窗窗口；`tty_sim.rs` 的找不到 git bash、join 失败；`update.rs` 的 endpoint 解析、GitHub API 请求·解析、updater 构建、更新检查与安装失败 |

> 例外：`commands/file.rs::read_image_data_url`（自定义背景图）虽是 `Result<String, CommandError>`，但契约上**软失败**——路径为空 / 文件不存在 / 扩展名不支持 / 超过大小上限 / 读取失败一律返回空字符串并记 warn，前端按「空串 = 无背景图」判定。这些分支不得改成 `Err`（有单测钉住）。

## i18n

前端**没有**按变体拆分的 `toast.error.*` 翻译键——后端消息（英文）经 `invoke` 抛出后原样展示。i18n 只提供两类相关键：

- `toast.severity.error` / `toast.severity.warning` / `toast.severity.success` / `toast.severity.info`：Toast 与通知中心的**级别标签**（`NotificationCenter.tsx`）。
- `toast.fallback.operationFailed`：`notifyError` 在提取到的消息为空/纯空白时的兜底文案。

因此新增变体**不**需要在 `src/i18n.ts` 登记；只有确实要面向用户翻译的失败文案才走 `notifyError(e, '<key>')` 的显式 fallback（现有唯一用例：`UpdateDialog` 的 `update.installFailed`）。

## 消费路径

- `CommandError` 手动序列化为普通字符串，前端收到形如 `"Serial error: Port COM3 is not available"` 的消息。
- `src/services/*.ts` 各域 service 只转发 `invoke`，不做错误包装、也不做前缀解析——**不存在统一的 `CommandError` 解析约定**。调用方 `catch` 后交 `src/stores/useToastStore.ts`：
  - `extractErrorMessage(e)`：字符串原样返回；`Error` 取 `message`；对象取 `message` 字段；其余 `String(e)`。
  - `notifyError(e, fallbackKey = 'toast.fallback.operationFailed')`：提取并 `trim`，为空则用翻译后的 fallback，再以 `severity: 'error'` 推入 toast（`notifySuccess` / `notifyInfo` 同理，但收的是 i18n key）。
- **新增后端命令应复用匹配其领域的既有变体，而非引入新的 `Other` 错误。**
