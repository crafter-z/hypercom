# HyperCom 技术架构文档

> 本文档面向多 Agent 协作开发，详细描述 HyperCom 串口调试工具的前后端技术架构、模块职责、接口定义与数据流。
>
> 最后更新：2026-05-06

---

## 一、项目概述

HyperCom 是一款基于 **Tauri v2** 架构的现代化串口调试工具，采用 **Rust 处理底层逻辑** + **React 处理 UI 交互** 的分层架构，旨在提供高性能、高颜值、功能丰富的串口通信体验。

### 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端框架 | React 18 + Vite | UI 渲染与交互 |
| 前端状态 | Zustand + Immer | 轻量全局状态管理 |
| 前端样式 | CSS Variables | 暗色主题，动态切换 |
| 后端框架 | Tauri v2 | 桌面应用壳与 Rust 桥接 |
| 串口通信 | serialport-rs | 跨平台串口读写 |
| 数据库 | SQLite (sqlx) | 命令集/规则集/布局持久化 |
| 日志存储 | BufWriter + 文件系统 | 高性能异步落盘 |
| 配置存储 | JSON 文件 | 应用配置持久化 |

---

## 二、目录结构

```
hypercom/
├── plans/                          # 项目规划文档
│   ├── agents/                     # 【多Agent协作文档】
│   │   ├── architecture.md         # 技术架构文档（本文档）
│   │   └── progress.md             # 进度与遗留事项
│   ├── requirements.md             # 需求文档
│   ├── roadmap.md                  # 路线图
│   └── UI.png                      # UI参考图
├── src/                            # 前端源码
│   ├── App.tsx                     # 主应用入口
│   ├── main.tsx                    # React挂载点
│   ├── styles.css                  # 全局样式与CSS变量
│   ├── types/
│   │   └── index.ts                # 全局TypeScript类型定义
│   ├── stores/
│   │   └── useAppStore.ts          # Zustand全局状态
│   └── components/
│       ├── TitleBar/               # 标题栏
│       ├── Sidebar/                # 左侧串口管理边栏
│       ├── MainDisplay/            # 主显示区（标签页+终端）
│       ├── OperationPanel/         # 底部操作面板
│       ├── StatusBar/              # 底部状态栏
│       └── ConfigModal/            # 配置弹窗
├── src-tauri/                      # 后端源码
│   ├── Cargo.toml                  # Rust依赖配置
│   ├── tauri.conf.json             # Tauri应用配置
│   └── src/
│       ├── lib.rs                  # 后端主入口
│       ├── main.rs                 # 程序入口
│       ├── commands/mod.rs         # Tauri命令层
│       ├── serial/mod.rs           # 串口管理模块
│       ├── config/mod.rs           # 配置管理模块
│       ├── logger/mod.rs           # 日志管理模块
│       └── storage/mod.rs          # 数据库存储模块
```

---

## 三、前端架构

### 3.1 整体布局

应用采用经典的 IDE 风格布局，自上而下、自左而右划分为五个区域：

```
┌─────────────────────────────────────────────┐
│              TitleBar (标题栏)                │  36px
├──────────┬──────────────────────────────────┤
│          │                                  │
│ Sidebar  │      MainDisplay (主显示区)       │
│ (串口    │      - TabBar (标签栏)            │
│  管理)   │      - TerminalView (终端视图)    │
│ 260px    │                                  │
│          ├──────────────────────────────────┤
│          │   OperationPanel (操作面板)       │  280px
├──────────┴──────────────────────────────────┤
│              StatusBar (状态栏)               │  24px
└─────────────────────────────────────────────┘
```

### 3.2 组件职责

#### TitleBar (`src/components/TitleBar/TitleBar.tsx`)
- 软件图标、名称、版本号
- 全局"配置"按钮（唤起配置弹窗）
- 窗口控制按钮（最小化/最大化/关闭）
- 支持拖拽移动窗口（`-webkit-app-region: drag`）

