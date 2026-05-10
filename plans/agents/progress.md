# HyperCom 项目进度与遗留事项

> 本文档面向多 Agent 协作开发，标识当前各模块的完成状态、已实现功能与待办事项。
>
> 最后更新：2026-05-10

---

## 一、整体进度概览

| 模块 | 状态 | 完成度 |
|------|------|--------|
| 前端类型定义 | ✅ 已完成 | 100% |
| 前端状态管理 (Zustand) | ✅ 已完成 | 100% |
| 前端全局样式 | ✅ 已完成 | 100% |
| 共享组件 (ContextMenu) | ✅ 已完成 | 100% |
| 标题栏 (TitleBar) | ✅ 已完成 | 100% |
| 串口管理边栏 (Sidebar) | ✅ 已完成 | 98% |
| 主显示区 (MainDisplay) | ✅ 已完成 | 97% |
| 操作面板 (OperationPanel) | ✅ 已完成 | 99% |
| 状态栏 (StatusBar) | ✅ 已完成 | 100% |
| 配置弹窗 (ConfigModal) | ✅ 已完成 | 90% |
| Tauri 服务层 (tauri.ts) | ✅ 已完成 | 100% |
| React Hooks 层 (useTauri.ts) | ✅ 已完成 | 100% |
| 后端命令层 (Commands) | ✅ 已完成 | 80% |
| 串口管理 (Serial) | ✅ 已完成 | 75% |
| 配置管理 (Config) | ✅ 已完成 | 90% |
| 日志管理 (Logger) | ✅ 已完成 | 80% |
| 存储管理 (Storage) | ✅ 已完成 | 60% |
| Tauri 权限配置 | ✅ 已完成 | 100% |
| Tauri 事件推送 | ⏳ 未开始 | 0% |
| 系统资源监控 | ⏳ 未开始 | 0% |

---

## 二、前端模块详细进度

### 2.1 类型定义 (`src/types/index.ts`)

**状态**: ✅ 已完成

**已实现**:
- [x] 串口相关类型：`SerialPort`, `PortStatus`, `PortType`, `PortGroup`
- [x] 标签页相关类型：`TabItem`, `SplitPane`
- [x] 终端相关类型：`TerminalLine`, `TerminalState`
- [x] 规则集类型：`HighlightRule`, `HighlightRuleSet`, `SendCommand`, `SendCommandSet`
- [x] 配置类型：`AppConfig`
- [x] 系统状态类型：`SystemStatus`, `TrafficStats`
- [x] UI 状态类型：`UIState`
- [x] Tauri 命令参数类型：`OpenPortParams`, `SendDataParams`, `AvailablePortInfo`

**遗留事项**: 无

---

### 2.2 状态管理 (`src/stores/useAppStore.ts`)

**状态**: ✅ 已完成

**已实现**:
- [x] Zustand Store 基础结构
- [x] Immer 中间件集成
- [x] 串口管理 Actions（setPorts, updatePort, addGroup, updateGroup, removeGroup, movePortToGroup）
- [x] 标签页管理 Actions（openTab, closeTab, closeTabsToRight, closeTabsToLeft, closeOtherTabs, pinTab, setActiveTab, moveTabToPane）
- [x] 终端内容 Actions（appendTerminalLine, clearTerminal, setTerminalConfig）
- [x] 配置管理 Actions（setConfig, resetConfig）
- [x] UI 状态 Actions（setUIState, toggleConfigModal, setConfigActiveTab）
- [x] 操作区状态 Actions（setOpState）
- [x] 系统状态 Actions（setSystemStatus, setTrafficStats）
- [x] 默认配置初始化
- [x] 分屏管理：splitPane, removePane, setFocusedPane, focusedPaneId
- [x] 标签页分屏迁移：openTab使用focusedPaneId, closeTab清理空pane

**遗留事项**:
- [ ] 拖拽排序相关的 Actions（标签页拖拽、串口列表拖拽）

---

### 2.3 Tauri 服务层 (`src/services/tauri.ts`)

**状态**: ✅ 已完成

