# 实现状态

> 按模块划分，✅ 已完成 | 🔄 部分完成 | ⏳ 未开始

## 前端

| 文件 | 状态 | 说明 |
|------|------|------|
| `types/index.ts` | ✅ | 全部类型定义 (288 行) — 含 PaneNode/LeafPane/BranchPane 联合 + SendHistoryEntry |
| `stores/useAppStore.ts` | ✅ | Zustand + Immer, 核心状态 (672 行) — paneTree + 7 树辅助 + resizeChildren |
| `stores/useOperationStore.ts` | ✅ | 串口参数 + 发送字段 (45 行) — sendOnEnter/quickSendSlots 在 useAppStore.config；scrollLocked/showTimestamp/displayFormat/encoding/loopInterval 已下沉 useTerminalStore 或移除 |
| `stores/useTerminalStore.ts` | ✅ | 终端状态 (73 行) — 含 setTerminalEncoding (重解码存量行) |
| `stores/useRuleStore.ts` | ✅ | 规则集状态 (47 行) |
| `stores/useAppStore.test.ts` | ✅ | vitest 单测 (606 行, 56 cases) |
| `services/tauri.ts` | ✅ | 6 个服务模块, 含 storageService + configService (410 行) — camelCase 对齐、移除死代码; sendHistoryService 已删除 |
| `i18n.ts` | ✅ | i18next + react-i18next 初始化, 含 enterNewline/presets.*/sendSection.input.placeholder.hex (851 行) |
| `hooks/useTauri.ts` | ✅ | 9 个 Hooks (含 usePinStatesSubscriber), mergePorts 防覆盖 + 模块级 lostPortIds Set + isPortLost (886 行) |
| `hooks/useHotkeys.ts` | ✅ | 快捷键绑定 (61 行) — 全局 Ctrl+Enter 发送热键已移除 |
| `utils/highlightEngine.ts` | ✅ | 正则/关键词高亮引擎 (104 行) |
| `utils/highlightEngine.test.ts` | ✅ | 高亮引擎单测 (197 行, 22 cases) |
| `utils/hexUtils.ts` | ✅ | HEX 解析工具 (21 行) |
| `utils/sendUtils.ts` | ✅ | HEX<->文本双向 + sanitize (textToHexPreview/hexToTextPreview/sanitizeHexInput/computeByteCount/parseHexBytes/getLineEndingBytes) (108 行) |
| `utils/sendUtils.test.ts` | ✅ | 发送工具单测 (120 行, 21 cases) |
| `utils/protocolParser.ts` | ✅ | 协议帧解析引擎: 状态机 + 校验和 (363 行) |
| `utils/protocolParser.test.ts` | ✅ | 解析引擎单测 (181 行, 17 cases) |
| `utils/protocolRenderer.ts` | ✅ | 协议字段着色渲染器 (119 行) |
| `utils/protocolRenderer.test.ts` | ✅ | 渲染器单测 (146 行, 8 cases) |
| `utils/protocolE2E.test.ts` | ✅ | 协议解析端到端单测 (7 cases) |
| `utils/logReplay.ts` | ✅ | 日志回放解析工具 (行格式解析) |
| `utils/logReplay.test.ts` | ✅ | 回放解析单测 (10 cases) |
| `utils/timeFormat.ts` | ✅ | 时间戳格式化 (绝对/相对/uptime) |
| `utils/timeFormat.test.ts` | ✅ | 时间格式化单测 (88 行, 13 cases) |
| `utils/lineFilter.ts` | ✅ | 终端行过滤 (TX/RX/关键字/暂停) |
| `utils/lineFilter.test.ts` | ✅ | 行过滤单测 (63 行, 11 cases) |
| `components/MainDisplay/terminalSearch.ts` | ✅ | 终端内搜索 (Ctrl+F 搜索条穿透虚拟视口) |
| `components/MainDisplay/terminalSearch.test.ts` | ✅ | 终端搜索单测 (70 行, 9 cases) |
| `styles.css` | ✅ | 入口文件, @import 11 个子样式 (14 行) |
| `styles/base.css` | ✅ | 主题变量 + 基础样式 (288 行) |
| `styles/titlebar.css` | ✅ | 标题栏样式 (53 行) |
| `styles/sidebar.css` | ✅ | 侧边栏样式 (226 行) |
| `styles/main-display.css` | ✅ | 主显示区样式 (44 行) |
| `styles/tabbar.css` | ✅ | 标签栏样式 (96 行) |
| `styles/terminal-view.css` | ✅ | 终端视图样式 (88 行) |
| `styles/operation-panel.css` | ✅ | 操作面板样式 (159 行) |
| `styles/status-bar.css` | ✅ | 状态栏样式 (35 行) |
| `styles/config-modal.css` | ✅ | 配置弹窗样式 (153 行) |
| `styles/context-menu.css` | ✅ | 右键菜单样式 (58 行) |
| `App.tsx` | ✅ | 布局编排 + useAppInit + ThemeProvider (163 行) |
| `main.tsx` | ✅ | ReactDOM.createRoot (9 行) |
| `components/shared/ContextMenu.tsx` | ✅ | 通用右键菜单 (94 行) |
| `components/shared/AboutDialog.tsx` | ✅ | 关于对话框 (版本/技术栈/许可) |
| `components/TitleBar/TitleBar.tsx` | ✅ | 完整, 窗口按钮绑定 API (60 行) |
| `components/Sidebar/Sidebar.tsx` | ✅ | 含 @dnd-kit 拖拽, 搜索, 分组, 备注, open-all/close-all 工具栏按钮 (527 行) |
| `components/Sidebar/AliasDialog.tsx` | ✅ | 别名编辑对话框 (37 行) |
| `components/Sidebar/hooks/usePortDragEnd.ts` | ✅ | 端口拖拽结束处理 hook (80 行) |
| `components/MainDisplay/MainDisplay.tsx` | ✅ | 分屏容器 + 递归树渲染 renderNode (156 行) |
| `components/MainDisplay/Pane.tsx` | ✅ | 单 Pane 容器 + 收集 otherPanes via collectLeaves (175 行) |
| `components/MainDisplay/ResizeHandle.tsx` | ✅ | 分割线拖拽 (34 行) — 树状重构未改动 |
| `components/MainDisplay/TabBar.tsx` | ✅ | 含 @dnd-kit 水平拖拽, 右键菜单, i18n, 右端 split 按钮 (211 行) |
| `components/MainDisplay/TerminalFilterBar.tsx` | ✅ | per-tab 显示控件 (scrollLocked/showTimestamp/displayFormat/encoding) (162 行) |
| `components/MainDisplay/TerminalView.tsx` | ✅ | 真实数据 + 语法高亮 + 虚拟滚动 + 文件导出 + 过滤 (316 行) |
| `components/MainDisplay/hooks/useTabDragEnd.ts` | ✅ | 树遍历拖拽 hook (findLeafByTabId/findLeafById) (72 行) |
| `components/MainDisplay/hooks/useLogReplay.ts` | ✅ | 日志回放 hook (按时间戳写回终端 + 倍速) |
| `components/OperationPanel/OperationPanel.tsx` | ✅ | 顶部 strip (连接/清屏/回放/日志/字号) + 三栏编排 (212 行); ViewStrip.tsx 已删除 |
| `components/OperationPanel/SendSection.tsx` | ✅ | 发送区: HEX<->文本双向 + 文件发送 + 输入框 (283 行) |
| `components/OperationPanel/ParamsSection.tsx` | ✅ | 串口参数区; apply-only 预设下拉 (119 行) |
| `components/OperationPanel/RulesSection.tsx` | ✅ | 循环发送 + 命令集区; 无 loopInterval 字段 (110 行) |
| `components/OperationPanel/hooks/useCyclicSend.ts` | ✅ | 循环发送 (per-command delay + 命令集 loopDelay + 错误 500ms 重试) (138 行) |
| `components/StatusBar/StatusBar.tsx` | ✅ | 进程内存/CPU + TX/RX 流量 + 时钟 (69 行) |
| `components/StatusBar/DisconnectBanner.tsx` | ✅ | 断线横幅 (filterLostTabIds 驱动, isPortLost only connected→disconnected) (71 行) |
| `components/StatusBar/DisconnectBanner.test.ts` | ✅ | 横幅纯函数测试 (32 行, 5 cases) |
| `components/shared/HotkeyHelpDialog.tsx` | ✅ | 快捷键帮助弹窗 (66 行); Ctrl+Enter 全局发送行已移除 |
| `components/ConfigModal/ConfigModal.tsx` | ✅ | 配置弹窗容器 + 页面路由 (109 行) |
| `components/ConfigModal/RuleSetAccordion.tsx` | ✅ | 规则集折叠面板 (78 行) |
| `components/ConfigModal/pages/GeneralSettings.tsx` | ✅ | 通用设置页: Enter 行为开关 + 预设管理 (248 行) |
| `components/ConfigModal/pages/LogSettings.tsx` | ✅ | 日志设置页 (55 行) |
| `components/ConfigModal/pages/BackupSettings.tsx` | ✅ | 备份设置页 (33 行) |
| `components/ConfigModal/pages/DisplaySettings.tsx` | ✅ | 显示设置页 (45 行) |
| `components/ConfigModal/pages/HighlightSettings.tsx` | ✅ | 高亮规则页 (126 行) |
| `components/ConfigModal/pages/CommandSettings.tsx` | ✅ | 命令规则页 (142 行) |
| `components/ConfigModal/editors/HighlightRuleEditor.tsx` | ✅ | 高亮规则编辑器 (35 行) |
| `components/ConfigModal/editors/SendCmdEditor.tsx` | ✅ | 发送命令编辑器 (30 行) |
| `components/ConfigModal/pages/ProtocolSettings.tsx` | ✅ | 协议模板设置页 (141 行) |
| `components/ConfigModal/editors/ProtocolTemplateEditor.tsx` | ✅ | 协议模板编辑器 (170 行) |

