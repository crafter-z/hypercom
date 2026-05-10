# HyperCom 项目进度与遗留事项

> 本文档面向多 Agent 协作开发，标识当前各模块的完成状态、已实现功能与待办事项。
>
> 最后更新：2026-05-06

---

## 一、整体进度概览

| 模块 | 状态 | 完成度 |
|------|------|--------|
| 前端类型定义 | ✅ 已完成 | 100% |
| 前端状态管理 (Zustand) | ✅ 已完成 | 100% |
| 前端全局样式 | ✅ 已完成 | 100% |
| 标题栏 (TitleBar) | ✅ 已完成 | 100% |
| 串口管理边栏 (Sidebar) | ✅ 已完成 | 95% |
| 主显示区 (MainDisplay) | ✅ 已完成 | 95% |
| 操作面板 (OperationPanel) | ✅ 已完成 | 95% |
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
- [x] **分屏管理**：splitPane (支持水平/垂直), removePane, setFocusedPane, focusedPaneId
- [x] **标签页分屏迁移**：openTab使用focusedPaneId, closeTab清理空pane

**遗留事项**:
- [ ] 拖拽排序相关的 Actions（标签页拖拽、串口列表拖拽）
- [ ] 未集成 Tauri 命令调用（目前所有数据为前端模拟）

---

### 2.3 全局样式 (`src/styles.css`)

**状态**: ✅ 已完成

**已实现**:
- [x] CSS 变量定义（颜色、字体、尺寸、动画）
- [x] 基础重置样式
- [x] 滚动条样式
- [x] 按钮样式（.btn, .btn-primary, .btn-icon, .btn-sm）
- [x] 输入框样式（.input, .select）
- [x] 复选框样式（.checkbox-wrapper）
- [x] 标签页样式（.tab-bar, .tab-item）
- [x] 状态指示点（.status-dot）
- [x] 分隔线（.divider, .divider-h）
- [x] 右键菜单（.context-menu）
- [x] 面板卡片（.panel-card）
- [x] 工具栏（.toolbar）
- [x] 终端文字（.terminal-text）
- [x] 拖拽样式（.dragging, .drop-target）
- [x] 标题栏拖拽区域（.titlebar-drag, .titlebar-nodrag）
- [x] 布局工具类（.flex, .flex-col, .flex-1 等）
- [x] 动画定义（fadeIn, slideUp）

**遗留事项**:
- [ ] 亮色主题变量未定义（当前仅暗色主题）
- [ ] 响应式布局适配（当前为固定尺寸桌面布局）

---

### 2.4 标题栏 (`src/components/TitleBar/TitleBar.tsx`)

**状态**: ✅ 已完成

**已实现**:
- [x] 软件图标与名称显示
- [x] 配置按钮（唤起配置弹窗）
- [x] 窗口控制按钮（最小化/最大化/关闭）占位
- [x] 拖拽区域支持

**遗留事项**:
- [ ] 窗口控制按钮需要绑定 Tauri API 实现实际功能
- [ ] 需要安装 `lucide-react` 替换临时字符图标

---

### 2.5 串口管理边栏 (`src/components/Sidebar/Sidebar.tsx`)

**状态**: ✅ 已完成 (95%)

**已实现**:
- [x] 顶部工具栏（一键打开/关闭全部、显示/隐藏、排序、保存布局、刷新）
- [x] 搜索框（支持按串口名和备注名过滤）
- [x] 串口列表展示（含状态颜色条、备注名、连接参数、VCP标识）
- [x] 分组管理（展开/折叠、一键开启/关闭整组）
- [x] 单个串口项（连接/断开按钮、双击打开标签页）
- [x] 未分组区域
- [x] 隐藏串口区域
- [x] 新建分组按钮
- [x] **接入Zustand Store**，状态统一管理，初始化模拟数据

**遗留事项**:
- [ ] 拖拽排序功能（串口列表、分组内串口）
- [ ] 右键菜单实现（设置备注、隐藏/显示、打开/关闭）
- [ ] 从后端获取真实串口列表（目前为 mock 数据）
- [ ] 保存布局功能

---

### 2.6 主显示区 (`src/components/MainDisplay/`)

**状态**: ✅ 已完成 (95%)

#### MainDisplay.tsx
**已实现**:
- [x] **多分屏渲染**：Pane组件独立渲染每个分屏的TabBar+TerminalView
- [x] **可拖拽分割线**：鼠标拖拽调整分屏大小比例
- [x] **分屏焦点管理**：点击切换聚焦分屏，聚焦态有视觉轮廓
- [x] 全局工具栏：新建标签、左右分屏、上下分屏按钮
- [x] 空状态提示

**遗留事项**:
- [ ] 分屏嵌套（当前为平铺，未支持树状分屏）

#### TabBar.tsx
**已实现**:
- [x] 标签项渲染（状态点、标题、固定标记、关闭按钮）
- [x] 激活状态样式
- [x] 右键菜单（固定/取消固定、关闭当前/右侧/左侧/其他）
- [x] 点击切换标签
- [x] **移动到其他分屏**：右键菜单显示目标分屏列表

