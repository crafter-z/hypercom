# 错误处理（CommandError）

所有 `#[tauri::command]` 返回 `Result<T, CommandError>`，命令不得使用 `Result<T, String>`。`CommandError` 定义于 `src-tauri/src/commands/mod.rs`，实现 `thiserror::Error` 和字符串形式的 `serde::Serialize`；前端 `invoke` 收到格式化错误字符串。命令之外的串口、配置、日志和系统模块保留各自错误类型，由命令层映射到领域变体。

## 变体

```rust
pub enum CommandError {
    Serial(String),
    Config(String),
    Log(String),
    System(String),
    Lock(String),
    Io(String),
    Other(String),
}
```

- `Serial`：串口枚举、开关、发送、重连、流控、外部工具、SIM 与 GIT:BASH 模拟终端命令，以及远程控制/租约相关串口错误；底层实现位于 `src-tauri/src/serial/` 与 `src-tauri/src/control/`。
- `Config`：`set_config`、会话快照、实体 CRUD 和插件配置持久化失败；实体存储位于 `src-tauri/src/commands/storage.rs`，配置模型位于 `src-tauri/src/config/mod.rs`。
- `Log`：日志目录、writer、迁移、导出和打开路径操作；实现位于 `src-tauri/src/commands/log.rs`。
- `System`：电源抑制、编辑器关闭审批和弹窗创建/销毁/置顶；实现位于 `src-tauri/src/commands/system_cmds.rs` 与 `src-tauri/src/commands/popout.rs`。
- `Lock`：命令访问 `AppState` 中同步锁失败。`AppState.log_manager` 是 `Arc<LogManager>`，没有外层 mutex，不返回该变体。
- `Io`：文件对话框、文件/日志读写、外部工具进程、插件安装资产与远端客户端配置文件读写（`profile_io`）等 I/O 失败。
- `Other`：没有明确领域的参数、生命周期、任务 join、更新网络失败或控制面鉴权/参数校验失败（如 `commands/control.rs` 的 `map_host_error` 对 `invalid_request` / `invalid_invite` / `pin_mismatch` / `unauthorized` / `revoked` / `forbidden` 的映射）；调用方应优先复用匹配领域变体。

`commands/file.rs` 的 `read_image_data_url` 是软失败接口：空路径、缺失、扩展名不支持、超限或读取失败返回空字符串并记录 warn，前端将空字符串解释为无背景图，不转成命令错误。

## 前端消费

服务层只转发 `invoke`，不拆解错误前缀。`src/stores/useToastStore.ts` 的 `extractErrorMessage` 从字符串、`Error` 或 `{message}` 提取文本；
otifyError` 在文本为空时使用 `toast.fallback.operationFailed`，再以错误级别推入通知。

`src/i18n.ts` 不按 `CommandError` 变体维护翻译键。`toast.severity.*` 只表示通知级别；确实需要用户化失败文案的调用点显式传入 fallback key，例如更新安装使用 `update.installFailed`。

串口重连取消属于 `Serial` 错误域：`src-tauri/src/commands/serial.rs` 的 `attempt_reconnect` 在用户关闭、显式打开或新重连取代时返回取消结果，调用方按当前意图结束旧尝试，不补偿关闭新连接。

规则实体保存失败时，`src-tauri/src/config/mod.rs` 的配置写入恢复完整旧 `AppConfig` 与 revision；`get_config` 和后续无关保存不会暴露失败修改。新命令在对应域文件实现、映射匹配领域错误，并登记到 `src-tauri/src/lib.rs` 的 `generate_handler!`。

(End of file)