## 后端

| 文件 | 状态 | 说明 |
|------|------|------|
| `main.rs` | ✅ | 程序入口 (5 行) |
| `lib.rs` | ✅ | AppState（含 sysinfo 缓存）, 命令注册, CLI --config 解析, setup (306 行) |
| `system.rs` | ✅ | Win32 电源管理 (SetThreadExecutionState) (55 行) |
| `commands/mod.rs` | ✅ | 命令注册 + CommandError 枚举 (42 行) |
| `commands/serial.rs` | ✅ | 串口命令 (255 行) — 含 send_file TX 元数据日志 |
| `commands/storage.rs` | ✅ | SQLite CRUD 命令: 规则集 + 命令集 + 协议模板 |
| `commands/config.rs` | ✅ | 配置命令 (66 行) — get/set/reset/update_session_snapshot/get_config_path |
| `commands/log.rs` | ✅ | 日志命令 (230 行) — 13 命令, 含 set_log_split_enabled, save_log_as/export 作用域放宽 |
| `commands/system_cmds.rs` | ✅ | 系统状态 + 电源管理命令 (67 行) |
| `commands/file.rs` | ✅ | 配置导出/导入 + validate_config_path 路径限制 (54 行) |
| `commands/simulation.rs` | ✅ | 模拟串口命令 (39 行) |
| `serial/mod.rs` | ✅ | 真实/模拟串口, 事件推送, emit_data_event helper (483 行) |
| `config/mod.rs` | ✅ | JSON 持久化 + config_version 迁移框架 + validate_and_clamp + 路径解析 (CLI/env/portable) + .bak 备份/恢复 (475 行) |
| `logger/mod.rs` | ✅ | 写入 / 分片续写 / split_enabled 开关 / 文件名变量 / auto_save 短路 / sync_all 落盘 / 多编码 (541 行) |
| `storage/mod.rs` | ✅ | 7 表 (port_groups 已移除) + WAL+FK  pragmas + 事务写 + ON CONFLICT 保 createdAt, 延迟初始化 (887 行) |
| `Cargo.toml` | ✅ | tauri 2.11, sysinfo, sqlx, serialport, encoding_rs |
| `capabilities/default.json` | ✅ | 事件权限, shell:allow-open, dialog:allow-open/save, 6 个 window 控件权限 |