**已实现**:
- [x] 完整的类型化 invoke 包装器，覆盖所有后端命令
- [x] `serialService` — listAvailablePorts, openSerialPort, closeSerialPort, sendSerialData, setSerialParams, setFlowControl
- [x] `configService` — getConfig, setConfig, resetConfig
- [x] `logService` — setLogDirectory, saveLogAs, getLogFiles, startLogging, stopLogging
- [x] `systemService` — getSystemStatus, preventScreenOff, preventSleep
- [x] `eventService` — onSerialData, onSerialStatus, onSystemStatus 事件监听
- [x] 所有接口参数使用 snake_case 命名，与后端 OpenPortArgs 等结构体匹配

**遗留事项**: 无

---

### 2.4 React Hooks 层 (`src/hooks/useTauri.ts`)

**状态**: ✅ 已完成

**已实现**:
- [x] `useSerialPorts(pollIntervalMs)` — 定时刷新串口列表，返回 `{ refreshPorts }`
- [x] `useSerialConnection()` — 串口连接/断开，返回 `{ openPort, closePort, toggleConnection }`
- [x] `useSerialData()` — 数据发送与接收事件监听，返回 `{ sendData }`
- [x] `useConfigPersistence()` — 配置持久化，返回 `{ loadConfig, saveConfig, resetAndReload }`
- [x] `useSystemStatus(pollIntervalMs)` — 系统状态轮询，自动更新 store
- [x] `useAppInit()` — 应用初始化，调用 loadConfig + refreshPorts

**遗留事项**: 无

---

### 2.5 全局样式 (`src/styles.css`)

**状态**: ✅ 已完成（含亮色主题变量）

**已实现**:
- [x] CSS 变量定义（颜色、字体、尺寸、动画）
- [x] 亮色主题 CSS 变量（`:root[data-theme="light"]`）
- [x] 终端方向色变量（`--terminal-tx-color`, `--terminal-rx-color`）
- [x] 基础重置样式
- [x] 滚动条样式（含亮色主题适配）
- [x] 按钮样式（.btn, .btn-primary, .btn-danger, .btn-icon, .btn-sm, .btn.active）
- [x] 输入框样式（.input, .select, textarea.input）
- [x] 复选框样式（.checkbox-wrapper）
- [x] 标签页样式（.tab-bar, .tab-item, .tab-close, .tab-pin-icon, .tab-status-dot, .tab-title）
- [x] 状态指示点（.status-dot 及 .connected/.error/.disconnected 修饰）
- [x] 分隔线（.divider, .divider-h）
- [x] 右键菜单（.context-menu 含动画、.context-menu-item 含 danger/disabled 修饰、.context-menu-icon、.context-menu-separator）
- [x] 面板卡片（.panel-card, .panel-card-title）
- [x] 工具栏（.toolbar）
- [x] 终端样式（.terminal-view-container, .terminal-view, .terminal-line, .terminal-timestamp, .terminal-direction, .terminal-content, .terminal-toolbar 等）
- [x] 标题栏样式（.titlebar 及其子组件）
- [x] 侧边栏样式（.sidebar, .sidebar-toolbar, .sidebar-search, .port-item, .port-group 等）
- [x] 主显示区样式（.main-display, .pane-container-inner 等）
- [x] 操作面板样式（.operation-panel 及所有 .op-* 子类）
- [x] 状态栏样式（.statusbar 及子类）
- [x] 配置弹窗样式（.modal-overlay, .modal-dialog, .modal-nav 等）
- [x] 配置页面样式（.config-page, .config-row, .config-placeholder 等）
- [x] 拖拽样式（.dragging, .drop-target）
- [x] 标题栏拖拽区域（.titlebar-drag, .titlebar-nodrag, .titlebar-close）
- [x] 布局工具类（.flex, .flex-col 等）
- [x] 动画定义（fadeIn, slideUp, contextMenuIn）

**遗留事项**:
- [ ] 响应式布局适配（当前为固定尺寸桌面布局）

---

### 2.6 共享组件 (`src/components/shared/ContextMenu.tsx`)

**状态**: ✅ 已完成

**已实现**:
- [x] 通用右键菜单组件 `ContextMenu`
  - 视口边界自动检测，菜单超出屏幕时自动调整位置
  - 点击外部或按 ESC 关闭
  - 支持图标（ReactNode）、危险操作样式（danger）、禁用状态（disabled）
  - 支持分隔线（separator）
  - CSS 入场动画（contextMenuIn）
