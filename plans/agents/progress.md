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
| 操作面板 (OperationPanel) | ✅ 已完成 | 98% |
| 状态栏 (StatusBar) | ✅ 已完成 | 100% |
| 配置弹窗 (ConfigModal) | ✅ 已完成 | 85% |
| 后端命令层 (Commands) | ✅ 已完成 | 80% |
| 串口管理 (Serial) | ✅ 已完成 | 75% |
| 配置管理 (Config) | ✅ 已完成 | 90% |
| 日志管理 (Logger) | ✅ 已完成 | 80% |
| 存储管理 (Storage) | ✅ 已完成 | 60% |
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
- [ ] 未集成 Tauri 命令调用（目前所有数据为前端模拟）

---

### 2.3 全局样式 (`src/styles.css`)

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

### 2.4 共享组件 (`src/components/shared/ContextMenu.tsx`)

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

### 2.5 标题栏 (`src/components/TitleBar/TitleBar.tsx`)

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

### 2.6 串口管理边栏 (`src/components/Sidebar/Sidebar.tsx`)

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
- [x] 接入 Zustand Store，状态统一管理，初始化模拟数据
- [x] 全部使用 CSS class（.sidebar, .port-item, .port-group 等），无内联样式

**遗留事项**:
- [ ] 拖拽排序功能（串口列表、分组内串口）——需引入 @dnd-kit
- [ ] 从后端获取真实串口列表（目前为 mock 数据）
- [ ] 保存布局功能
- [ ] 一键打开/关闭全部串口的功能实现

---

### 2.7 主显示区 (`src/components/MainDisplay/`)

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
- [ ] 真实数据接入（从 Tauri 事件接收）
- [ ] 语法高亮
- [ ] 虚拟滚动优化（大数据量时性能）
- [ ] 字体缩放
- [ ] 编码切换下拉框实际接入

---

### 2.8 操作面板 (`src/components/OperationPanel/OperationPanel.tsx`)

**状态**: ✅ 已完成 (98%)

**已实现**:
- [x] 三栏布局（手动发送 / 自动循环 / 串口参数）
- [x] 发送输入框 + 发送按钮（lucide Send 图标）
- [x] HEX 发送复选框
- [x] 追加回车选择
- [x] 打开/关闭串口按钮（lucide Cable 图标）
- [x] 清屏按钮（lucide Eraser 图标）
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

**遗留事项**:
- [ ] 发送按钮实际调用 Tauri 命令
- [ ] 循环发送实际逻辑
- [ ] 高亮规则集和发送命令集的真实数据
- [ ] 日志操作按钮的实际功能

---

### 2.9 状态栏 (`src/components/StatusBar/StatusBar.tsx`)

**状态**: ✅ 已完成

**已实现**:
- [x] 系统状态显示（绿色圆点）
- [x] 内存占用显示（lucide MemoryStick 图标）
- [x] CPU 占用率显示（lucide Cpu 图标）
- [x] TX/RX 流量统计（lucide ArrowUpCircle/ArrowDownCircle 图标，含颜色区分）
- [x] 当前时间显示
- [x] 全部使用 CSS class（.statusbar 系列）

**遗留事项**:
- [ ] 系统资源监控需要接入真实数据（目前为静态值）
- [ ] 流量统计需要接入真实数据

---

### 2.10 配置弹窗 (`src/components/ConfigModal/ConfigModal.tsx`)

**状态**: ✅ 已完成 (85%)

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
- [x] 保存/取消按钮（lucide X 关闭图标）
- [x] 全部使用 CSS class

**遗留事项**:
- [ ] 语法高亮规则集编辑器完整实现
- [ ] 发送命令规则集编辑器完整实现
- [ ] 配置持久化到后端
- [ ] 浏览按钮需要调用 Tauri 文件对话框 API
- [ ] 背景图片预览

---

## 三、后端模块详细进度

> 后端模块本次未修改，进度与上次相同，详见各子节。

（后端内容与之前文档一致，此处省略以保持简洁，完整内容见前一版文档。）

---

## 四、待办事项汇总（按优先级）

### 🔴 高优先级

1. **Tauri 事件推送机制**
   - 将串口读取线程接收到的数据通过 `app.emit()` 推送到前端
   - 前端监听事件并更新终端内容

2. **前端与后端命令对接**
   - 在 Zustand Actions 中调用 `invoke()` 触发后端命令
   - 串口打开/关闭/发送数据
   - 配置读取/保存

3. **系统资源监控**
   - 实现真实的内存/CPU 占用率获取
   - 实现串口 TX/RX 流量统计

4. **数据库初始化**
   - 在 Tauri setup 中调用 `storage_manager.init()`
   - 创建所有必要的表结构

### 🟡 中优先级

5. **拖拽排序功能**
   - 串口列表拖拽排序（需引入 @dnd-kit）
   - 标签页拖拽排序
   - 标签页在不同 pane 间拖动

6. **语法高亮**
   - 终端内容语法高亮渲染
   - 高亮规则集编辑器完整实现

7. **配置弹窗完善**
   - 语法高亮规则集编辑器
   - 发送命令规则集编辑器
   - 浏览按钮调用文件对话框