## 功能

| 功能 | 状态 |
|------|------|
| 串口枚举/连接/断开 | ✅ |
| 数据收发 (HEX/字符串/换行) | ✅ |
| 事件推送 (serial:data, serial:status) | ✅ |
| 模拟串口 SIM:Loopback | ✅ |
| 多标签页 + 分屏 | ✅ |
| 串口分组管理 | ✅ |
| 搜索过滤 | ✅ |
| 备注名设置 | ✅ |
| 拖拽排序 (侧边栏 + 标签页) | ✅ |
| 循环发送 (命令集 + 延时) | ✅ |
| 语法高亮 (正则/关键词/颜色/样式) | ✅ |
| 高亮规则集编辑器 (含数据库存取) | ✅ |
| 发送命令集编辑器 (含数据库存取) | ✅ |
| 6 页全局配置 | ✅ |
| 暗色/亮色/跟随系统主题 | ✅ |
| 系统资源监控 (进程 CPU/内存) | ✅ |
| 串口流量统计 (TX/RX 累加) | ✅ |
| 数据库 CRUD | ✅ |
| 日志分片续写 | ✅ |
| 日志文件名变量解析 | ✅ |
| 日志操作 (另存/打开/目录) | ✅ |
| 日志自动保存 (连接时启停) | ✅ |
| 标题栏窗口控制 | ✅ |
| HEX 发送格式解析 (含错误检测) | ✅ |
| 虚拟滚动 (`@tanstack/react-virtual`) | ✅ |
| 真实文件导出 (TXT/CSV via `save()` + Rust 写盘) | ✅ |
| GBK 解码 (encoding_rs) | ✅ |
| 前端单元测试 (vitest, 179 cases / 11 files) | ✅ |
| 后端单元测试 (cargo test, 33 cases) | ✅ |
| 断线横幅仅报本次会话真实断线 (filterLostTabIds + isPortLost) | ✅ |
| 显示状态 per-tab 化（编码切换即时重解码, setTerminalEncoding） | ✅ |
| 发送历史内存化（per-port, 上限 50, 会话内有效） | ✅ |
| HEX 发送内容双向转换 (textToHexPreview / hexToTextPreview / sanitizeHexInput) | ✅ |
| 循环发送间隔单一数据源（命令集延时, 无 loopInterval 字段） | ✅ |
| Enter 行为可配置 (GeneralSettings 开关, 默认 Enter 发送) | ✅ |
| 预设管理迁移至 GeneralSettings (inline 命名, 无 window.prompt) | ✅ |
| Sidebar open-all/close-all 升级为一级工具栏按钮 | ✅ |
| TabBar 右端分屏按钮 (onSplitVertical / onSplitHorizontal) | ✅ |
| 协议解析器 | ✅ |
| 分屏嵌套 (VS Code 树状) | ✅ |
| 字体缩放 (CSS 变量 + ParamsSection 滑块) | ✅ |
| 背景图片 (主窗口应用) | ✅ |
| 多语言支持 (i18n, 全部 30 个组件文件接入) | ✅ |
| 窗口置顶 (TitleBar + setAlwaysOnTop) | ✅ |
| 关于对话框 (版本/技术栈/许可) | ✅ |
| 配置导出/导入 (JSON bundle, 含规则集与协议模板) | ✅ |
| 端口参数预设 (SQLite 持久化 + ParamsSection) | ✅ |
| 文件发送 / 二进制传输 (分块 + 进度事件) | ✅ |
| 日志回放 (按时间戳写回 + 倍速 1/4/16/最快) | ✅ |
| 批量发送脚本 (循环发送重复轮数控制) | ✅ |
| 最小化到托盘 (closeBehavior + 系统托盘菜单) | ✅ |
| 配置版本化 + 迁移框架 (config_version + migrate) | ✅ |
| 配置路径自定义 (CLI --config / HYPERCOM_CONFIG env / portable) | ✅ |
| 配置字段校验 (validate_and_clamp on set_config) | ✅ |
| 配置备份/恢复 (.bak 落盘 + corrupt fallback) | ✅ |
| 会话快照专用命令 (update_session_snapshot, 避全量保存竞态) | ✅ |
| sendOnEnter/quickSendSlots 归一 (useAppStore.config 单源) | ✅ |
| 日志分片开关 (set_log_split_enabled + log_split_enabled 默认 true) | ✅ |
| SQLite WAL+FK  pragmas + 事务写 (save_command_set / save_highlight_set) | ✅ |
| 日志导出作用域放宽 (save_log_as / export_terminal_log 不再限 log_directory 子树) | ✅ |
| ConfigModal 页面逐字段选择器 (替代整 config 订阅) | ✅ |

