# 架构文档索引

本文档集只描述当前实现、跨模块契约和验证边界。模块文档中的路径与符号名以源码为准；用户操作见 [`docs/userwiki/`](../userwiki/README.md)，插件作者接口见 [`docs/plugin-development.md`](../plugin-development.md)。

## 系统边界

```text
Tauri 应用壳
├─ React/TypeScript：App、Zustand store、hooks、services、终端与工作区
└─ Rust：AppState、Tauri commands、串口、配置、日志、插件与更新

前端 ── invoke / emit ── Rust
```

前端的状态、生命周期和复用模块见 [`config.md`](config.md)、[`workspace.md`](workspace.md) 与 [`code-map.md`](code-map.md)。Rust 命令统一由 `src-tauri/src/lib.rs` 的 `generate_handler!` 注册，错误契约见 [`errors.md`](errors.md)。

## 文档清单

| 文档 | 当前覆盖范围 |
|---|---|
| [`serial.md`](serial.md) | 端口枚举、连接生命周期、参数/流控、读写句柄、SIM/GIT:BASH 虚拟端口、外部工具和排序分组 |
| [`collaboration.md`](collaboration.md) | `hypercom-protocol`、`hypercomctl` CLI/MCP、本地 IPC 与 TLS 1.3 远端宿主/客户端、`PortLeaseRegistry` 与远端能力门控 |
| [`terminal.md`](terminal.md) | TRX 的 `TerminalBuffer`、`TerminalRenderer`、`viewportManager`、滚动/搜索/编码/高亮与协议字段显示 |
| [`timeline.md`](timeline.md) | `timelineCoordinator`、preview/commit 定位、调度预算、TRX/插件适配器及只读多轨回放 |
| [`tty.md`](tty.md) | xterm.js TTY、`ttyService`、TRX/TTY 切换和 GIT:BASH 调试终端 |
| [`transmission.md`](transmission.md) | RX 管线、`sendToPort`、TTY/文件发送、循环发送、快捷发送、命令步骤和触发器 |
| [`logging.md`](logging.md) | `LogManager` 落盘、日志迁移/分片/编码、连接代次和 `DiagLogger` |
| [`config.md`](config.md) | `AppConfig`/`Entities`、会话快照、store 划分、实体草稿、保存队列、CAS 和数值边界 |
| [`workspace.md`](workspace.md) | pane tree、标签、弹窗、通知、侧边栏、状态栏、背景和文本右键菜单 |
| [`update.md`](update.md) | stable/preview 更新检查、网络策略、安装流程和前端决策流 |
| [`plugins.md`](plugins.md) | 插件安装身份、权限/快照、Worker、市场索引/更新、HTTP/KV/文件、事务恢复和 RX 旁路 |
| [`plugin-views.md`](plugin-views.md) | 隔离原生视图、可信网页、工作区标签、文档代次、二进制通道和输入生命周期 |
| [`release.md`](release.md) | CI 质量门、stable/preview 发布工作流、清单/签名校验和原生验收边界 |
| [`errors.md`](errors.md) | `CommandError` 变体、命令归属和前端错误消费路径 |
| [`conventions.md`](conventions.md) | selector、React/flex、Rust 锁、hook、i18n、输入安全和平台约定 |
| [`code-map.md`](code-map.md) | 前端/后端符号定位及应复用的单一实现 |

## 跨模块不变量

- **状态订阅**：Zustand 组件和 hook 只用 selector；实时值在回调中用 `getState()`。终端行缓冲由 `viewportManager`/`TerminalBuffer` 管理，不进入 store。
- **单一实现**：边界用 `src/utils/bounds.ts` 与 `src-tauri/src/config/mod.rs` 的 `CONFIG_BOUNDS`；文本解码用 `src/utils/lineText.ts`；HEX 输入用 `src/utils/hexUtils.ts`，字节格式化用 `src/utils/hexFormat.ts`；树算法用 `src/utils/paneTree.ts`。
- **配置保存**：普通设置和实体草稿经 `src/utils/configWriteQueue.ts` 的 `enqueueConfigWrite` 串行写入，并用 revision CAS；成功才推进基线与运行态，失败/冲突/迟到响应不得覆盖新草稿。
- **命令与事件**：Tauri 命令返回 `Result<T, CommandError>`，新命令必须在 `src-tauri/src/lib.rs` 注册；Rust 的 `FileProgressPayload` 使用 camelCase wire。`serial:data` 传原始字节，接收管线只在 `App` 装配一次。
- **工作区身份**：`TabItem.id` 是工作区 UUID；串口目标来自 `getTabPortId`/`getActivePortId`，plugin 使用 `boundPortId`，replay 没有发送端口，不做 last-port 回退。远端端口使用 `PortRef` 格式 `remote::<profileId>::<portId>`，能力边界由 `src/utils/portCapabilities.ts` 与服务端 `Actor::check_access` 共同约束。
- **生命周期**：关闭标签不等于断开串口；`Pane.cleanupClosedTab` 只退休显示/输入消费者。显式断开走 `useSerialConnection.closePort`。插件视图按 instance/document/epoch 丢弃迟到消息，二进制走分块与 ACK，不进入实时状态 JSON。
- **安全输入**：用户颜色经 `safeCssColor`，正则经 `safeRegex`；插件文件/权限/原生视图由宿主重新校验，不能信任 Worker 或页面自报身份。

## 验证边界

常规检查命令见根 [`AGENTS.md`](../../AGENTS.md)。Vitest、Rust 库测试、Clippy、release-profile 检查和 mock IPC Playwright 覆盖源码契约；它们不替代真实串口、原生 WebView/CSP 或最终安装包验收。插件原生视图的 Windows/WebView2 显式测试与安装包边界见 [`plugin-views.md`](plugin-views.md) 和 [`release.md`](release.md)。

## 引用规则

架构文档只引用“文件 + 符号名”，不写行号；实现变更时同步路径、符号名和本索引。过程记录、审计清单、历史设计和用户操作步骤不放在本目录。

## 快速导航

- 串口与收发：[`serial.md`](serial.md) → [`transmission.md`](transmission.md)
- 协作、CLI/MCP 与远端：[`collaboration.md`](collaboration.md)
- TRX/TTY/回放：[`terminal.md`](terminal.md)、[`tty.md`](tty.md)、[`timeline.md`](timeline.md)
- 配置与工作区：[`config.md`](config.md)、[`workspace.md`](workspace.md)
- 插件：[`plugins.md`](plugins.md)、[`plugin-views.md`](plugin-views.md)
- 发版与更新：[`release.md`](release.md)、[`update.md`](update.md)
- 复用与约定：[`code-map.md`](code-map.md)、[`conventions.md`](conventions.md)

(End of file)