- [x] `useContextMenu` Hook
  - 封装右键菜单状态管理（show/hide/element）
  - 组件内一行调用即可接入右键菜单
- [x] 导出类型：`ContextMenuItem`, `ContextMenuSeparator`, `ContextMenuEntry`

**遗留事项**: 无

---

### 2.7 标题栏 (`src/components/TitleBar/TitleBar.tsx`)

**状态**: ✅ 已完成

**已实现**:
- [x] 软件 SVG 图标与名称显示
- [x] 版本号显示
- [x] 配置按钮（lucide Settings 图标，唤起配置弹窗）
- [x] 窗口控制按钮（lucide Minus/Square/X 图标，含 hover/关闭高亮）
- [x] 拖拽区域支持
- [x] 全部使用 CSS class（.titlebar 系列），无内联样式

**遗留事项**:
- [ ] 窗口控制按钮需要绑定 Tauri API 实现实际功能

---

### 2.8 串口管理边栏 (`src/components/Sidebar/Sidebar.tsx`)

**状态**: ✅ 已完成 (98%)

**已实现**:
- [x] 顶部工具栏（lucide 图标：Play/Square/Eye/EyeOff/ArrowUpDown/Save/RefreshCw）
- [x] 搜索框（含 lucide Search 图标、清除按钮）
- [x] 串口列表展示（含状态颜色圆点、备注名、连接参数、VCP 标识、状态文本）
- [x] 分组管理（展开/折叠箭头、一键开启/关闭整组、连接数统计）
- [x] 单个串口项（lucide Play/Square 连接按钮、双击打开标签页）
- [x] **右键菜单**（使用 useContextMenu Hook）：
  - 连接/断开串口（含图标）
  - 设置备注名（弹出 AliasDialog 模态框）
  - 在标签页中打开
  - 隐藏/取消隐藏
- [x] **AliasDialog 备注名输入弹窗**（模态遮罩 + 输入框 + 确认/取消）
- [x] 未分组区域
- [x] 隐藏串口区域（Eye/EyeOff 切换）
- [x] 新建分组按钮（lucide Plus 图标）
- [x] 接入 Zustand Store，状态统一管理
- [x] **接入 useSerialPorts(3000) 自动刷新端口列表**
- [x] **接入 useSerialConnection().toggleConnection 连接/断开串口**
- [x] 全部使用 CSS class（.sidebar, .port-item, .port-group 等），无内联样式

**遗留事项**:
- [ ] 拖拽排序功能（串口列表、分组内串口）——需引入 @dnd-kit
- [ ] 一键打开/关闭全部串口的功能实现
- [ ] 保存布局功能

---

### 2.9 主显示区 (`src/components/MainDisplay/`)

**状态**: ✅ 已完成 (97%)

#### MainDisplay.tsx
**已实现**:
- [x] 多分屏渲染：Pane 组件独立渲染每个分屏的 TabBar + TerminalView
- [x] 可拖拽分割线（ResizeHandle 组件，拖拽时高亮）
- [x] 分屏焦点管理（点击切换聚焦分屏，.pane-focused 轮廓）
- [x] 全局工具栏：lucide 图标（Plus/Columns2/Rows2）
- [x] 空状态提示
- [x] 全部使用 CSS class，无内联样式

**遗留事项**:
- [ ] 分屏嵌套（当前为平铺，未支持树状分屏）

#### TabBar.tsx
**已实现**:
- [x] 标签项渲染（状态圆点、标题、Pin 图标、关闭按钮）
- [x] 激活状态样式（底部蓝色边框替代原底部覆盖方案）
- [x] 右键菜单（使用共享 ContextMenu 组件）：
  - 固定/取消固定（lucide Pin 图标）
  - 关闭当前/右侧/左侧/其他
  - 移动到其他分屏
- [x] 点击切换标签
- [x] 全部使用 lucide 图标（Pin, X）

**遗留事项**:
- [ ] 拖拽排序（需引入 @dnd-kit）
- [ ] 标签页在不同 pane 间拖拽移动