## 重构 (2026-06)

> 12 个重构提交, 按时间顺序排列。所有验证通过: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 71/71, `cargo test --lib` 24/24。

| # | Commit | 范围 | 说明 |
|---|--------|------|------|
| 1 | `ccfd867` | `fix(backend)` | GBK 解码改用 encoding_rs, 替换 U+FFFD 占位符 |
| 2 | `6d805b3` | `refactor(backend)` | 移除 serial 死代码, 抽取 emit_data_event helper |
| 3 | `8bf661d` | `refactor(backend)` | 移除 storage 死 CRUD, 合并重复类型, 修复 6 处 .lock().unwrap() |
| 4 | `686b7be` | `refactor(backend)` | commands 单体拆分为 6 个领域文件 + CommandError 枚举 + 抽取 win32_power |
| 5 | `5224457` | `fix(utils)` | 抽取 hexUtils, 移除 3 个死导出 |
| 6 | `cec426c` | `refactor(store)` | god store 拆分为 4 个 store (useAppStore/useOperationStore/useTerminalStore/useRuleStore) + removeEmptyPanes helper |
| 7 | `8944418` | `refactor(hooks)` | useSerialData 拆分为 useSerialReceive + useSerialSend |
| 8 | `a724c05` | `refactor(ui)` | ConfigModal 拆分为 10 个文件 + RuleSetAccordion |
| 9 | `3ed0bab` | `refactor(ui)` | OperationPanel 拆分为 4 个文件 + useCyclicSend hook |
| 10 | `e33bd30` | `refactor(ui)` | Sidebar 抽取 usePortDragEnd hook + AliasDialog |
| 11 | `bbd4540` | `refactor(ui)` | MainDisplay 拆分 + 修复 closeTab 生命周期 + 移除 setTimeout(0) |
| 12 | `ef32ce0` | `refactor(ui)` | styles.css 拆分为 11 个文件, 移除 20 个死 CSS class |

