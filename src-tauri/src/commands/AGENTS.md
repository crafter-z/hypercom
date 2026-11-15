# `src-tauri/src/commands/`

Tauri 命令按领域分文件；`mod.rs` 汇总导出 `CommandError` 和各领域命令，`wire_shape.rs` 只保存 IPC 形状测试契约。所有命令返回 `Result<T, CommandError>`。

## 导航

| 文件 | 主要入口 |
|---|---|
| `serial.rs` | 端口枚举、打开/关闭、发送、文件发送、串口参数、流控、重连、外部工具和取消文件发送 |
| `simulation.rs` / `tty_sim.rs` | 开发构建的虚拟端口与 GIT:BASH 模拟终端；入口统一由 `system_cmds::dev_only` 门控 |
| `config.rs` | `get_config`、`set_config`、会话快照和配置路径；`set_config` 通过 `AppState::apply_runtime_config` 应用运行时设置 |
| `storage.rs` | 命令集、高亮集、协议模板、预设、工具配置、触发规则、端口分组和端口元数据的 CRUD |
| `log.rs` / `diag.rs` | 日志生命周期、日志文件操作、诊断日志读写清理 |
| `system_cmds.rs` | 系统状态、电源管理和编辑器关闭审批 |
| `file.rs` | 宿主文件选择、文本/图片读取、插件文件目录授权与操作、回放源授权和分块读取 |
| `plugin.rs` | 插件安装、升级、卸载、启停、权限、信任、资源、原生视图和外部打开 |
| `plugin_http.rs` | 插件 HTTP 请求的打开、读取、取消和取消传播 |
| `popout.rs` | 弹窗创建、关闭和置顶；标签由 Rust 的 `sanitize` / `compute_label` 计算 |
| `update.rs` | 更新检查、通道选择、下载和安装 |

## 必守规则

- 新命令必须在所属模块公开、由 `mod.rs` 重导出，并注册到 `src-tauri/src/lib.rs` 的 `generate_handler!`；不要在前端直接 `invoke` 字符串，使用 `src/services/` 封装。
- 使用匹配领域的 `CommandError` 变体；不要返回 `Result<T, String>`。错误映射应保留可诊断信息，不把权限、忙碌或 I/O 错误伪装成“缺失资源”。
- `std::sync::MutexGuard` 不得跨 `.await`；先提取或 clone 必要数据并释放 guard，再 await。`AppState::log_manager` 已是 `Arc<LogManager>`，不要再包一层锁。
- 配置和实体命令直接经过 `ConfigManager`；日志设置唯一由 `AppState::apply_runtime_config` 应用，不新增逐字段日志设置命令。
- 串口路由使用 `serial::PortKind::of`；连接代次检查在执行参数变更、发送或重连时保持。阻塞 I/O 不应占用 Tauri 命令线程。
- `dev_only()` / `is_debug_build()` 是构建能力门控的统一实现；不要为同一命令写两套 `#[cfg(debug_assertions)]` 主体。
- 文件和目录访问必须由宿主选择器、安装身份、权限和路径围栏共同授权；目录读写权限分离，每次操作重新校验，拒绝链接、重解析点和路径逃逸。回放只使用窗口授权和分块读取，不接受任意路径。
- 插件身份使用 `installGeneration`，不是安装时间。涉及启用、授权、信任或重载的操作带 `expectedGeneration`；列表和变更响应带 revision，旧响应不得恢复授权。插件事务恢复和信任重置保持在配置目录的持久化状态中。
- 插件 HTTP 请求在打开、读取和交付前重新校验权限与安装代次；禁用、撤权、卸载、替换或重载时取消所属请求。不要在命令层添加隐式正文截断或业务配额。
- `open_popout` 保持异步创建；业务参数只传 `kind` 和 `targetId`，不在前端复制窗口 label 规则。
- 主窗口和托盘关闭都先经过 `editor:close-requested`；仅 `complete_editor_close` 可批准关闭流程。主窗口保留拖动能力但不授予直接销毁能力，弹窗才使用 destroy 能力。

## 常用检查

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path src-tauri/Cargo.toml --release --lib
```

## 反模式

- 跨 await 持有标准 mutex guard。
- 用 `eprintln!` 代替 `log` crate；绕过服务层直接调用命令；新增命令却不更新 `generate_handler!`。
- 把 `installGeneration` 当成时间戳，或把旧 revision/旧安装身份的结果写回当前状态。
- 放宽路径、权限、窗口关闭审批或插件网络取消边界。