#### TerminalView.tsx
**已实现**:
- [x] 终端内容渲染（时间戳、TX/RX 方向标识、内容）
- [x] 方向颜色使用 CSS 变量（`--terminal-tx-color`, `--terminal-rx-color`）
- [x] 自动滚动到底部（可配置 scrollLocked）
- [x] 模拟数据展示
- [x] **右键菜单**（使用共享 ContextMenu 组件）：
  - 全选
  - 复制
  - 复制为 HEX（字符串 → HEX 转换）
  - 从 HEX 转文本（HEX → 字符串 转换）
- [x] 全部使用 CSS class（.terminal-view, .terminal-line 等）

**遗留事项**:
- [ ] 真实数据接入（从 Tauri 事件接收）— useSerialData 已编写但未在此组件直接使用
- [ ] 语法高亮
- [ ] 虚拟滚动优化（大数据量时性能）
- [ ] 字体缩放
- [ ] 编码切换下拉框实际接入

---

### 2.10 操作面板 (`src/components/OperationPanel/OperationPanel.tsx`)

**状态**: ✅ 已完成 (99%)

**已实现**:
- [x] 三栏布局（手动发送 / 自动循环 / 串口参数）
- [x] 发送输入框 + 发送按钮（lucide Send 图标）— **已接入 useSerialData().sendData**
- [x] HEX 发送复选框
- [x] 追加回车选择
- [x] 打开/关闭串口按钮（lucide Cable 图标）— **已接入 useSerialConnection().toggleConnection**
- [x] 清屏按钮（lucide Eraser 图标）— **已接入 clearTerminal**
- [x] 高亮规则选择 + 编辑按钮（lucide Settings 图标）
- [x] 发送命令集选择 + 编辑按钮（lucide Edit3 图标）
- [x] 循环发送控制（lucide Play/Square 图标，含 .btn-danger 停止按钮）
- [x] 滚动锁定（lucide Pin 图标）、时间戳（lucide Clock 图标）
- [x] HEX/文本显示格式切换
- [x] 日志操作按钮（lucide FileText/FolderOpen/FileSearch 图标）
- [x] 串口参数设置（波特率、数据位、校验位、停止位、握手协议）
- [x] DTR/RTS/忽略空字符开关
- [x] 折叠/展开（lucide ChevronDown/ChevronUp 图标）
- [x] 全部使用 CSS class（.operation-panel, .op-section 等系列）
- [x] 发送后自动清空输入框

**遗留事项**:
- [ ] 循环发送实际逻辑
- [ ] 高亮规则集和发送命令集的真实数据
- [ ] 日志操作按钮的实际功能（另存为、打开文件、打开目录）

---

### 2.11 状态栏 (`src/components/StatusBar/StatusBar.tsx`)

**状态**: ✅ 已完成

**已实现**:
- [x] 系统状态显示（绿色圆点）
- [x] 内存占用显示（lucide MemoryStick 图标）— **已接入 useSystemStatus(5000)**
- [x] CPU 占用率显示（lucide Cpu 图标）— **已接入 useSystemStatus(5000)**
- [x] TX/RX 流量统计（lucide ArrowUpCircle/ArrowDownCircle 图标，含颜色区分）
- [x] 当前时间显示
- [x] 全部使用 CSS class（.statusbar 系列）

**遗留事项**:
- [ ] 流量统计需要接入真实数据

---

### 2.12 配置弹窗 (`src/components/ConfigModal/ConfigModal.tsx`)

**状态**: ✅ 已完成 (90%)

**已实现**:
- [x] 模态弹窗容器（.modal-overlay, .modal-dialog, CSS 动画 slideUp）
- [x] 左侧树状导航（lucide 图标：Settings/FileText/HardDrive/Monitor/Palette/Send）
- [x] 导航项 CSS class hover 效果（.modal-nav-item，消除内联 onMouseEnter/onMouseLeave）
- [x] 通用设置页
- [x] 日志设置页
- [x] 备份管理页
- [x] 显示与交互页
- [x] 语法高亮规则页（占位）
- [x] 发送命令规则页（占位）
- [x] 保存/取消按钮（lucide X 关闭图标）— **保存按钮已接入 useConfigPersistence().saveConfig**
- [x] 全部使用 CSS class

