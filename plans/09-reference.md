# 快速参考

## 文件索引

### 前端核心

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/types/index.ts` | 288 | 全局类型定义 (含 SendHistoryEntry) |
| `src/App.tsx` | 163 | 根组件 + 布局编排 + useAppInit + ThemeProvider |
| `src/main.tsx` | 9 | ReactDOM.createRoot |
| `src/i18n.ts` | 851 | i18next + zh-CN/en-US 双语字典 |

### 前端 Store (4 个)

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/stores/useAppStore.ts` | 672 | Zustand 状态管理: tabs, ports, paneTree (树), config, groups |
| `src/stores/useOperationStore.ts` | 45 | 串口参数 + 发送字段 (无显示状态/编码/循环间隔) |
| `src/stores/useTerminalStore.ts` | 73 | 终端状态 (per-tab scrollLocked/showTimestamp/displayFormat/encoding) + setTerminalEncoding 重解码存量行 |
| `src/stores/useRuleStore.ts` | 47 | 规则集状态: highlightRuleSets, sendCommandSets + CRUD |
| `src/stores/useAppStore.test.ts` | 606 | useAppStore 单元测试（56 cases，vitest） |

> Store 拆分前为单一 `useAppStore.ts` (608 行, 55+ Actions)。2026-06 重构拆为 4 个。

### 前端服务与 Hooks

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/services/tauri.ts` | 410 | invoke 包装器 (6 个服务模块; sendHistoryService 已删除) |
| `src/hooks/useTauri.ts` | 886 | React Hooks 桥接 (8 个 Hooks + lostPortIds/filterLostTabIds) |
| `src/hooks/useHotkeys.ts` | 61 | 快捷键绑定 (全局 Ctrl+Enter 发送已移除) |

> Hooks 列表: useSerialPorts, useSerialConnection, usePinStatesSubscriber, useSerialReceive, useSerialSend (内存化发送历史), useConfigPersistence, useSystemStatus, useAppInit, useSimulation

### 前端工具

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/utils/highlightEngine.ts` | 104 | 语法高亮引擎 |
| `src/utils/highlightEngine.test.ts` | 197 | 高亮引擎单测（22 cases） |
| `src/utils/hexUtils.ts` | 21 | HEX 解析工具 (hexToString / stringToHex) |
| `src/utils/sendUtils.ts` | 108 | HEX<->文本双向 (textToHexPreview / hexToTextPreview) + sanitizeHexInput + computeByteCount + parseHexBytes + getLineEndingBytes |
| `src/utils/sendUtils.test.ts` | 120 | 发送工具单测（21 cases） |
| `src/utils/protocolParser.ts` | 363 | 协议帧解析引擎: ProtocolFrameReassembler 状态机 + sum8/xor8/crc8 校验和 |
| `src/utils/protocolParser.test.ts` | 181 | 解析引擎单测（17 cases） |
| `src/utils/protocolRenderer.ts` | 119 | 协议字段着色渲染器: renderProtocolLine 逐字段解码着色 |
| `src/utils/protocolRenderer.test.ts` | 146 | 渲染器单测（8 cases） |
| `src/utils/protocolE2E.test.ts` | 157 | 协议解析端到端单测（7 cases） |
| `src/utils/timeFormat.ts` | — | 时间戳格式化 (绝对/相对/uptime) |
| `src/utils/timeFormat.test.ts` | 88 | 时间格式化单测（13 cases） |
| `src/utils/lineFilter.ts` | — | 终端行过滤 (TX/RX/关键字/暂停) |
| `src/utils/lineFilter.test.ts` | 63 | 行过滤单测（11 cases） |
| `src/utils/logReplay.ts` | — | 日志回放行格式解析 |
| `src/utils/logReplay.test.ts` | 67 | 回放解析单测（10 cases） |