**遗留事项**:
- [ ] 拖拽排序
- [ ] 标签页在不同 pane 间拖动

#### TerminalView.tsx
**已实现**:
- [x] 终端内容渲染（时间戳、方向标识、内容）
- [x] 自动滚动到底部（可配置 scrollLocked）
- [x] 模拟数据展示
- [x] 右键菜单占位

**遗留事项**:
- [ ] 真实数据接入（从 Tauri 事件接收）
- [ ] 语法高亮
- [ ] 右键菜单实现（全选、复制、HEX 转换）
- [ ] 虚拟滚动优化（大数据量时性能）
- [ ] 字体缩放

---

### 2.7 操作面板 (`src/components/OperationPanel/OperationPanel.tsx`)

**状态**: ✅ 已完成 (95%)

**已实现**:
- [x] 三栏布局（手动发送 / 自动循环 / 串口参数）
- [x] 发送输入框 + 发送按钮（垂直文字"发送"）
- [x] HEX 发送复选框
- [x] 追加回车选择（\r\n / \r / \n / 无）
- [x] 打开/关闭串口按钮
- [x] 清屏按钮
- [x] 高亮规则选择 + 编辑按钮
- [x] 发送命令集选择 + 编辑按钮
- [x] 循环发送控制（开始/停止、间隔）
- [x] 滚动锁定、时间戳复选框
- [x] HEX/文本显示格式切换
- [x] 日志操作按钮（另存为、打开文件、打开目录）
- [x] 串口参数设置（波特率、数据位、校验位、停止位、握手协议）
- [x] DTR/RTS/忽略空字符开关
- [x] **折叠/展开**：点击标题栏收起操作面板，再次点击展开

**遗留事项**:
- [ ] 发送按钮实际调用 Tauri 命令
- [ ] 循环发送实际逻辑
- [ ] 高亮规则集和发送命令集的真实数据
- [ ] 日志操作按钮的实际功能

---

### 2.8 状态栏 (`src/components/StatusBar/StatusBar.tsx`)

**状态**: ✅ 已完成

**已实现**:
- [x] 系统状态显示
- [x] 内存占用显示
- [x] CPU 占用率显示
- [x] TX/RX 流量统计
- [x] 当前时间显示

**遗留事项**:
- [ ] 系统资源监控需要接入真实数据（目前为静态值）
- [ ] 流量统计需要接入真实数据

---

### 2.9 配置弹窗 (`src/components/ConfigModal/ConfigModal.tsx`)

**状态**: ✅ 已完成 (85%)

**已实现**:
- [x] 模态弹窗容器
- [x] 左侧树状导航（6个设置页）
- [x] 通用设置页（关闭行为、内存上限、语言、主题、防息屏/防休眠、字体设置、背景图片）
- [x] 日志设置页（自动保存、目录、文件名格式、格式、编码、分片存储）
- [x] 备份管理页（备份开关、周期、路径）
- [x] 显示与交互页（预设波特率、串口类型、换行方式、发送前缀、时间戳方式）
- [x] 语法高亮规则页（占位）
- [x] 发送命令规则页（占位）
- [x] 保存/取消按钮

**遗留事项**:
- [ ] 语法高亮规则集编辑器完整实现
- [ ] 发送命令规则集编辑器完整实现
- [ ] 配置持久化到后端
- [ ] 浏览按钮需要调用 Tauri 文件对话框 API
- [ ] 背景图片预览

---

## 三、后端模块详细进度

### 3.1 命令层 (`src-tauri/src/commands/mod.rs`)

**状态**: ✅ 已完成 (80%)

**已实现**:
- [x] 串口命令：list_available_ports, open_serial_port, close_serial_port, send_serial_data, set_serial_params, set_flow_control
- [x] 配置命令：get_config, set_config, reset_config
- [x] 日志命令：set_log_directory, save_log_as, get_log_files
- [x] 系统命令：get_system_status, prevent_screen_off, prevent_sleep
- [x] 命令参数/返回类型定义

**遗留事项**:
- [ ] 系统命令需要接入真实系统 API
- [ ] 部分命令需要完善错误处理

---

### 3.2 串口管理 (`src-tauri/src/serial/mod.rs`)

**状态**: ✅ 已完成 (75%)

**已实现**:
- [x] SerialManager 结构体
- [x] SerialPortHandle 结构体（含读取线程）
- [x] 枚举系统可用串口
- [x] 打开/关闭串口
- [x] 数据发送（含 HEX 解析、追加换行符）
- [x] 波特率修改
- [x] DTR/RTS 流控设置
- [x] 读取线程（50ms 节流）
- [x] MPSC channel 数据推送

**遗留事项**:
- [ ] 数据位/校验位/停止位/握手协议解析（目前仅波特率生效）
- [ ] 流量统计实现
- [ ] 串口错误状态反馈到前端
- [ ] 虚拟串口与真实串口的区分逻辑优化
- [ ] Tauri 事件 emit 机制（将接收到的数据推送到前端）

---

### 3.3 配置管理 (`src-tauri/src/config/mod.rs`)