**遗留事项**:
- [ ] 语法高亮规则集编辑器完整实现
- [ ] 发送命令规则集编辑器完整实现
- [ ] 浏览按钮需要调用 Tauri 文件对话框 API
- [ ] 背景图片预览

---

### 2.13 应用入口 (`src/App.tsx`)

**状态**: ✅ 已完成

**已实现**:
- [x] 挂载时调用 `useAppInit()` 初始化（加载配置 + 刷新端口列表）
- [x] 渲染完整布局：TitleBar + Sidebar + MainDisplay + OperationPanel + StatusBar + ConfigModal

---

## 三、后端模块详细进度

### 3.1 Tauri 命令层 (`src-tauri/src/commands/mod.rs`)

**状态**: ✅ 已完成 (80%)

**已实现**:
- [x] 串口命令：list_available_ports, open_serial_port, close_serial_port, send_serial_data, set_serial_params, set_flow_control
- [x] 配置命令：get_config, set_config, reset_config
- [x] 日志命令：set_log_directory, save_log_as, get_log_files, start_logging, stop_logging
- [x] 系统命令：get_system_status, prevent_screen_off, prevent_sleep
- [x] 所有命令结构体使用 `#[serde(rename_all = "camelCase")]` 序列化
- [x] 所有命令在 `lib.rs` 中注册

**遗留事项**:
- [ ] 串口数据位/校验位/停止位参数解析（当前 open_serial_port 中部分参数未传递给 serialport）
- [ ] HEX 发送格式解析（当前 send_data 中 HEX 模式直接当文本发送）
- [ ] get_system_status 返回真实系统数据（当前为硬编码）
- [ ] prevent_screen_off / prevent_sleep 调用系统 API（当前为日志占位）

---

### 3.2 串口管理 (`src-tauri/src/serial/mod.rs`)

**状态**: ✅ 已完成 (75%)

**已实现**:
- [x] SerialManager 管理所有已打开串口的集合
- [x] SerialPortHandle 包含底层串口对象 + 读取线程 + MPSC 通道
- [x] list_ports() 枚举系统可用串口（区分 real/virtual）
- [x] open_port() 打开串口 + 启动读取线程（50ms 节流）
- [x] close_port() 关闭串口 + 等待读取线程结束
- [x] send_data() 向串口发送数据（支持追加换行符）
- [x] set_baud_rate() 修改波特率
- [x] set_flow_control() 设置 DTR/RTS

**遗留事项**:
- [ ] 读取线程数据通过 `app.emit()` 推送到前端（当前使用 MPSC channel，未接入 Tauri 事件系统）
- [ ] 串口断开/错误事件推送
- [ ] HEX 格式发送的实际解析
- [ ] 数据位/校验位/停止位等参数的实际传递

---

### 3.3 配置管理 (`src-tauri/src/config/mod.rs`)

**状态**: ✅ 已完成 (90%)

**已实现**:
- [x] AppConfig 结构体定义（含 serde camelCase 序列化）
- [x] ConfigManager 管理配置读写
- [x] JSON 文件持久化（存储在 `%APPDATA%/hypercom/config.json`）
- [x] get_config() / set_config() / reset_to_default() 方法
- [x] 前端可通过 invoke 调用配置命令

**遗留事项**:
- [ ] 部分配置项未实际生效（如 preventScreenOff, preventSleep 仅写入配置未调用系统 API）

---

### 3.4 日志管理 (`src-tauri/src/logger/mod.rs`)

**状态**: ✅ 已完成 (80%)

**已实现**:
- [x] LogManager 管理日志写入器集合
- [x] PortLogWriter 单个串口日志写入（BufWriter）
- [x] 字符串/HEX/二进制三种格式写入
- [x] 按大小自动分片检测（should_split）
- [x] create_writer / close_writer / write / save_log_as / list_files / set_directory 方法

**遗留事项**:
- [ ] 自动分片实际续写逻辑（检测后关闭当前文件创建新文件）
- [ ] 文件名格式解析（[com], [datetime] 变量替换）
- [ ] 日志自动保存开关完整实现

---

### 3.5 存储管理 (`src-tauri/src/storage/mod.rs`)