#### Sidebar (`src/components/Sidebar/Sidebar.tsx`)
- **顶部工具栏**：一键打开全部、一键关闭全部、显示/隐藏串口、排序、保存布局、刷新
- **搜索框**：按串口名或备注名过滤
- **串口列表**：
  - 支持垂直滚动，可拖拽改变排序（预留）
  - **分组管理**：支持将串口聚合成组（类似 Edge 浏览器选项卡组），可重命名、展开/折叠、一键开启/关闭整组
  - **单个串口项**：状态颜色条（绿-未连接，黄-报错，红-已连接）、COM口及备注名、连接/断开小按钮
  - **交互**：双击或右键唤起主窗口对应标签页；右键菜单包含：设置备注、隐藏/显示、打开/关闭
- **未分组区域**：显示未加入任何分组的串口
- **隐藏串口区域**：显示被隐藏的串口
- **新建分组按钮**

#### MainDisplay (`src/components/MainDisplay/MainDisplay.tsx`)
- **标签栏** (`TabBar.tsx`)：
  - 每个串口对应一个标签，显示图标、COM口和备注
  - 支持拖拽排序（预留）
  - 右键菜单：关闭当前/左侧/右侧/其他、固定选项卡
  - 新建标签页按钮、分屏按钮、更多操作按钮
- **终端显示区** (`TerminalView.tsx`)：
  - 显示串口输入输出内容，只读不可修改
  - 时间戳、RX/TX 方向标识
  - 自动滚动到底部（可锁定）
  - 编码切换（ASCII/UTF-8/GBK）
  - 右键菜单：全选、复制、字符串与 HEX 相互转换（预留）
  - 语法高亮（预留）

#### OperationPanel (`src/components/OperationPanel/OperationPanel.tsx`)
横向三栏布局，所有操作均针对**当前主窗口选中的标签页（串口）**：

- **左侧：手动发送与基础控制**
  - 命令发送区：输入框 + 发送按钮
  - 发送选项：HEX/字符串、追加回车（None/\r\n/\r/\n）
  - 基础控制：打开/关闭当前串口、清屏

- **中间：自动循环与规则应用**
  - 高亮规则下拉菜单 + 编辑按钮
  - 发送命令集下拉菜单 + 编辑按钮
  - 循环发送控制：开始/停止按钮、延时输入框
  - 更多选项：HEX/文本切换、打开日志文件、高亮规则选择、编辑发送命令集

- **右侧：串口参数与视图控制**
  - 视图控制：滚动锁定、显示时间戳、HEX/字符串显示格式
  - 日志操作：另存为、打开文件、打开所在目录
  - 串口参数：波特率、数据位(5-8)、校验位、停止位、握手协议
  - 开关：DTR、RTS、忽略空字符

#### StatusBar (`src/components/StatusBar/StatusBar.tsx`)
- 左侧：系统状态（运行正常）、内存占用（当前/限制）、CPU占用率
- 右侧：当前串口实时流量统计（TX总数、RX总数，单位动态切换 B/KB/MB）、当前时间

#### ConfigModal (`src/components/ConfigModal/ConfigModal.tsx`)
独立模态弹窗，左侧树状导航 + 右侧详细设置：

| 导航项 | 内容 |
|--------|------|
| 通用设置 | 关闭行为、内存上限、语言、主题、防息屏/防休眠、字体设置、背景图片 |
| 日志设置 | 存储目录、文件名格式、编码格式、文件格式、分片存储、自动保存开关 |
| 备份管理 | 日志库备份开关、备份周期、备份路径 |
| 显示与交互 | 预设波特率、显示串口类型、回车换行方式、发送前缀、时间戳显示方式 |
| 语法高亮规则 | 规则集管理（正则/关键词、颜色/加粗/斜体） |
| 发送命令规则 | 命令集管理（顺序、名称、延时、类型、内容） |

### 3.3 状态管理

使用 **Zustand + Immer** 实现全局状态管理，状态定义在 `src/stores/useAppStore.ts`。

#### 核心状态切片