## 重构 (2026-07)

> Bug 修复（30+ 项）+ 架构迭代（4 阶段）。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告。

### Phase 1 — 配置架构

- `config/mod.rs` (219→475 行)：`config_version: u32` + `migrate()` 迁移框架；`ConfigManager::new(Option<PathBuf>)` 支持 CLI `--config` / `HYPERCOM_CONFIG` 环境变量 / portable 模式路径解析；`validate_and_clamp()` 在 `set_config` 时执行字段校验与裁剪；`update_session_snapshot()` 单字段更新方法（避免全量保存竞态）；`config_path()` getter；`save()` 写前生成 `.bak`；`new()` 读取失败时回退到 `.bak`
- `commands/config.rs` (36→66 行)：新增 `update_session_snapshot`、`get_config_path` 命令；`save_config` 改名为 `set_config`
- `lib.rs` (135→306 行)：CLI `--config` 参数解析；注册新命令
- `useOperationStore.ts`：移除 `sendOnEnter`、`quickSendSlots`（现仅存于 `useAppStore.config`）
- `SendSection.tsx`：从 `useAppStore(s => s.config.sendOnEnter)` 读取
- `useTauri.ts`：移除 useAppInit / resetAndReload 中的 sendOnEnter/quickSendSlots 同步代码
- `sessionSnapshot.ts`：改用 `configService.updateSessionSnapshot()`（专用命令）；移除 `configSaveInProgress` 标志
- `GeneralSettings.tsx`：通过 `getConfigPath()` 显示配置文件路径