### 前端样式 (11 个文件)

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/styles.css` | 14 | 入口文件, @import 11 个子样式 |
| `src/styles/base.css` | 288 | 主题变量 + 基础样式 |
| `src/styles/titlebar.css` | 53 | 标题栏 |
| `src/styles/sidebar.css` | 226 | 侧边栏 |
| `src/styles/main-display.css` | 44 | 主显示区 |
| `src/styles/tabbar.css` | 96 | 标签栏 |
| `src/styles/terminal-view.css` | 88 | 终端视图 |
| `src/styles/operation-panel.css` | 159 | 操作面板 |
| `src/styles/status-bar.css` | 35 | 状态栏 |
| `src/styles/config-modal.css` | 153 | 配置弹窗 |
| `src/styles/context-menu.css` | 58 | 右键菜单 |

> 样式拆分前为单一 `styles.css` (1427 行)。2026-06 重构拆为 11 个文件, 移除 20 个死 class。

### 前端组件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/components/shared/ContextMenu.tsx` | 94 | 通用右键菜单 |
| `src/components/shared/HotkeyHelpDialog.tsx` | 66 | 快捷键帮助弹窗 (Ctrl+Enter 全局发送行已移除) |
| `src/components/TitleBar/TitleBar.tsx` | 60 | 标题栏 + 窗口控制 |
| `src/components/Sidebar/Sidebar.tsx` | 527 | 侧边栏 + 拖拽 + 搜索 + 分组 + open-all/close-all 工具栏按钮 |
| `src/components/Sidebar/AliasDialog.tsx` | 37 | 别名编辑对话框 |
| `src/components/Sidebar/hooks/usePortDragEnd.ts` | 80 | 端口拖拽结束处理 |
| `src/components/MainDisplay/MainDisplay.tsx` | 156 | 分屏容器 + Pane 编排 |
| `src/components/MainDisplay/Pane.tsx` | 175 | 单 Pane 容器 + 标签管理 |
| `src/components/MainDisplay/ResizeHandle.tsx` | 34 | 分割线拖拽 |
| `src/components/MainDisplay/TabBar.tsx` | 211 | 标签栏 + 水平拖拽 + 右键菜单 + 右端 split 按钮 |
| `src/components/MainDisplay/TerminalFilterBar.tsx` | 162 | per-tab 显示控件 (scrollLocked/showTimestamp/displayFormat/encoding) |
| `src/components/MainDisplay/TerminalView.tsx` | 316 | 终端 + 虚拟滚动 + 高亮 + 文件导出 + 过滤 |
| `src/components/MainDisplay/TerminalRow.tsx` | — | 单行渲染组件 |
| `src/components/MainDisplay/TerminalSearchBar.tsx` | — | 终端内 Ctrl+F 搜索条 (穿透虚拟视口) |
| `src/components/MainDisplay/terminalSearch.ts` | — | 终端搜索纯函数 |
| `src/components/MainDisplay/terminalSearch.test.ts` | 70 | 终端搜索单测（9 cases） |
| `src/components/MainDisplay/hooks/useTabDragEnd.ts` | 73 | 标签拖拽结束处理 |
| `src/components/OperationPanel/OperationPanel.tsx` | 212 | 顶部 strip + 三栏编排 (ViewStrip.tsx 已删除) |
| `src/components/OperationPanel/SendSection.tsx` | 283 | 手动发送区 (HEX<->文本双向 + 文件发送 + 输入框) |
| `src/components/OperationPanel/ParamsSection.tsx` | 119 | 串口参数区 (apply-only 预设下拉) |
| `src/components/OperationPanel/RulesSection.tsx` | 110 | 循环发送 + 命令集区 (无 loopInterval 字段) |
| `src/components/OperationPanel/hooks/useCyclicSend.ts` | 138 | 循环发送 (per-command delay + 命令集 loopDelay + 错误 500ms 重试) |
| `src/components/StatusBar/StatusBar.tsx` | 69 | 状态栏: CPU/内存 + TX/RX + 时钟 |
| `src/components/StatusBar/DisconnectBanner.tsx` | 71 | 断线横幅 (filterLostTabIds 驱动) |
| `src/components/StatusBar/DisconnectBanner.test.ts` | 32 | 横幅纯函数单测（5 cases） |
| `src/components/ConfigModal/ConfigModal.tsx` | 109 | 配置弹窗容器 + 页面路由 |
| `src/components/ConfigModal/RuleSetAccordion.tsx` | 78 | 规则集折叠面板 |
| `src/components/ConfigModal/pages/GeneralSettings.tsx` | 248 | 通用设置页 (含 Enter 行为开关 + 预设管理) |
| `src/components/ConfigModal/pages/LogSettings.tsx` | 55 | 日志设置页 |
| `src/components/ConfigModal/pages/BackupSettings.tsx` | 33 | 备份设置页 |
| `src/components/ConfigModal/pages/DisplaySettings.tsx` | 45 | 显示设置页 |
| `src/components/ConfigModal/pages/HighlightSettings.tsx` | 126 | 高亮规则页 |
| `src/components/ConfigModal/pages/CommandSettings.tsx` | 142 | 命令规则页 |
| `src/components/ConfigModal/editors/HighlightRuleEditor.tsx` | 35 | 高亮规则编辑器 |
| `src/components/ConfigModal/editors/SendCmdEditor.tsx` | 30 | 发送命令编辑器 |
| `src/components/ConfigModal/pages/ProtocolSettings.tsx` | 141 | 协议模板设置页 (CRUD 手风琴 + 映射) |
| `src/components/ConfigModal/editors/ProtocolTemplateEditor.tsx` | 170 | 协议模板编辑器 (帧结构/校验/颜色三段式) |