```typescript
interface AppState {
  // 串口数据
  ports: SerialPort[];
  groups: PortGroup[];
  
  // 标签页与分屏
  tabs: TabItem[];
  panes: SplitPane[];
  activeTabId: string | null;
  
  // 终端内容（按串口ID索引）
  terminals: Record<string, TerminalState>;
  
  // 规则集
  highlightRuleSets: HighlightRuleSet[];
  activeHighlightSetId: string | null;
  sendCommandSets: SendCommandSet[];
  activeSendCommandSetId: string | null;
  
  // 配置
  config: AppConfig;
  
  // 系统状态
  systemStatus: SystemStatus;
  trafficStats: Record<string, TrafficStats>;
  
  // UI状态
  ui: UIState;
  
  // 操作区状态（当前激活串口）
  opBaudRate: number;
  opDataBits: DataBits;
  opParity: Parity;
  opStopBits: StopBits;
  opHandshake: Handshake;
  opDtr: boolean;
  opRts: boolean;
  opIgnoreEmptyChars: boolean;
  opScrollLocked: boolean;
  opShowTimestamp: boolean;
  opDisplayFormat: DisplayFormat;
  opEncoding: Encoding;
  opSendIsHex: boolean;
  opSendAppendLineEnding: LineEnding;
  opSendInput: string;
  opIsLoopSending: boolean;
}
```

#### 关键 Actions

| Action | 说明 |
|--------|------|
| `setPorts` / `updatePort` | 更新串口列表/单个串口状态 |
| `openTab` / `closeTab` / `setActiveTab` | 标签页管理 |
| `pinTab` / `closeTabsToRight` / `closeTabsToLeft` / `closeOtherTabs` | 标签页高级操作 |
| `splitPane` | 分屏（预留） |
| `appendTerminalLine` / `clearTerminal` | 终端内容操作 |
| `setConfig` / `resetConfig` | 配置更新/重置 |
| `toggleConfigModal` / `setConfigActiveTab` | 配置弹窗控制 |
| `setOpState` | 操作区状态批量更新 |
| `setSystemStatus` / `setTrafficStats` | 系统状态更新 |

### 3.4 类型定义

全部类型定义在 `src/types/index.ts`，涵盖：

- **串口相关**：`SerialPort`, `PortStatus`, `PortType`, `PortGroup`
- **标签页相关**：`TabItem`, `SplitPane`
- **终端相关**：`TerminalLine`, `TerminalState`
- **规则集相关**：`HighlightRule`, `HighlightRuleSet`, `SendCommand`, `SendCommandSet`
- **配置相关**：`AppConfig`
- **系统相关**：`SystemStatus`, `TrafficStats`
- **Tauri 命令参数**：`OpenPortParams`, `SendDataParams`, `AvailablePortInfo`

### 3.5 样式系统

使用 **CSS 变量** 实现暗色主题，定义在 `src/styles.css`：

```css
:root {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d30;
  --text-primary: #cccccc;
  --text-secondary: #858585;
  --status-disconnected: #4ec9b0;  /* 绿色 */
  --status-error: #dcdcaa;          /* 黄色 */
  --status-connected: #f48771;      /* 红色 */
  --font-terminal: 'Consolas', 'Monaco', monospace;
  --font-ui: 'Inter', sans-serif;
}
```

提供通用组件类：`.btn`, `.input`, `.select`, `.tab-bar`, `.tab-item`, `.context-menu`, `.panel-card` 等。

---

## 四、后端架构

### 4.1 整体架构

```
┌─────────────────────────────────────────────┐
│           Tauri Application                 │
│  ┌─────────────────────────────────────┐   │
│  │         Command Layer               │   │
│  │  (commands/mod.rs)                  │   │
│  │  - 所有前端 invoke 调用的入口        │   │
│  └─────────────────────────────────────┘   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐     │
│  │ Serial  │ │ Config  │ │ Logger  │     │
│  │ Manager │ │ Manager │ │ Manager │     │
│  └─────────┘ └─────────┘ └─────────┘     │
│  ┌─────────┐                              │
│  │ Storage │                              │
│  │ Manager │                              │
│  └─────────┘                              │
└─────────────────────────────────────────────┘
```

### 4.2 模块职责

#### lib.rs (`src-tauri/src/lib.rs`)
- 后端主入口，注册所有 Tauri 命令
- 定义 `AppState` 结构体，通过 `tauri::State` 在各命令间共享
- 初始化日志、各 Manager

