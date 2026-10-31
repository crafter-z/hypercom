# HyperCom — Agent 指南

**栈：** Tauri v2 (2.11.x) + React 18 + Rust (tokio + serialport) · **对齐代码：** 2026-10-29

> **引用纪律**：本文只写「文件 + 符号名」，**不写行号**。行号随每次重构必然腐化，是上一轮审计整片漂移的根因。
> **数字断言**（命令数 / 配置字段数 / i18n 键数 / hook 数 / store 数 / services 文件数）以代码为准；改动后同步本文件与 [`docs/architecture/README.md`](docs/architecture/README.md)。
> **内容分工**：本文件只保留 agent 高频需要的**导航 + 跨模块硬规则**。模块架构与行为细节在 [`docs/architecture/`](docs/architecture/README.md)；插件作者接口在 [`docs/plugin-development.md`](docs/plugin-development.md)。文档只维护当前状态、行为契约与操作要求，不新增评审报告、审计处置清单、历史设计或执行过程记录。

## 项目速览

HyperCom — 现代串口调试工具。Rust 管 I/O，React 管 UI。

- **前端**：6 个 Zustand store；`src/hooks/` 18 个 hook 文件（另有 barrel `index.ts` 与 `disconnectTracking.ts`；`shared/` 下 hook 不计入）；14 个 services 生产文件；i18n 705 键 × zh-CN/en-US。
- **后端**：13 个命令域文件 + `CommandError`，`lib.rs` 注册 89 个命令（漂移守卫测试核对）；`AppConfig` 44 字段 = 43 个普通字段 + 1 个 `#[serde(flatten)] entities: Entities`（含 9 类实体数组）。
- **工作区**：标签 `TabItem = SerialTabItem | PluginTabItem | ReplayTabItem`，`id` 为 UUID；serial 的 `portId` / plugin 的 `boundPortId` 才是端口身份，replay 无发送端口。
- **时间联动**：`utils/timeline` 是组与热游标唯一来源；主窗口 TRX/可选插件/只读回放共用 preview/commit 协议，TTY 与跨弹出窗不参与；不得同步 scrollTop 或把回放追加进实时缓冲。详见 [`timeline.md`](docs/architecture/timeline.md)。
- **规则实体**：高亮/命令/协议/工具/提醒五类运行态在 `useRuleStore`，编辑草稿在 `utils/entityEditor.ts`，已保存配置是持久化基线；保存链路见 [`config.md`](docs/architecture/config.md)。

## 仓库布局

```text
hypercom/
├── src/                      # React 前端
│   ├── main.tsx / App.tsx    # entrypoints（App.tsx = AppInit + SerialReceive + 全局文本右键菜单）
│   ├── i18n.ts               # 705 键 × zh-CN/en-US（扁平 dotted key，keySeparator:false）
│   ├── services/             # tauri.ts barrel + 13 域（含 plugin / pluginView）
│   ├── hooks/                # 18 个 hook 文件 + barrel
│   ├── stores/               # 6 个 store + releaseTerminalState / resetStores
│   ├── utils/                # 纯函数与引擎；utils/terminal/ = 方案B 终端引擎
│   ├── types/index.ts
│   └── components/           # MainDisplay / ConfigModal / OperationPanel / Sidebar / TitleBar / StatusBar / Popout / shared
├── src-tauri/src/            # Rust 后端
│   ├── main.rs / lib.rs      # AppState + generate_handler! + setup
│   ├── system.rs / diaglog.rs / update_network.rs
│   ├── serial/ logger/ config/ plugin/(+view_runtime/)
│   └── commands/             # 13 个命令域 + mod.rs(CommandError) + wire_shape.rs(测试契约)
├── docs/                     # architecture/（模块架构）+ userwiki/ + plugin-development.md
└── .github/workflows/        # ci.yml（质量门）+ publish.yml / publish-preview.yml
```

## 构建与验证

```bash
npm run tauri dev                                   # 全应用
npx tsc --noEmit                                    # 仅前端类型检查
cargo check --manifest-path src-tauri/Cargo.toml    # 仅 Rust
```

