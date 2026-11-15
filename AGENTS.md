# HyperCom 开发指南

> 本文件与各目录 `AGENTS.md` 只保留当前有效的导航、跨模块硬规则和操作要求。引用使用“文件 + 符号名”，不写行号；实现变化时同步路径与符号。模块行为细节放在 [`docs/architecture/`](docs/architecture/README.md)，插件作者接口放在 [`docs/plugin-development.md`](docs/plugin-development.md)。

## 项目速览

HyperCom 是由 React/TypeScript 前端、Rust/Tauri 后端组成的串口调试工具。

- `src/main.tsx`、`src/App.tsx`：前端入口；`App` 装配启动、接收、工具输出等全局生命周期。
- `src/stores/`：Zustand 状态；`src/hooks/`：React 与 Tauri 生命周期；`src/services/`：Tauri 服务封装；`src/utils/`：共享纯函数和引擎。
- `src/components/`：主显示区、配置、发送区、侧边栏、弹窗和共享控件。
- `src-tauri/src/lib.rs`、`src-tauri/src/main.rs`：Tauri 状态、命令注册和启动；`src-tauri/src/commands/`：命令实现。
- `docs/architecture/`：模块架构；`docs/userwiki/`：用户手册；`.github/workflows/`：CI 与发布流程。

工作区标签类型在 `src/types/index.ts` 的 `TabItem`：serial 标签用 `portId`，plugin 标签用 `boundPortId`，replay 标签没有发送端口；标签 `id` 只是工作区身份。端口身份解析统一使用 `src/stores/useAppStore.ts` 的 `getTabPortId` / `getActivePortId`。

## 常用验证

```bash
npm run build
npm run test:run
npm run e2e
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path src-tauri/Cargo.toml --release --lib
```

按改动范围运行对应检查；前端构建还会执行 TypeScript 检查。Playwright 使用 mock IPC，不等同于真实串口、原生 WebView/CSP 或最终安装包验收。Windows PowerShell 若拦截 `npm`，使用 `npm.cmd`。

## 跨模块硬规则

1. **Zustand 使用 selector**：组件和 hook 订阅具体字段；回调或 effect 需要最新值时使用 `useXxxStore.getState()`。高频监听器不得订阅整 store。
2. **复用单一实现**：数值边界用 `src/utils/bounds.ts` 与 `src-tauri/src/config/mod.rs` 的 `CONFIG_BOUNDS`；字节文本用 `src/utils/lineText.ts` 的 `createDecoder` / `decodeBytes`；HEX 输入用 `src/utils/hexUtils.ts`，字节转 HEX 用 `src/utils/hexFormat.ts`；互斥选择用 `src/components/shared/SegmentedControl.tsx`；弹窗键盘与焦点用 `src/components/shared/useDialogLifecycle.ts`；树算法用 `src/utils/paneTree.ts`。
3. **配置保存走统一队列**：编辑草稿由 `src/utils/entityEditor.ts` 管理，持久化由 `src/utils/configWriteQueue.ts` 的 `enqueueConfigWrite` 和 revision CAS 串行完成；成功后才推进基线和运行态，失败、冲突或迟到响应不能覆盖新草稿。
4. **Rust 命令契约**：命令返回 `Result<T, CommandError>`，错误映射保持领域变体；新增命令同时注册到 `src-tauri/src/lib.rs` 的 `generate_handler!`。不要以 `Result<T, String>` 作为命令错误类型；`std::sync::MutexGuard` 不得跨 `.await`。日志设置统一由 `AppState::apply_runtime_config` 应用，命令层不要给 `LogManager` 包外层 mutex。
5. **串口发送与生命周期**：TRX 发送统一走 `src/hooks/useSerialSend.ts` 的 `sendToPort`；TTY 键盘、文件发送等旁路必须自行执行连接代次、流程独占和统计边界。RX 由 `src/hooks/useSerialReceive.ts` 的 `useSerialReceive` → `src/utils/rxPipeline.ts` 的 `getRxPipeline` → `src/utils/terminal/viewportManager.ts` 批量写入；主应用只装配一次 `useSerialReceive`，`getRxPipeline` 和 `src/utils/ttyService.ts` 的 `ttyService` 是 webview 生命周期单例，清理端口使用 `disconnect`，不可 `dispose`。
6. **标签关闭不等于断开**：`src/components/MainDisplay/Pane.tsx` 的 `cleanupClosedTab` 负责关闭清理，批量范围使用 `src/stores/useAppStore.ts` 的 `getClosingTabIds`；显式断开走 `src/hooks/useSerialConnection.ts` 的 `useSerialConnection.closePort`。显示状态和缓冲只在对应标签消费者退休时回收。
7. **插件身份与快照**：安装身份是 `installGeneration`，不是安装时间；需要用户确认的启用、授权、重载操作带 `expectedGeneration`。插件配置只接受 `src/utils/pluginConfigSnapshot.ts` 的后端带 revision 快照，旧快照不得恢复权限；插件通知走 `src/stores/useToastStore.ts` 的 `pushPlugin`。
8. **编辑器与界面**：规则页面使用 `src/components/ConfigModal/hooks/useEntityPage.ts` 的 `useEntityPage({ kind })` 会话草稿并显式保存；关闭审批经过共享生命周期和 `complete_editor_close`。React 组件定义在模块级；终端纵向 flex 链每层保留 `min-height: 0`。
9. **国际化与未信任颜色**：`src/i18n.ts` 的 zh-CN/en-US 保持键集合、顺序和占位符一致，协议词不翻译。进入 HTML style 的规则颜色必须经 `src/utils/cssColor.ts` 的 `safeCssColor`。
10. **先查复用索引**：跨模块改动先看 [`docs/architecture/code-map.md`](docs/architecture/code-map.md)，禁止重复实现 pane tree、解码、HEX、边界、缩放或顺序调度逻辑。