```rust
pub struct AppState {
    pub serial_manager: std::sync::Mutex<serial::SerialManager>,
    pub config_manager: std::sync::Mutex<config::ConfigManager>,
    pub log_manager: std::sync::Mutex<logger::LogManager>,
    pub storage_manager: std::sync::Mutex<storage::StorageManager>,
}
```

#### commands/mod.rs (`src-tauri/src/commands/mod.rs`)
所有前端通过 `invoke` 调用的 Rust 函数：

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `list_available_ports` | - | `Vec<PortInfo>` | 枚举系统可用串口 |
| `open_serial_port` | `OpenPortArgs` | `()` | 打开指定串口 |
| `close_serial_port` | `port_id: String` | `()` | 关闭指定串口 |
| `send_serial_data` | `SendDataArgs` | `usize` | 向串口发送数据 |
| `set_serial_params` | `port_id, baud_rate` | `()` | 修改波特率 |
| `set_flow_control` | `port_id, dtr, rts` | `()` | 设置 DTR/RTS |
| `get_config` | - | `AppConfig` | 获取当前配置 |
| `set_config` | `AppConfig` | `()` | 更新配置 |
| `reset_config` | - | `AppConfig` | 重置为默认配置 |
| `set_log_directory` | `path: String` | `()` | 设置日志目录 |
| `save_log_as` | `port_id, path` | `()` | 手动另存日志 |
| `get_log_files` | - | `Vec<LogFileInfo>` | 获取日志文件列表 |
| `get_system_status` | - | `SystemStatus` | 获取系统状态 |
| `prevent_screen_off` | `enable: bool` | `()` | 防止系统息屏 |
| `prevent_sleep` | `enable: bool` | `()` | 防止系统休眠 |

#### serial/mod.rs (`src-tauri/src/serial/mod.rs`)
**串口管理模块**，核心职责：
- `SerialManager`：管理所有已打开串口的集合
- `SerialPortHandle`：单个串口的句柄，包含底层串口对象、读取线程、数据通道
- 数据接收通过 **MPSC channel** 异步推送给前端
- 读取线程 50ms 节流，避免 CPU 占用过高

关键方法：
- `list_ports()`：枚举系统可用串口（区分虚拟/真实）
- `open_port(args)`：打开串口并启动读取线程
- `close_port(port_id)`：关闭串口并清理资源
- `send_data(port_id, data, is_hex, append_line_ending)`：发送数据
- `set_baud_rate()` / `set_flow_control()`：动态修改参数

#### config/mod.rs (`src-tauri/src/config/mod.rs`)
**配置管理模块**：
- `AppConfig`：完整的应用配置结构体（通用/字体/串口/日志/备份）
- `ConfigManager`：JSON 文件持久化，默认路径 `%APPDATA%/hypercom/config.json`
- 支持 get/set/reset/save 操作

#### logger/mod.rs (`src-tauri/src/logger/mod.rs`)
**日志管理模块**：
- `LogManager`：管理所有串口的日志写入器
- `PortLogWriter`：单个串口的 BufWriter，支持字符串/HEX/二进制三种格式
- 支持按大小自动分片（预留）
- 默认日志目录 `%APPDATA%/hypercom/logs/`

#### storage/mod.rs (`src-tauri/src/storage/mod.rs`)
**存储管理模块**：
- `StorageManager`：SQLite 数据库连接池管理
- 预留表结构：port_groups、send_command_sets、send_commands、highlight_rule_sets、highlight_rules
- **注意**：数据库连接池需要在 Tauri `.setup()` 钩子中异步初始化，避免 Tokio 上下文错误

### 4.3 数据流

```
前端 (React)
    │
    │ invoke('send_serial_data', { portId, data, isHex })
    ▼
Tauri Bridge
    │
    ▼
commands::send_serial_data(args, state)
    │
    ▼
state.serial_manager.lock()
    │
    ▼
SerialManager::send_data(port_id, data, is_hex, ...)
    │
    ├─► 写入串口硬件 ◄── 物理设备
    │
    ├─► 同时写入 LogManager（如果自动保存开启）
    │
    └─► 返回写入字节数
    │
    ▲
前端接收返回值，更新 UI 状态

// 数据接收方向（异步）
SerialPort 读取线程
    │
    ├─► 每 50ms 读取一次缓冲区
    │
    ├─► 将数据打包为 SerialDataEvent
    │
    └─► 通过 MPSC channel 发送
         │
         ▼
    前端监听事件（预留 emit 机制）
         │
         ▼
    更新 terminals[portId].lines
         │
         ▼
    TerminalView 自动渲染新内容
```