日常质量门（`.github/workflows/ci.yml`）：`npx tsc --noEmit` → `npm run test:run`（Vitest）→ `cargo test --lib --manifest-path src-tauri/Cargo.toml` → Playwright e2e。提交前两侧检查都要过。Windows PowerShell 下 `npm` 可能被执行策略拦截，用 `cmd /c "npm run tauri dev"`。

## 必守规则（跨模块，违反会出事故）

1. **Zustand 只带 selector**：任何 store 调用必须订阅具体字段；无 selector 订阅整 store 会让每个串口事件触发重渲染（输入失焦/卡顿）。hook 内取实时值用 `getXxxStore.getState()`。store 职责表见 [`config.md`](docs/architecture/config.md)，展开说明见 [`conventions.md`](docs/architecture/conventions.md)。
2. **单一来源，不造第二份实现**：
   - 数值边界：Rust `config/mod.rs` 的 `CONFIG_BOUNDS` 是唯一表（`validate_and_clamp` / `clamp_bound`），前端 `utils/bounds.ts` 镜像，`bounds.test.ts` 解析两侧源文本逐项断言。
   - bytes→文本：`utils/lineText.ts` 的 `createDecoder` / `decodeBytes`（唯一 TextDecoder 工厂，`ignoreBOM: false`）。
   - bytes→HEX：`utils/hexFormat.ts`（`hexByte` / `bytesToSpacedHex`）。
   - 端口类别：`serial::PortKind::of`；虚拟端口门控 `check_virtual_enabled` 在分派之前。
   - 调试能力：`commands/system_cmds.rs` 的 `dev_only()` / `is_debug_build()`（命令体不写 `#[cfg(debug_assertions)]` 双主体）。
   - 日志设置：`LogSettings::from_config` + `LogManager::apply_settings`，经 `AppState::apply_runtime_config` 由启动与 `set_config` 共用；无逐字段 `set_log_*`。