### Phase 2 — 日志

- `config/mod.rs`：`auto_save_log` 默认改为 `true`；`log_split_enabled` 默认改为 `true`；空 `log_directory` 解析为 `dirs::data_dir()/hypercom/logs`
- `commands/log.rs` (196→230 行)：新增 `set_log_split_enabled` 命令；`save_log_as` 和 `export_terminal_log` 作用域限制移除（允许 save 对话框选择的任意路径）
- `logger/mod.rs` (467→541 行)：`close_writer` 调用 `sync_all()` 确保数据落盘；新增 `split_enabled` 字段 + 守卫生成切片
- `services/tauri.ts`：新增 `setLogFilenameFormat`、`setLogSplitSize`、`setLogSplitEnabled` 包装；移除废弃 `onSystemStatus` 事件监听
- `useTauri.ts`：`syncLogSettingsToBackend()` 同步全部 6 个日志设置
- `useAppStore.ts`：`defaultConfig` 中 `autoSaveLog: true`、`logSplitEnabled: true`

### Phase 3 — 数据清理

- `storage/mod.rs`：移除 `port_groups` 和 `port_group_members` 表（9→7 表）；`PortGroupRow` 结构体移除
- `storage/mod.rs`：新增 `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON`；`save_command_set_to_db` 和 `save_highlight_set_to_db` 改为事务包裹；`save_port_preset_to_db` 使用 `ON CONFLICT` 保留 `created_at`；移除死代码（`set_baud_rate`、旧端口分组函数）
- `BackupSettings.tsx`：新增 `validateConfigBundle()` 导入校验；store 同步后再 reload

### Phase 4 — 鲁棒性

- `config/mod.rs`：`save()` 写前生成 `.bak` 备份；`new()` 读 JSON 失败时回退到 `.bak` 恢复
- ConfigModal 页面（GeneralSettings / LogSettings / DisplaySettings / BackupSettings）：逐字段选择器替代整 config 订阅，避免无关字段变更触发重渲染
- `types/index.ts`：`SystemStatus.memoryUsedMB` → `memoryUsedMb`（camelCase 对齐）
- `hooks/useTauri.ts`：`useSystemStatus` camelCase 字段名对齐；`mapProtocolTemplateInfo` 增加 `Boolean()` 转换
- `SystemStatus` / `LogFileInfo`：增加 `#[serde(rename_all = "camelCase")]` 确保前后端一致
- 对话框（AboutDialog / HotkeyHelpDialog / AliasDialog）：使用新增 `.modal-dialog-compact` CSS 类
- `commands/file.rs`：新增 `validate_config_path()` 限制导入路径在配置目录内
- `commands/serial.rs`：`send_file` 新增 TX 元数据日志记录

## 重构 (2026-07-25 UI/UX 大修)

> UI/UX 大修。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 179/179 (11 files), `cargo test --lib` 33/33。

### Bug 修复 (根因级)