---

## 五、关键设计决策

### 5.1 为什么使用 Zustand 而非 Redux？
- 项目状态复杂度适中，Zustand 更轻量
- Immer 集成使不可变更新写法更直观
- 不需要 Redux 的中间件生态

### 5.2 为什么串口读取使用独立线程？
- 串口通信是阻塞 IO，必须在独立线程中轮询
- 50ms 节流平衡了实时性与 CPU 占用
- MPSC channel 将数据安全地传递到主线程

### 5.3 为什么日志使用 BufWriter？
- 串口高频数据场景下，直接写盘会导致 IO 阻塞
- BufWriter 批量缓冲写入，减少系统调用次数
- 每个串口独立文件，避免锁竞争

### 5.4 为什么 StorageManager 延迟初始化？
- sqlx 的连接池创建需要 Tokio runtime 上下文
- `AppState::new()` 在 Tauri Builder 阶段是同步调用
- 解决方案：先创建空结构体，在 `.setup()` 钩子中异步 `init()`

---

## 六、接口契约

### 6.1 前端 → 后端 命令接口

详见 `src-tauri/src/commands/mod.rs`，所有命令均遵循：
- 参数：使用 `serde::Deserialize` 结构体
- 返回值：`Result<T, String>`（成功返回数据，失败返回错误字符串）
- 状态访问：通过 `tauri::State<AppState>` 获取共享状态

### 6.2 后端 → 前端 事件接口（预留）

计划使用 Tauri 的 `emit` 机制推送异步事件：

| 事件名 | 数据 | 说明 |
|--------|------|------|
| `serial:data` | `SerialDataEvent` | 串口收到新数据 |
| `serial:status` | `{ port_id, status }` | 串口连接状态变化 |
| `system:status` | `SystemStatus` | 系统资源状态更新 |

### 6.3 前端组件间接口

通过 Zustand Store 共享状态，主要 Selector：
- `selectActivePort(state)`：获取当前激活的串口
- `selectActiveTerminal(state)`：获取当前激活的终端

---

## 七、开发规范

### 7.1 代码组织原则
- 每个组件一个文件夹，包含 `.tsx` 文件
- 类型定义统一放在 `src/types/index.ts`
- 状态管理统一放在 `src/stores/useAppStore.ts`
- 后端每个模块一个文件夹，包含 `mod.rs`

### 7.2 命名规范
- 前端：PascalCase 组件名，camelCase 变量/函数名
- 后端：snake_case 函数/变量名，PascalCase 结构体名
- 类型：前端 `Type` 后缀，后端 无特殊后缀

### 7.3 注释规范
- 所有公共函数必须包含文档注释（`///` 或 `/** */`）
- TODO 标记使用 `// TODO: 说明`
- 复杂逻辑需要行内注释

---

## 八、附录

### 8.1 相关文件索引

| 文件 | 说明 |
|------|------|
| `plans/requirements.md` | 原始需求文档 |
| `plans/UI.png` | UI 参考设计图 |
| `src/types/index.ts` | 前端类型定义 |
| `src/stores/useAppStore.ts` | 前端状态管理 |
| `src-tauri/src/lib.rs` | 后端主入口 |
| `src-tauri/src/commands/mod.rs` | Tauri 命令层 |
| `src-tauri/Cargo.toml` | Rust 依赖配置 |

### 8.2 外部依赖文档

- [Tauri v2](https://v2.tauri.app/)
- [serialport-rs](https://github.com/serialport/serialport-rs)
- [sqlx](https://github.com/launchbadge/sqlx)
- [Zustand](https://github.com/pmndrs/zustand)
- [Immer](https://immerjs.github.io/immer/)