3. **配置写入三层 + CAS**：`useAppStore.config` 是持久化基线，`useRuleStore` 是已提交运行态，`utils/entityEditor.ts` 是会话草稿。所有配置/实体/元数据写经 `configWriteQueue` 串行 + revision CAS；保存成功才推进基线与运行态，失败/冲突保留草稿，迟到响应不覆盖新编辑。
4. **Rust 命令**：一律返回 `Result<T, CommandError>`（变体与映射见 [`errors.md`](docs/architecture/errors.md)），不得返回 `String`；新命令必须注册进 `lib.rs` 的 `generate_handler!`（漂移守卫测试核对）。`std::sync::MutexGuard` 不得跨 `.await`：先提取 + clone + drop，再 await；`log_manager` 是 `Arc<LogManager>`（内部细粒度锁），不要再包一层锁。
5. **工作区身份与发送目标**：`TabItem.id` 是工作区 UUID；serial 的 `portId`、plugin 的固定 `boundPortId` 才是端口身份。`getTabPortId` / `getActivePortId` 显式解析，未绑定插件标签返回 null，**没有 last-port 回退**；发送/循环固定显式端口。
6. **关闭标签 ≠ 断开串口**：`Pane.cleanupClosedTab` 先 `dismissPluginTab(tabId)` 退休插件视图，serial 标签按 `portId` detach TTY、释放 viewport、丢弃队列；端口连接与后端日志继续运行，重开标签从零开始输出。真正断开只走 `useSerialConnection.closePort()`（停日志 + 更新状态）；批量关闭用 `useAppStore.getClosingTabIds(tabId, scope)` 取同一集合。
7. **TX 唯一入口 `sendToPort`**：新增发送逻辑不得绕过（否则失去未打开端口守卫、TX 回显、流量统计与历史）。发送绑定连接 `generation`，跨重连排队的旧发送被拒绝；TTY 分支无本地回显。细节 [`transmission.md`](docs/architecture/transmission.md) / [`tty.md`](docs/architecture/tty.md)。
8. **RX 管线纪律**：`serial:data` 载原始字节 → `getRxPipeline()` 组行/rAF 批写（TTY 端口直喂 `ttyService.feed`）；`useSerialReceive` 全应用只调一次。`getRxPipeline()` / `ttyService` 是 app-lifetime 单例，cleanup 不得 dispose（断线只 `disconnect(portId)`）。生命周期拆分理由（接收/发送两个 hook 各管一端）见 [`conventions.md`](docs/architecture/conventions.md)。
9. **插件边界**：`installGeneration`（UUID）是安装身份，不是 `installedAt`；启用/授权/重载需 `expectedGeneration`；变更/列表响应带 revision，旧响应被 `pluginConfigSnapshot` 拒绝；升级清授权、trusted-web 独立授权、数据目录按插件区分。宿主细节 [`plugins.md`](docs/architecture/plugins.md)、隔离视图 [`plugin-views.md`](docs/architecture/plugin-views.md)。
10. **i18n 双侧同步**：新增文本在 `src/i18n.ts` 的 zh-CN 与 en-US 两侧同时加、保持顺序镜像；`i18n.test.ts` 断言集合相等、无重复、占位符一致。协议词（None/Even/Xon/RTS/GBK…）不翻译。
11. **CSS 颜色是未信任输入**：规则/协议模板颜色进 `innerHTML` 的 `style="color:…"` 前必须经 `utils/cssColor.ts` 的 `safeCssColor`（唯一入口），禁止各自写正则。
12. **前端组件/布局**：React 组件定义在模块级（函数内定义会每帧重建导致 DOM 销毁/输入失焦）；终端纵向 flex 链每层都要 `min-height: 0`。
13. **编辑器与关闭审批**：ConfigModal 五类实体页用 `useEntityPage({kind})` 会话草稿，显式保存（无自动保存）；取消/X/Escape/原生关闭都等待保存/放弃选择，失败保留草稿；跨窗命令编辑必须回 ACK，原生关闭经 `complete_editor_close` 审批。
14. **不重复实现**：新增/迁移模块先看 [`code-map.md`](docs/architecture/code-map.md) 的复用清单，禁止再造第二份 paneTree / hexFormat / lineText / bounds / uiScale / sequential 等。

## 易踩行为契约（近版本，速记）

- HEX 输入奇数位/非 HEX 字符是**错误态**（`sendUtils.sanitizeHexInput` / `parseHexBytes` 严格模式，不再补零）。
- 解码统一 `ignoreBOM: false`（行首 BOM 被剥离）；RX 行只存 `rawData`，渲染/搜索/复制时按当前编码惰性解码。
- 文件发送同样过 `isSendablePort` 守卫（不可发送连文件框都不弹），按增量计入 TX；成功 toast 只在 `done` 且 `sent >= total > 0` 时弹。
- 端口列表轮询用 `mergePorts`：保留 `connected` / `connecting`、**不保留 `error`**；枚举消失的会话端口最多保留 `MAX_MISSING_POLLS=3` 轮。排序意图仅本会话。
- UI 缩放 `uiScalePercent`（80–200，默认 100）独立于 `terminalFontSize` / `uiFontSize`，每个 WebView 各自 `setZoom`，已开 popout 经 `ui-scale:changed` 同步。
- 插件文件/网络**无业务配额**：`fs.write`、KV、剪贴板、Worker HTTP（`plugin_http_*`）不设大小/期限上限；权限与路径守卫保留。
- 原生视图绑定 instance + document + epoch：导航/刷新生成新 `documentId`，旧文档迟到的 ready/ACK/message/二进制块一律丢弃；`view.sendBinary` 8 KiB 分块 + ACK 背压，**不要塞进实时状态 JSON**。
- 循环发送目标启动时固定、不随聚焦漂移；发送历史与循环运行态只存在前端内存。
- `serial:file_progress` 是 camelCase wire（`{portId, transferId, sentBytes, totalBytes, done}`），`eventContract.test.ts` 从两侧源文本守卫。
- 自定义背景图（issue #13）走 `read_image_data_url` 的 data URL，不启用 asset protocol；弹窗（独立 WebView）不共享背景层，实现见 [`workspace.md`](docs/architecture/workspace.md)。