### 后端

| 文件 | 行数 | 职责 |
|------|------|------|
| `src-tauri/src/main.rs` | 5 | 程序入口 |
| `src-tauri/src/lib.rs` | 306 | AppState + 命令注册 + CLI --config 解析 + setup |
| `src-tauri/src/system.rs` | 65 | Win32 电源管理 (SetThreadExecutionState) |
| `src-tauri/src/commands/mod.rs` | 42 | 命令注册 + CommandError 枚举 |
| `src-tauri/src/commands/serial.rs` | 255 | 串口命令: open_port, close_port, send_data, get_port_status, send_file |
| `src-tauri/src/commands/storage.rs` | 502 | SQLite CRUD 命令: 规则集 + 命令集 + 协议模板 |
| `src-tauri/src/commands/config.rs` | 60 | 配置命令: get_config, set_config, reset_config, update_session_snapshot, get_config_path |
| `src-tauri/src/commands/log.rs` | 213 | 日志命令: start/stop_logging, save_log_as, export_terminal_log, get_log_files, set_log_*, open_path, open_log_directory |
| `src-tauri/src/commands/system_cmds.rs` | 69 | 系统状态 + 电源管理命令 |
| `src-tauri/src/commands/simulation.rs` | 48 | 模拟串口命令: enable/disable_simulation |
| `src-tauri/src/commands/file.rs` | 54 | 配置导出/导入 + validate_config_path |
| `src-tauri/src/serial/mod.rs` | 643 | 串口管理器 (真实 + 模拟) + emit_data_event |
| `src-tauri/src/config/mod.rs` | 475 | JSON 配置 (versioning + migrate + validate_and_clamp + path resolution + backup) |
| `src-tauri/src/logger/mod.rs` | 575 | 日志管理 (分片续写 + split_enabled + sync_all + 多编码 + auto_save) |
| `src-tauri/src/storage/mod.rs` | 887 | SQLite CRUD (7 张表, 含 protocol_templates, WAL+FK, 事务写) |

> commands 拆分前为单一 `commands/mod.rs` (400+ 行)。2026-06 重构拆为 7 个领域文件 + CommandError 枚举 + 抽取 `system.rs`。

## 前端依赖

| 包 | 版本 | 用途 |
|----|------|------|
| react / react-dom | ^18.3.1 | UI 框架 |
| zustand | ^5.0.13 | 状态管理 (4 个 store) |
| immer | ^11.1.6 | 不可变更新 |
| lucide-react | ^1.14.0 | 矢量图标 |
| @dnd-kit/core | ^6.3.1 | 拖拽核心 |
| @dnd-kit/sortable | ^10.0.0 | 可排序列表 |
| @dnd-kit/utilities | ^3.2.2 | 拖拽工具 |
| @tanstack/react-virtual | ^3.13.15 | 终端虚拟滚动 |
| @tauri-apps/api | ^2.0.0 | Tauri 前端 API |
| @tauri-apps/plugin-dialog | ^2.7.1 | 文件对话框 |
| @tauri-apps/plugin-shell | ^2.0.0 | Shell/打开外部 |
| typescript | ^5.6.3 | 类型检查 |
| vite | ^5.4.10 | 构建工具 |
| vitest | ^4.x | 单元测试（devDep，environment: 'node'） |

