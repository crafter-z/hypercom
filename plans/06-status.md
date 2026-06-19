# 实现状态

> 按模块划分，✅ 已完成 | 🔄 部分完成 | ⏳ 未开始

## 前端

| 文件 | 状态 | 说明 |
|------|------|------|
| `types/index.ts` | ✅ | 全部类型定义 (219 行) |
| `stores/useAppStore.ts` | ✅ | Zustand + Immer, 核心状态 (437 行) |
| `stores/useOperationStore.ts` | ✅ | 操作面板状态 (55 行) |
| `stores/useTerminalStore.ts` | ✅ | 终端状态 (49 行) |
| `stores/useRuleStore.ts` | ✅ | 规则集状态 (47 行) |
| `stores/useAppStore.test.ts` | ✅ | vitest 单测 (470 行, 49 cases) |
| `services/tauri.ts` | ✅ | 5 个服务模块, 含 storageService (268 行) |
| `hooks/useTauri.ts` | ✅ | 7 个 Hooks, mergePorts 防覆盖 (378 行) |
| `utils/highlightEngine.ts` | ✅ | 正则/关键词高亮引擎 (104 行) |
| `utils/highlightEngine.test.ts` | ✅ | 高亮引擎单测 (197 行, 22 cases) |
| `utils/hexUtils.ts` | ✅ | HEX 解析工具 (21 行) |
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
| `components/TitleBar/TitleBar.tsx` | ✅ | 完整, 窗口按钮绑定 API (60 行) |
| `components/Sidebar/Sidebar.tsx` | ✅ | 含 @dnd-kit 拖拽, 搜索, 分组, 备注 (482 行) |
| `components/Sidebar/AliasDialog.tsx` | ✅ | 别名编辑对话框 (37 行) |
| `components/Sidebar/hooks/usePortDragEnd.ts` | ✅ | 端口拖拽结束处理 hook (80 行) |
| `components/MainDisplay/MainDisplay.tsx` | ✅ | 分屏容器 + Pane 编排 (132 行) |
| `components/MainDisplay/Pane.tsx` | ✅ | 单 Pane 容器 + 标签管理 (160 行) |
| `components/MainDisplay/ResizeHandle.tsx` | ✅ | 分割线拖拽 (34 行) |
| `components/MainDisplay/TabBar.tsx` | ✅ | 含 @dnd-kit 水平拖拽, 右键菜单 (190 行) |
| `components/MainDisplay/TerminalView.tsx` | ✅ | 真实数据 + 语法高亮 + 虚拟滚动 + 文件导出 (227 行) |
| `components/MainDisplay/hooks/useTabDragEnd.ts` | ✅ | 标签拖拽结束处理 hook (73 行) |
| `components/OperationPanel/OperationPanel.tsx` | ✅ | 操作面板容器 + 三栏编排 (138 行) |
| `components/OperationPanel/SendSection.tsx` | ✅ | 手动发送区 (136 行) |
| `components/OperationPanel/ParamsSection.tsx` | ✅ | 串口参数区 (137 行) |
| `components/OperationPanel/RulesSection.tsx` | ✅ | 循环发送 + 命令集区 (108 行) |
| `components/OperationPanel/hooks/useCyclicSend.ts` | ✅ | 循环发送逻辑 hook (119 行) |
| `components/StatusBar/StatusBar.tsx` | ✅ | 进程内存/CPU + TX/RX 流量 + 时钟 (69 行) |
| `components/ConfigModal/ConfigModal.tsx` | ✅ | 配置弹窗容器 + 页面路由 (109 行) |
| `components/ConfigModal/RuleSetAccordion.tsx` | ✅ | 规则集折叠面板 (78 行) |
| `components/ConfigModal/pages/GeneralSettings.tsx` | ✅ | 通用设置页 (92 行) |
| `components/ConfigModal/pages/LogSettings.tsx` | ✅ | 日志设置页 (55 行) |
| `components/ConfigModal/pages/BackupSettings.tsx` | ✅ | 备份设置页 (33 行) |
| `components/ConfigModal/pages/DisplaySettings.tsx` | ✅ | 显示设置页 (45 行) |
| `components/ConfigModal/pages/HighlightSettings.tsx` | ✅ | 高亮规则页 (126 行) |
| `components/ConfigModal/pages/CommandSettings.tsx` | ✅ | 命令规则页 (142 行) |
| `components/ConfigModal/editors/HighlightRuleEditor.tsx` | ✅ | 高亮规则编辑器 (35 行) |
| `components/ConfigModal/editors/SendCmdEditor.tsx` | ✅ | 发送命令编辑器 (30 行) |

## 后端

| 文件 | 状态 | 说明 |
|------|------|------|
| `main.rs` | ✅ | 程序入口 (5 行) |
| `lib.rs` | ✅ | AppState（含 sysinfo 缓存）, 命令注册, setup (135 行) |
| `system.rs` | ✅ | Win32 电源管理 (SetThreadExecutionState) (55 行) |
| `commands/mod.rs` | ✅ | 命令注册 + CommandError 枚举 (39 行) |
| `commands/serial.rs` | ✅ | 串口命令 (141 行) |
| `commands/storage.rs` | ✅ | SQLite CRUD 命令 (251 行) |
| `commands/config.rs` | ✅ | 配置命令 (36 行) |
| `commands/log.rs` | ✅ | 日志命令 (196 行) |
| `commands/system_cmds.rs` | ✅ | 系统状态 + 电源管理命令 (67 行) |
| `commands/simulation.rs` | ✅ | 模拟串口命令 (39 行) |
| `serial/mod.rs` | ✅ | 真实/模拟串口, 事件推送, emit_data_event helper (483 行) |
| `config/mod.rs` | ✅ | JSON 持久化, 36 项配置 (219 行) |
| `logger/mod.rs` | ✅ | 写入 / 分片续写 / 文件名变量 / auto_save 短路 / 多编码 (467 行) |
| `storage/mod.rs` | ✅ | 6 表 + 完整 CRUD, 延迟初始化 (571 行) |
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
| 前端单元测试 (vitest, 71 cases / 2 files) | ✅ |
| 后端单元测试 (cargo test, 24 cases) | ✅ |
| 协议解析器 | ⏳ |
| 多语言支持 | ⏳ |

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