## 易错契约

- HEX 忽略空白后仍须是偶数位且全部为十六进制字符；非法输入是错误态，不补零。
- 普通 RX 行保存 `rawData`，渲染、搜索和复制按当前编码惰性解码；编码切换前先按旧编码冲刷 RX 管线尾部。
- `appendTerminalLines` 是环形缓冲批入口；超出 `maxDisplayLines` 时逐行覆盖最旧行，不添加额外字节预算或清屏提示。
- 循环发送在启动时固定目标端口，不随焦点漂移；发送历史与循环运行态只在前端内存。
- 端口轮询使用 `mergePorts`，连接状态的保留和消失端口宽限以实现与测试为准，不在指南中复制易漂移数字。
- 原生插件视图按 instance/document/epoch 丢弃迟到消息；二进制使用 `view.sendBinary` 的分块与 ACK，不塞进实时状态 JSON。

## 任务导航

| 任务 | 先看 |
|---|---|
| store、hook、配置保存 | [`src/stores/AGENTS.md`](src/stores/AGENTS.md)、[`src/hooks/AGENTS.md`](src/hooks/AGENTS.md)、[`docs/architecture/config.md`](docs/architecture/config.md) |
| Tauri 命令 | [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md)、[`docs/architecture/errors.md`](docs/architecture/errors.md) |
| 串口与参数 | [`docs/architecture/serial.md`](docs/architecture/serial.md) |
| TRX 终端与时间联动 | [`docs/architecture/terminal.md`](docs/architecture/terminal.md)、[`src/utils/terminal/AGENTS.md`](src/utils/terminal/AGENTS.md)、[`docs/architecture/timeline.md`](docs/architecture/timeline.md) |
| TTY、发送、循环、触发、文件 | [`docs/architecture/tty.md`](docs/architecture/tty.md)、[`docs/architecture/transmission.md`](docs/architecture/transmission.md)、[`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md) |
| 日志、更新、发布 | [`docs/architecture/logging.md`](docs/architecture/logging.md)、[`docs/architecture/update.md`](docs/architecture/update.md)、[`docs/architecture/release.md`](docs/architecture/release.md) |
| 分屏、标签、弹窗、回放 | [`docs/architecture/workspace.md`](docs/architecture/workspace.md)、[`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md) |
| 配置页面 | [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md) |
| 插件与原生视图 | [`docs/architecture/plugins.md`](docs/architecture/plugins.md)、[`docs/architecture/plugin-views.md`](docs/architecture/plugin-views.md)、[`docs/plugin-development.md`](docs/plugin-development.md) |
| 跨模块符号 | [`docs/architecture/code-map.md`](docs/architecture/code-map.md) |

## 提交

```text
type(scope): description
```

`type` 使用 `feat | fix | docs | style | refactor | perf | test | chore`；`scope` 使用实际受影响的 `ui | backend | store | hooks | docs` 等范围。

## Tauri 边界

前端通过 `@tauri-apps/api` 的 `invoke` 调后端命令，后端通过 `app.emit` 发事件。修改 Tauri 依赖时同时核对 `package.json` 与 `src-tauri/Cargo.toml`/锁文件的兼容性。

## 子目录指南

- [`src/stores/AGENTS.md`](src/stores/AGENTS.md)
- [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md)
- [`src/utils/terminal/AGENTS.md`](src/utils/terminal/AGENTS.md)
- [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md)
- [`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md)
- [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md)
- [`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md)

## 文档索引

- [`docs/architecture/README.md`](docs/architecture/README.md)：架构文档索引。
- [`docs/userwiki/README.md`](docs/userwiki/README.md)：用户手册。
- [`docs/architecture/conventions.md`](docs/architecture/conventions.md)：跨模块约定展开。
- [`docs/plugin-development.md`](docs/plugin-development.md)：插件开发接口。
