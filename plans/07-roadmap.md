# 待办事项

## 🟢 低优先级

### 多语言 i18n 收尾
- ✅ 基础设施已就位：`src/i18n.ts` 含 zh-CN/en-US 字典 218 项，`main.tsx` 已接入，`useAppStore.subscribe` 同步 `config.language → i18n.changeLanguage`
- ✅ 7 个文件已完成 `t()` 替换：`App.tsx`、`TitleBar.tsx`、`StatusBar.tsx`、`Sidebar/AliasDialog.tsx`、`MainDisplay/` 3 文件
- ⏳ 15 文件待接 `t()`：`TerminalView.tsx`、`OperationPanel/*` 3 文件、`Sidebar/Sidebar.tsx`、`ConfigModal/*` 10 文件 — 当前保留中文 (与原始行为一致，不影响运行)
- 切换语言后界面会混合显示：已替换的文件切换语言，未替换的文件继续显示中文

## ✅ 已完成（移出待办列表）

### 2026-07 批次：字体/背景/分屏树/i18n 基础设施

#### 分屏嵌套（VS Code 树状）
- **类型重构** — `SplitPane` 平铺数组改为 `PaneNode = LeafPane | BranchPane` 联合，支持任意深度嵌套
- **Store 重构** — `panes: SplitPane[]` → `paneTree: PaneNode`，新增 7 个树辅助函数 (`findLeafById` / `findLeafByTabId` / `findParentBranch` / `collectLeaves` / `countLeaves` / `pruneTree` / `findBranchById`) + `resizeChildren` action
- **MainDisplay 递归渲染** — `renderNode(node, parentBranch)` 分支 flex 容器 + 叶子调用 `<Pane>`；本地 `paneSizes[]` state 改为直接读取并更新 store node.size
- **DnD 树遍历** — `useTabDragEnd` 改用 `findLeafByTabId` / `findLeafById` 替代扁平 `state.panes.find(...)`；按空叶 id 命中 droppable
- **测试** — 8 个扁平 pane 测试改写为 `paneTree` 形状断言；新增 2 个嵌套测试（3 层深度构造 + 内层 removePane 折叠）+ 1 个 helper 测试 → 99/99 通过

#### 字体缩放
- ✅ CSS 变量 `--font-size-terminal` 与 TerminalView Ctrl+滚轮处理程序 (lines 80-92) 已在 2026-06 存在
- ✅ 新增 ParamsSection 字号滑块 (`<input type="range" min=8 max=48>`) 绑定 `config.terminalFontSize`，通过 ThemeProvider effect 同步 CSS 变量

#### 背景图片
- ✅ 修复 1 行 bug：App.tsx L158 顶层 div 用 `background:` 简写覆盖了 body 的 `background-image` → 改为 `backgroundColor:` 仅设颜色
- 配置管道（GeneralSettings 路径选择 → ThemeProvider effect 设 `--bg-image` CSS 变量 → body 应用）此前已就位，只是顶层 div 遮蔽

#### 多语言 i18n 基础设施
- ✅ `src/i18n.ts` — i18next + react-i18next 初始化，扁平 dotted key (`keySeparator: false`)，218 keys × 2 语言
- ✅ `main.tsx` import 引入副作用初始化
- ✅ `useAppStore.subscribe` 监听 `config.language` 变化触发 `i18n.changeLanguage`
- ✅ 7 个文件已全替换：App/TitleBar/StatusBar/AliasDialog/MainDisplay/TabBar/Pane
- ⏳ 15 文件待续 — 见上方待办节

### 协议解析器 (2026-07)

- **协议模板数据模型** — `ProtocolTemplate` 类型 (15 字段: 帧头/长度字段/校验和/帧尾 + 5 个字段颜色), SQLite 持久化 (`protocol_templates` 表)
- **前端解析引擎** — `ProtocolFrameReassembler` 状态机 (SEARCH_HEADER → IN_FRAME → COMPLETE), 跨 50ms 读块重组帧, 支持 sum8/xor/crc8 校验和
- **字段着色渲染** — `renderProtocolLine` 逐字段解码着色, hex/text 双模式, 校验失败红色高亮
- **ConfigModal 第 7 页** — ProtocolSettings + ProtocolTemplateEditor (帧结构/校验/颜色三段式表单)
- **集成** — `useSerialReceive` 按端口绑定模板喂入重组器, `TerminalView` 渲染分支 (协议行用字段色, 普通行用高亮引擎), TerminalView 工具栏协议选择下拉
- **测试** — 前端 25 cases (17 parser + 8 renderer), 后端 3 DB tests, 共 96 前端 + 27 后端全通过

### 2026-06 重构批次 (12 commits)

| Commit | 范围 | 说明 |
|--------|------|------|
| `ccfd867` | `fix(backend)` | GBK 解码改用 encoding_rs, 替换 U+FFFD 占位符 |
| `6d805b3` | `refactor(backend)` | 移除 serial 死代码, 抽取 emit_data_event helper |
| `8bf661d` | `refactor(backend)` | 移除 storage 死 CRUD, 合并重复类型, 修复 6 处 .lock().unwrap() |
| `686b7be` | `refactor(backend)` | commands 单体拆分为 6 个领域文件 + CommandError 枚举 + 抽取 win32_power |
| `5224457` | `fix(utils)` | 抽取 hexUtils, 移除 3 个死导出 |
| `cec426c` | `refactor(store)` | god store 拆分为 4 个 store + removeEmptyPanes helper |
| `8944418` | `refactor(hooks)` | useSerialData 拆分为 useSerialReceive + useSerialSend |
| `a724c05` | `refactor(ui)` | ConfigModal 拆分为 10 个文件 + RuleSetAccordion |
| `3ed0bab` | `refactor(ui)` | OperationPanel 拆分为 4 个文件 + useCyclicSend hook |
| `e33bd30` | `refactor(ui)` | Sidebar 抽取 usePortDragEnd hook + AliasDialog |
| `bbd4540` | `refactor(ui)` | MainDisplay 拆分 + 修复 closeTab 生命周期 + 移除 setTimeout(0) |
| `ef32ce0` | `refactor(ui)` | styles.css 拆分为 11 个文件, 移除 20 个死 CSS class |

### 早期完成项

- **虚拟滚动** — commit `e0ec7ce`（`@tanstack/react-virtual` 替换 naive `lines.map`）
- **数据导出** — commit `4f1693e`（`save()` 文件对话框 + 新 Rust 命令 `export_terminal_log` 写盘，替代剪贴板方案）
- **日志功能完善** — 已实现自动分片、文件名变量解析、auto_save 短路
- **HEX 发送格式解析** — `parse_hex_string` 公共函数已就位
- **日志操作按钮** — 另存为/打开文件/打开目录全实现
- **前端测试基线** — commit `35169aa`（vitest 4.x + 15 个 useAppStore 单测，后扩展至 71 cases / 2 files）
- **标题栏窗口控制** — 最小化/最大化/关闭已绑定 Tauri API
- **串口参数完善** — `set_serial_params` 支持完整参数 (baud_rate + data_bits + parity + stop_bits + handshake)
- **窗口防休眠** — Win32 `SetThreadExecutionState` 已实现 (`system.rs`)
- **滚动锁定同步** — OperationPanel `opScrollLocked` 与 TerminalState 已同步
- **侧边栏 mock 分组清理** — 已改为仅在有真实端口时可选分组