8. **日志功能完善**
   - 自动保存开关
   - 文件名格式变量解析
   - 分片存储完整实现

### 🟢 低优先级

9. **UI 细节优化**
   - 响应式布局适配
   - 虚拟滚动优化（大数据量时终端性能）
   - 字体缩放
   - 背景图片预览与应用

10. **前端功能完善**
    - 串口编码切换实际接入
    - 终端工具栏编码下拉框功能
    - 串口列表一键打开/关闭全部功能实现

---

## 五、已知问题

| 问题 | 影响 | 解决方案 |
|------|------|----------|
| StorageManager 需要 Tokio 上下文初始化 | 运行时 panic | 已在架构中设计为延迟初始化，在 setup 钩子中调用 |
| 部分组件存在未使用变量警告 | 编译警告 | 已处理主要问题，剩余为预留接口 |
| 分屏为平铺模型，不支持嵌套 | 无法创建多层分屏 | 当前已满足基本分屏需求，嵌套分屏为后续优化 |

---

## 六、下一步建议

对于多 Agent 协作，建议按以下顺序分工：

1. **Agent A - 串口通信专家**：完善 `serial/mod.rs`，实现数据位/校验位/停止位解析，完成 Tauri 事件 emit
2. **Agent B - 前端交互专家**：对接 Tauri 命令，实现拖拽排序，完善配置弹窗编辑器
3. **Agent C - 数据持久化专家**：完成 `storage/mod.rs` 数据库表结构与 CRUD，对接配置保存
4. **Agent D - 系统功能专家**：实现系统资源监控、日志自动保存、文件对话框调用

---

## 七、本次更新摘要 (2026-05-10)

### 新增文件
- `src/components/shared/ContextMenu.tsx` — 通用右键菜单组件 + `useContextMenu` Hook

### 依赖变更
- 新增 `lucide-react`（矢量图标库），替代所有 emoji/字符图标

### 全局样式 (`src/styles.css`) 重写
- 新增亮色主题 CSS 变量集（`:root[data-theme="light"]`）
- 新增终端方向色变量（`--terminal-tx-color`, `--terminal-rx-color`）
- 新增 `.btn-danger`, `.btn.active` 按钮样式
- 新增 `.context-menu` 动画（`contextMenuIn`），含 `.context-menu-item.danger`, `.disabled`, `.context-menu-icon`
- 新增侧边栏组件 CSS（`.sidebar-*` 系列：`.sidebar-toolbar`, `.sidebar-search-*`, `.port-item-*`, `.port-group-*`）
- 新增终端组件 CSS（`.terminal-*` 系列：`.terminal-view-container`, `.terminal-view`, `.terminal-line`, `.terminal-toolbar-*`）
- 新增标题栏 CSS（`.titlebar-*` 系列：`.titlebar-left`, `.titlebar-right`, `.titlebar-separator`, `.titlebar-control`, `.titlebar-close`）
- 新增操作面板 CSS（`.operation-panel-*`, `.op-*` 系列）
- 新增状态栏 CSS（`.statusbar-*` 系列）
- 新增配置弹窗 CSS（`.modal-overlay`, `.modal-dialog`, `.modal-nav-*`, `.modal-content-*`, `.config-page-*`）
- 新增别名弹窗 CSS（`.modal-dialog-title`, `.modal-dialog-input`, `.modal-dialog-actions`）
- 新增主显示区 CSS（`.main-display-*`, `.pane-container-inner`）
- 修复 `fontWeight` → `font-weight`, `fontSize` → `font-size` CSS 属性
- 消除所有组件内联 hover/onMouseLeave 事件处理，统一由 CSS 管理

### 组件改动

| 组件 | 变更 |
|------|------|
| **Sidebar** | 新增右键菜单（连接/断开、设置备注名、在标签页打开、隐藏/取消隐藏）；新增 AliasDialog 备注名弹窗；新增搜索框图标和清除按钮；所有图标换为 lucide；CSS class 重构消除内联样式 |
| **TerminalView** | 新增右键菜单（全选、复制、复制为 HEX、从 HEX 转文本）；CSS class 重构 |
| **TabBar** | 使用共享 ContextMenu 组件替代内联实现；Pin/X 使用 lucide 图标；CSS class 重构 |
| **MainDisplay** | 分屏按钮使用 lucide 图标（Plus/Columns2/Rows2）；CSS class 重构 |
| **TitleBar** | 所有图标换为 lucide（Settings/Minus/Square/X）；新增 SVG 占位图标；CSS class 重构 |
| **OperationPanel** | 所有图标换为 lucide（Send/Cable/Eraser/Pin/Clock/FileText/FolderOpen 等）；停止按钮使用 `.btn-danger` 样式；CSS class 重构 |
| **StatusBar** | 所有图标换为 lucide（Cpu/MemoryStick/ArrowUpCircle/ArrowDownCircle）；CSS class 重构 |
| **ConfigModal** | 导航图标换为 lucide；hover 效果改用 CSS class（消除内联 onMouseEnter/onMouseLeave）；关闭按钮换为 lucide X 图标；CSS class 重构 |