## 常见任务 → 先看哪里

| 任务 | 先看 |
|---|---|
| 新增 store 字段 / hook | [`src/stores/AGENTS.md`](src/stores/AGENTS.md) / [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) + [`config.md`](docs/architecture/config.md) |
| 新增/修改 Tauri 命令 | [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) + [`errors.md`](docs/architecture/errors.md) |
| 串口枚举/连接/参数/虚拟端口/外部工具/排序分组 | [`docs/architecture/serial.md`](docs/architecture/serial.md) |
| TRX 终端显示/滚动/搜索/编码/高亮 | [`terminal.md`](docs/architecture/terminal.md) + [`src/utils/terminal/AGENTS.md`](src/utils/terminal/AGENTS.md) |
| TTY 模式 / 模拟终端 | [`docs/architecture/tty.md`](docs/architecture/tty.md) |
| RX/TX/循环/快捷发送/命令面板/文件发送/触发 | [`docs/architecture/transmission.md`](docs/architecture/transmission.md) |
| 日志保存 / 诊断日志 | [`docs/architecture/logging.md`](docs/architecture/logging.md) |
| config.json / 实体 / 会话快照 / 数值边界 | [`docs/architecture/config.md`](docs/architecture/config.md) |
| 分屏 paneTree / 标签页 / popout / 侧边栏 / 通知 / 右键菜单 | [`docs/architecture/workspace.md`](docs/architecture/workspace.md) |
| 插件宿主 / Worker / 权限 / 原生视图 | [`plugins.md`](docs/architecture/plugins.md) + [`plugin-views.md`](docs/architecture/plugin-views.md) + [`docs/plugin-development.md`](docs/plugin-development.md) |
| 自动更新 | [`docs/architecture/update.md`](docs/architecture/update.md) |
| CI / 发版 / 签名 / 召回 | [`docs/architecture/release.md`](docs/architecture/release.md) |
| 跨平台电源管理（防休眠/防关屏） | `src-tauri/src/system.rs`（`win32_backend` / `child_process_backend`，仅 `system_cmds.rs` 调用）+ [`conventions.md`](docs/architecture/conventions.md) |
| ConfigModal 页面 | [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md) |
| MainDisplay / OperationPanel 组件 | [`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md) / [`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md) |
| 跨模块符号 / 复用模块在哪 | [`docs/architecture/code-map.md`](docs/architecture/code-map.md) |

## 子目录指南

[`src/stores/AGENTS.md`](src/stores/AGENTS.md) · [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) · [`src/utils/terminal/AGENTS.md`](src/utils/terminal/AGENTS.md) · [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) · [`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md) · [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md) · [`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md)

## 文档索引

- [`docs/architecture/README.md`](docs/architecture/README.md) — 模块架构文档索引（serial / terminal / tty / transmission / logging / config / workspace / update / plugins / plugin-views / release / errors / conventions / code-map）。
- [`docs/plugin-development.md`](docs/plugin-development.md) — 插件作者指南（manifest / 权限 / Worker API / 调试 / 打包）。
- [`docs/userwiki/`](docs/userwiki/README.md) — 面向用户的功能手册。
- [`docs/architecture/conventions.md`](docs/architecture/conventions.md) — 跨模块开发约定与陷阱（本文件规则的展开版）。
- [`docs/architecture/code-map.md`](docs/architecture/code-map.md) — 符号与模块索引。

## 提交规范

```text
type(scope): description

type: feat | fix | docs | style | refactor | perf | test | chore
scope: ui | backend | store | hooks | docs
```

## Two-compiler 项目

- 前端 React 18 + TypeScript + Vite（`src/`）；后端 Rust + Tauri v2（`src-tauri/`）。
- Tauri v2：`invoke` 前端→后端，`app.emit` 后端→前端事件。
- `@tauri-apps/api`（npm）与 `tauri`（Cargo）必须同 minor 版本（当前 2.11.x）。