**状态**: ✅ 已完成 (90%)

**已实现**:
- [x] AppConfig 完整结构体定义
- [x] ConfigManager 结构体
- [x] 配置文件读写（JSON 格式）
- [x] 默认配置初始化
- [x] get/set/reset/save 方法

**遗留事项**:
- [ ] 配置变更热更新（部分配置修改后需要实时生效）

---

### 3.4 日志管理 (`src-tauri/src/logger/mod.rs`)

**状态**: ✅ 已完成 (80%)

**已实现**:
- [x] LogManager 结构体
- [x] PortLogWriter 结构体（BufWriter）
- [x] 字符串/HEX/二进制三种格式写入
- [x] 日志目录设置
- [x] 手动另存日志
- [x] 日志文件列表

**遗留事项**:
- [ ] 自动保存开关逻辑
- [x] 分片存储实现（已预留接口，未完整实现）
- [ ] 文件名格式解析（[com]-[datetime] 等变量）
- [ ] 日志编码转换（ASCII/UTF-8）

---

### 3.5 存储管理 (`src-tauri/src/storage/mod.rs`)

**状态**: ✅ 已完成 (60%)

**已实现**:
- [x] StorageManager 结构体
- [x] SQLite 连接池（延迟初始化设计）
- [x] init() 异步初始化方法
- [x] 预留表结构注释

**遗留事项**:
- [ ] 数据库表结构初始化（init_schema）
- [ ] 命令集 CRUD 操作
- [ ] 高亮规则集 CRUD 操作
- [ ] 串口布局保存/加载
- [ ] 在 Tauri setup 钩子中调用 init()

---

### 3.6 主入口 (`src-tauri/src/lib.rs`)

**状态**: ✅ 已完成

**已实现**:
- [x] AppState 结构体定义
- [x] 所有模块注册
- [x] 所有命令注册
- [x] 日志初始化

**遗留事项**:
- [ ] setup 钩子中需要调用 storage_manager.init() 完成数据库初始化
- [ ] 需要添加 Tauri 事件 emit 逻辑

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
   - 串口列表拖拽排序
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

9. **UI 优化**
   - 亮色主题支持
   - 响应式布局
   - 安装 lucide-react 替换字符图标

10. **右键菜单**
    - 串口项右键菜单
    - 终端视图右键菜单

11. **虚拟滚动**
    - 大数据量时终端性能优化

12. **背景图片**
    - 配置页背景图片预览
    - 终端背景图片应用

---

## 五、已知问题

| 问题 | 影响 | 解决方案 |
|------|------|----------|
| StorageManager 需要 Tokio 上下文初始化 | 运行时 panic | 已在架构中设计为延迟初始化，在 setup 钩子中调用 |
| 前端使用字符图标而非矢量图标 | 视觉效果 | 安装 lucide-react 后替换 |
| 部分组件存在未使用变量警告 | 编译警告 | 已处理主要问题，剩余为预留接口 |
| 分屏为平铺模型，不支持嵌套 | 无法创建多层分屏 | 当前已满足基本分屏需求，嵌套分屏为后续优化 |

---

## 六、下一步建议

对于多 Agent 协作，建议按以下顺序分工：

1. **Agent A - 串口通信专家**：完善 `serial/mod.rs`，实现数据位/校验位/停止位解析，完成 Tauri 事件 emit
2. **Agent B - 前端交互专家**：对接 Tauri 命令，实现拖拽排序、右键菜单、虚拟滚动
3. **Agent C - 数据持久化专家**：完成 `storage/mod.rs` 数据库表结构与 CRUD，对接配置保存
4. **Agent D - 系统功能专家**：实现系统资源监控、日志自动保存、文件对话框调用

## 七、本次更新摘要 (2026-05-06)

1. **多分屏渲染**：MainDisplay 重写，支持通过 Pane 组件独立渲染每个分屏
2. **可拖拽分割线**：ResizeHandle 组件支持鼠标拖拽调整分屏比例
3. **分屏焦点管理**：focusedPaneId 跟踪当前聚焦分屏，新标签页在聚焦分屏中打开
4. **标签页跨分屏移动**：右键菜单"移动到分屏"，moveTabToPane Action 支持
5. **操作面板折叠**：点击标题栏收起/展开，节省终端显示空间
6. **Sidebar 接入 Zustand**：串口状态统一由 Store 管理，支持搜索过滤
7. **按钮文本优化**：发送按钮改为竖排"发送"，追加回车内改为"追加"，循环延时改为"间隔"等
8. **样式增强**：新增 pane-container、pane-resize-handle、config-row 等 CSS 类
9. **分屏显示修复**：非聚焦分屏现在保持显示其最后选中的标签页内容
10. **最小窗口限制**：根容器 minWidth: 720, minHeight: 480, 主内容区 minWidth: 400
11. **发送区布局修复**：textarea 设固定最小高度，发送按钮改为正常横排，HEX和追加选项紧凑排布在按钮下方
12. **分屏图标修正**：左右分屏 ⏶，上下分屏 ⏷