| # | 严重度 | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 1 | HIGH | `DisconnectBanner.tsx` / `useTauri.ts` | 会话恢复的标签启动即触发"端口已断开"横幅误报 | `useTauri.ts` 模块级 `lostPortIds: Set<string>` + `isPortLost`；`DisconnectBanner.tsx` 改由 `filterLostTabIds` (纯函数, 单测) 驱动 |
| 2 | HIGH | `OperationPanel.tsx` / `useOperationStore.ts` | `scrollLocked` / `showTimestamp` / `displayFormat` / `encoding` / `loopInterval` 5 字段全局态每次切标签覆盖 per-tab 终端状态 (编码选择"不生效"根因) | 4 字段 + `loopInterval` 移出 opStore；显示控制下沉 `TerminalFilterBar` 直写 `useTerminalStore` |
| 3 | MEDIUM | `useTerminalStore.ts` | 切换编码只影响新数据，存量行不重解码 | 新增 `setTerminalEncoding(portId, encoding)` —— 更新 encoding + 从 `rawData` 重解码全部存量行 |
| 4 | MEDIUM | `useHotkeys.ts` | 全局 Ctrl+Enter 发送与"Ctrl+Enter 永远换行"的交互决策冲突 | 移除全局热键及帮助弹窗对应行 |
| 5 | LOW | `RulesSection.tsx` / `useCyclicSend.ts` | `loopInterval` 与命令集 per-command delay 双数据源语义重叠 | 移除间隔字段，时机由命令集延时唯一决定 |
| 6 | LOW | `SendSection.tsx` | HEX/字符串切换无内容转换、HEX 模式不限制输入 | `sendUtils.ts` 新增 `textToHexPreview` / `hexToTextPreview` / `sanitizeHexInput` 提供双向转换 + 输入过滤 |

### Layout 重构

| 项 | 范围 | 说明 |
|----|------|------|
| **ViewStrip 删除** | `OperationPanel/ViewStrip.tsx` | 文件删除；顶部 strip 内联至 `OperationPanel.tsx`：[连接/清屏] ‖ [回放速率/启停] ‖ [日志另存/打开/目录] ‖ [字号] |
| **SendSection 重构** | `SendSection.tsx` | connect/clear 按钮迁出；Enter-toggle 入口移至 GeneralSettings；clear-history 按钮移除；Enter 默认发送，Shift/Ctrl+Enter 永远换行；HEX toggle 双向转换；文件发送移至 Send 按钮旁 |
| **RulesSection/useCyclicSend 精简** | `RulesSection.tsx` + `useCyclicSend.ts` | `loopInterval` 字段 + 输入框 + fallback 全删；错误重试固定 500ms |
| **ParamsSection 简化** | `ParamsSection.tsx` | 预设下拉改为 apply-only；预设管理 (list/apply/delete/save-current, inline 命名) 整体迁移至 GeneralSettings (无 `window.prompt`) |
| **TerminalFilterBar 增强** | `TerminalFilterBar.tsx` | 新增 pin / timestamp / HEX·string / encoding (走 `setTerminalEncoding`)；replay 控件迁出至 OperationPanel 顶部 strip |
| **TabBar 分屏按钮** | `TabBar.tsx` + `MainDisplay.tsx` | split 按钮从 `main-display-toolbar` 行迁至每个 Pane 自己的 TabBar 右端 (`onSplitVertical` / `onSplitHorizontal` 聚焦即 split)；删 `main-display-toolbar` 全行 (pane-count 信息随之消失) |
| **Sidebar 一级工具栏** | `Sidebar.tsx` | open-all / close-all 从 ⋯ 菜单升级为第一级 icon-button |
| **GeneralSettings 扩容** | `GeneralSettings.tsx` | + Enter 行为开关 (`!config.sendOnEnter`) + 预设管理 section (list/apply/delete/save-current) |
| **全局 Ctrl+Enter 热键移除** | `useHotkeys.ts` + `HotkeyHelpDialog.tsx` | 删除键绑定及帮助弹窗对应行 |
| **i18n** | `i18n.ts` | +9 keys (`generalSettings.enterNewline` / `generalSettings.enterNewline.hint` / `generalSettings.presets.*` ×6 / `sendSection.input.placeholder.hex`)；−12 dead keys (`rulesSection.interval*` / `op.send.enterBehavior.*` ×4 / `op.send.clearHistory` / `paramsSection.preset.{namePrompt,saveTooltip,deleteTooltip}` / `hotkeys.send` / `mainDisplay.toolbar.paneCount`) |
| **发送历史内存化 (用户决策)** | `useTauri.ts` / `services/tauri.ts` / `types/index.ts` | per-port `Map<string, SendHistoryEntry[]>`，上限 50；删除 `sendHistoryService` / `SendHistoryItem`；新增 `SendHistoryEntry` 类型；Rust 后端命令仍在但不再调用 |