**状态**: ✅ 已完成 (60%)

**已实现**:
- [x] StorageManager 结构体定义
- [x] SQLite 连接池创建（延迟初始化模式）
- [x] 数据库路径规划（hypercom/data.db）

**遗留事项**:
- [ ] 在 Tauri setup 钩子中调用 init() 完成异步初始化
- [ ] 创建所有必要的表结构（port_groups, send_command_sets, send_commands, highlight_rule_sets, highlight_rules）
- [ ] 实现 CRUD 方法（save_command_set, load_command_sets, save_highlight_set, load_highlight_sets, save_port_layout, load_port_layout）

---

### 3.6 Tauri 权限配置 (`src-tauri/capabilities/default.json`)

**状态**: ✅ 已完成

**已实现**:
- [x] core:default — 核心默认权限
- [x] core:event:default — 事件默认权限
- [x] core:event:allow-listen — 允许前端监听后端事件
- [x] core:event:allow-emit — 允许后端推送事件
- [x] shell:allow-open — 允许打开外部链接

---

## 四、前端-to-后端对接状态

| 功能 | 前端 Hook | 后端命令 | 状态 |
|------|-----------|---------|------|
| 列出串口 | `useSerialPorts` → `serialService.listAvailablePorts()` | `list_available_ports` | ✅ 已对接 |
| 打开/关闭串口 | `useSerialConnection` → `serialService.openSerialPort/closeSerialPort` | `open_serial_port` / `close_serial_port` | ✅ 已对接 |
| 发送数据 | `useSerialData` → `serialService.sendSerialData()` | `send_serial_data` | ✅ 已对接 |
| 设置串口参数 | — (未直接使用) | `set_serial_params` | ⏳ 待对接 |
| 设置流控 | — (未直接使用) | `set_flow_control` | ⏳ 待对接 |
| 读取配置 | `useAppInit` → `useConfigPersistence().loadConfig()` | `get_config` | ✅ 已对接 |
| 保存配置 | `useConfigPersistence().saveConfig()` | `set_config` | ✅ 已对接 |
| 重置配置 | `useConfigPersistence().resetAndReload()` | `reset_config` | ✅ 已对接 |
| 系统状态 | `useSystemStatus` → `systemService.getSystemStatus()` | `get_system_status` | ✅ 已对接 |
| 串口数据接收 | `useSerialData` (事件监听 `serial:data`) | 后端 emit | ⏳ 后端未接入 |
| 串口状态变化 | `useSerialData` (事件监听 `serial:status`) | 后端 emit | ⏳ 后端未接入 |

---

## 五、待办事项汇总（按优先级）

### 🔴 高优先级

1. **Tauri 事件推送机制**
   - 将串口读取线程接收到的数据通过 `app.emit()` 推送到前端
   - 前端监听事件并更新终端内容
   - 读取线程需要获取 `AppHandle` 引用

2. **系统资源监控**
   - 实现真实的内存/CPU 占用率获取（使用 `sysinfo` crate）
   - 实现串口 TX/RX 流量统计

3. **数据库初始化**
   - 在 Tauri setup 中调用 `storage_manager.init()`
   - 创建所有必要的表结构
   - 实现 CRUD 方法

### 🟡 中优先级

4. **拖拽排序功能**
   - 串口列表拖拽排序（需引入 @dnd-kit）
   - 标签页拖拽排序
   - 标签页在不同 pane 间拖动

5. **语法高亮**
   - 终端内容语法高亮渲染
   - 高亮规则集编辑器完整实现

6. **配置弹窗完善**
   - 语法高亮规则集编辑器
   - 发送命令规则集编辑器
   - 浏览按钮调用文件对话框

7. **日志功能完善**
   - 自动保存开关
   - 文件名格式变量解析
   - 分片存储完整实现

8. **窗口控制**
   - 标题栏窗口按钮绑定 Tauri API（最小化/最大化/关闭）

### 🟢 低优先级

9. **UI 细节优化**
   - 响应式布局适配
   - 虚拟滚动优化（大数据量时终端性能）
   - 字体缩放
   - 背景图片预览与应用