## 后端依赖

| Crate | 版本 | 用途 |
|-------|------|------|
| tauri | 2.11 | 桌面框架 |
| tauri-plugin-shell | 2 | Shell 插件 |
| tauri-plugin-dialog | 2 | 文件对话框 |
| serialport | 4 | 串口通信 |
| sqlx (sqlite) | 0.7 | 数据库 |
| sysinfo | 0.33 | 系统监控 |
| serde / serde_json | 1 | 序列化 |
| chrono | 0.4 | 时间处理 |
| tokio | 1 (full) | 异步运行时 |
| uuid | 1 (v4) | ID 生成 |
| dirs | 5 | 系统目录 |
| anyhow / thiserror | 1 | 错误处理 (thiserror 用于 CommandError) |
| encoding_rs | 0.8 | GBK 编码解码 |
| log / env_logger | 0.4 / 0.11 | 日志 |

## 命名规范

| 上下文 | 风格 | 示例 |
|--------|------|------|
| 组件名 | PascalCase | `TerminalView`, `OperationPanel` |
| 变量/函数 | camelCase | `handleSend`, `activeTabId` |
| 类型/接口 | PascalCase | `SerialPort`, `AppConfig` |
| CSS class | kebab-case | `.port-item-name`, `.terminal-toolbar-title` |
| Rust 结构体 | PascalCase | `SerialManager`, `AppConfig` |
| Rust 函数/变量 | snake_case | `open_port`, `baud_rate` |
| Rust 模块 | snake_case | `serial`, `config` |
| Rust 错误枚举 | PascalCase + thiserror | `CommandError` (9 变体: Serial/Config/Log/Storage/System/Lock/Io/Other) |
| 文件名 | PascalCase (组件), camelCase (工具) | `Sidebar.tsx`, `highlightEngine.ts` |

### Store 拆分约定

操作面板字段无 `op` 前缀。旧名 `opBaudRate` 改为 `baudRate`, `opDataBits` 改为 `dataBits`, 以此类推。

| Store | 字段示例 |
|-------|----------|
| `useAppStore` | `ports`, `tabs`, `paneTree`, `config`, `groups` |
| `useOperationStore` | `baudRate`, `dataBits`, `parity`, `stopBits`, `sendInput`, `sendIsHex`, `sendAppendLineEnding`, `isLoopSending`, `loopRepeatCount` (无 `scrollLocked`/`showTimestamp`/`displayFormat`/`encoding`/`loopInterval`) |
| `useTerminalStore` | `terminals`, `appendTerminalLine`, `clearTerminal`, `setTerminalConfig`, `setTerminalEncoding` |
| `useRuleStore` | `highlightRuleSets`, `sendCommandSets`, `activeHighlightSetId` |

### CommandError 枚举

所有 Tauri 命令返回 `Result<T, CommandError>` 而非 `Result<T, String>`。`CommandError` 定义在 `commands/mod.rs`, 手动实现 `serde::Serialize` 以便前端通过 `invoke` 接收错误字符串。

```rust
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    Serial(String), Config(String), Log(String), Storage(String),
    System(String), Lock(String), Io(String), Other(String),
}
```

## 提交规范

```
type(scope): description

type: feat / fix / docs / style / refactor / perf / test / chore
scope: ui / backend / store / hooks / plans
```

示例：
- `feat(backend): add sysinfo crate for real CPU/memory monitoring`
- `fix(ui): prevent port status overwrite on periodic poll`
- `docs(plans): reorganize documentation into 9 files`

## 常用命令

```bash
npm run tauri dev          # 开发模式运行
npm run tauri build        # 生产构建
npx tsc --noEmit           # TypeScript 类型检查
npm run test               # vitest 监听模式
npm run test:run           # vitest 一次跑 (179 tests, 11 files)
cargo build                # Rust 编译 (在 src-tauri/ 下)
cargo check                # Rust 快速检查 (不生成二进制)
cargo test --lib           # Rust 单元测试 (33 tests)
```