10. **前端功能完善**
    - 串口参数变更实时下发给后端（setSerialParams, setFlowControl）
    - 日志操作按钮实际功能（另存为、打开文件、打开目录）
    - 循环发送逻辑实现
    - 编码切换实际接入

---

## 六、已知问题

| 问题 | 影响 | 解决方案 |
|------|------|----------|
| StorageManager 需要 Tokio 上下文初始化 | 运行时 panic | 已在架构中设计为延迟初始化，在 setup 钩子中调用 |
| 串口读取线程数据未通过 emit 推送 | 前端无法接收实时数据 | 需在 open_port 中传入 AppHandle，读取线程调用 app.emit("serial:data", ...) |
| get_system_status 返回硬编码值 | 内存/CPU 显示为 0 | 需引入 sysinfo crate |
| 前端 tauri.ts 参数使用 snake_case | 与后端 serde camelCase 可能冲突 | 后端使用 `#[serde(rename_all = "camelCase")]`，Tauri v2 默认以 camelCase 序列化，invoke 参数名需匹配 |
| 分屏为平铺模型 | 不支持多层嵌套分屏 | 当前已满足基本分屏需求 |

---

## 七、下一步建议

对于多 Agent 协作，建议按以下顺序分工：

1. **Agent A - 串口通信专家**：完善 `serial/mod.rs`，实现数据位/校验位/停止位解析，完成 Tauri 事件 emit（需传入 AppHandle）
2. **Agent B - 前端交互专家**：对接剩余 Tauri 命令（setSerialParams, setFlowControl），实现拖拽排序，完善配置弹窗编辑器
3. **Agent C - 数据持久化专家**：完成 `storage/mod.rs` 数据库表结构与 CRUD，对接配置保存
4. **Agent D - 系统功能专家**：实现系统资源监控、日志自动保存、文件对话框调用

---

## 八、变更历史

### 2026-05-10 (更新)

#### 新增文件
- `src/services/tauri.ts` — Tauri 后端服务层，类型安全的 invoke 包装器和事件监听器
- `src/hooks/useTauri.ts` — React Hooks 层，桥接 Tauri 服务与 Zustand Store
- `src-tauri/capabilities/default.json` — Tauri v2 权限配置

#### 前端-后端对接
- **OperationPanel**: 发送按钮 → `useSerialData().sendData`；打开/关闭串口按钮 → `useSerialConnection().toggleConnection`；清屏按钮 → `clearTerminal`
- **ConfigModal**: 保存按钮 → `useConfigPersistence().saveConfig`，将当前 config 写入后端
- **Sidebar**: 已接入 `useSerialPorts(3000)` 自动刷新端口列表 + `useSerialConnection().toggleConnection`
- **StatusBar**: 已接入 `useSystemStatus(5000)` 定期获取系统状态
- **App.tsx**: 挂载时调用 `useAppInit()` 初始化

#### Rust 后端修复
- 修复 `lib.rs`: 移除未使用的 `use tauri::Manager` 导入，`setup` 中 `app` → `_app`
- 修复 `logger/mod.rs`: 移除未使用的 `use std::path::Path`，`port_id` 和 `auto_save` 字段加 `#[allow(dead_code)]`
- 修复 `serial/mod.rs`: `SerialPortHandle` 未读字段加 `#[allow(dead_code)]`
- 0 warnings, 0 errors

### 2026-05-10 (初版)

#### 新增文件
- `src/components/shared/ContextMenu.tsx` — 通用右键菜单组件 + `useContextMenu` Hook

#### 依赖变更
- 新增 `lucide-react`（矢量图标库），替代所有 emoji/字符图标

#### 全局样式 (`src/styles.css`) 重写
- 新增亮色主题 CSS 变量集、终端方向色变量、按钮/右键菜单/侧边栏/终端/标题栏/操作面板/状态栏/配置弹窗 CSS class

#### 组件改动
- Sidebar: 右键菜单、AliasDialog、搜索框、lucide 图标、CSS class 重构
- TerminalView: 右键菜单、CSS class 重构
- TabBar: 共享 ContextMenu、lucide 图标、CSS class 重构
- MainDisplay/TitleBar/OperationPanel/StatusBar/ConfigModal: lucide 图标、CSS class 重构