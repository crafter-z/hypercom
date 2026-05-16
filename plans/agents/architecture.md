# HyperCom 技术架构文档

> 本文档面向多 Agent 协作开发，详细描述 HyperCom 串口调试工具的前后端技术架构、模块职责、接口定义与数据流。
>
> 最后更新：2026-05-15

---

## 一、项目概述

HyperCom 是一款基于 **Tauri v2** 架构的现代化串口调试工具，采用 **Rust 处理底层逻辑** + **React 处理 UI 交互** 的分层架构，旨在提供高性能、高颜值、功能丰富的串口通信体验。

### 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端框架 | React 18 + Vite | UI 渲染与交互 |
| 前端状态 | Zustand + Immer | 轻量全局状态管理 |
| 前端样式 | CSS Variables + lucide-react | 暗色/亮色主题，矢量图标 |
| 后端框架 | Tauri v2 | 桌面应用壳与 Rust 桥接 |
| 串口通信 | serialport-rs | 跨平台串口读写 |
| 数据库 | SQLite (sqlx) | 命令集/规则集/布局持久化 |
| 系统监控 | sysinfo | 真实 CPU/内存数据获取 |
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
│   ├── App.tsx                     # 主应用入口（调用 useAppInit）
│   ├── main.tsx                    # React挂载点
│   ├── styles.css                  # 全局样式与CSS变量（含亮色主题）
│   ├── types/
│   │   └── index.ts                # 全局TypeScript类型定义
│   ├── services/
│   │   └── tauri.ts                # Tauri后端服务层（类型化invoke包装器+事件监听+存储API）
│   ├── hooks/
│   │   └── useTauri.ts             # React Hooks层（桥接Tauri服务与Zustand Store）
│   ├── utils/
│   │   └── highlightEngine.ts      # 【新增】语法高亮引擎（正则/关键词匹配+颜色/加粗/斜体）
│   ├── stores/
│   │   └── useAppStore.ts          # Zustand全局状态
│   └── components/
│       ├── shared/                  # 共享组件
│       │   └── ContextMenu.tsx      # 通用右键菜单 + useContextMenu Hook
│       ├── TitleBar/               # 标题栏
│       ├── Sidebar/                # 左侧串口管理边栏
│       ├── MainDisplay/            # 主显示区（标签页+终端）
│       │   ├── MainDisplay.tsx     # 多分屏容器
│       │   ├── TabBar.tsx          # 标签页栏
│       │   └── TerminalView.tsx     # 终端视图
│       ├── OperationPanel/         # 底部操作面板
│       ├── StatusBar/              # 底部状态栏
│       └── ConfigModal/            # 配置弹窗
├── src-tauri/                      # 后端源码
│   ├── Cargo.toml                  # Rust依赖配置
│   ├── tauri.conf.json             # Tauri应用配置
│   ├── capabilities/
│   │   └── default.json            # 【新增】Tauri v2权限配置
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

### 3.2 共享组件

#### ContextMenu (`src/components/shared/ContextMenu.tsx`)

通用右键菜单组件，供 Sidebar、TabBar、TerminalView 等组件复用：

- **ContextMenu 组件**：
  - `x`, `y` 定位，自动视口边界检测
  - `items` 数组，支持 `ContextMenuItem`（含 icon/danger/disabled）和 `ContextMenuSeparator`
  - 点击外部或 ESC 关闭
  - CSS 入场动画（`contextMenuIn`）

- **useContextMenu Hook**：
  - 返回 `{ show, element }`
  - `show(e, items)` 在指定位置显示菜单
  - `element` 渲染到组件 JSX 中

```typescript
// 使用示例
const { show, element } = useContextMenu();
return (
  <div onContextMenu={(e) => show(e, items)}>
    {/* 内容 */}
    {element}
  </div>
);
```

### 3.3 组件职责

#### TitleBar (`src/components/TitleBar/TitleBar.tsx`)
- 软件 SVG 图标、名称、版本号
- 全局"配置"按钮（lucide Settings 图标），唤起配置弹窗
- 窗口控制按钮（lucide Minus/Square/X），含关闭按钮红色悬停效果
- 支持拖拽移动窗口（CSS `.titlebar-drag` / `.titlebar-nodrag`）

#### Sidebar (`src/components/Sidebar/Sidebar.tsx`)
- **顶部工具栏**：lucide 矢量图标（Play/Square/Eye/EyeOff/ArrowUpDown/Save/RefreshCw）
- **搜索框**：lucide Search 图标 + 清除按钮
- **串口列表**：
  - 状态颜色圆点 + 状态文本（未连接/错误/已连接）
  - VCP 徽标、波特率参数显示
  - lucide Play/Square 连接/断开按钮
  - **右键菜单**（useContextMenu）：连接/断开、设置备注名、在标签页中打开、隐藏/取消隐藏
- **AliasDialog**：模态弹窗输入备注名
- **分组管理**：展开/折叠箭头（lucide ChevronRight），一键开启/关闭整组
- **未分组/隐藏串口区域**、**新建分组按钮**（lucide Plus）
- 全部使用 CSS class，无内联样式

#### MainDisplay (`src/components/MainDisplay/MainDisplay.tsx`)
- **全局工具栏**：lucide 图标（Plus/Columns2/Rows2）
- **标签栏** (`TabBar.tsx`)：
  - 每个串口对应一个标签，显示状态圆点、标题、Pin 图标
  - 使用共享 ContextMenu 实现右键菜单
  - lucide Pin/X 图标
- **终端显示区** (`TerminalView.tsx`)：
  - 时间戳（`.terminal-timestamp`）、方向标识（TX/RX 使用 CSS 变量着色）、内容
  - 使用共享 ContextMenu 实现右键菜单：全选、复制、复制为 HEX、从 HEX 转文本
  - 自动滚动到底部（可锁定）

#### OperationPanel (`src/components/OperationPanel/OperationPanel.tsx`)
- 横向三栏布局，所有图标使用 lucide-react
- 发送区：lucide Send 图标 + 输入框 + HEX/回车选项
- 循环发送：lucide Play（开始）/ lucide Square（停止，.btn-danger 样式）
- 串口参数：波特率/数据位/校验位/停止位/握手协议/DTR/RTS
- 折叠/展开：lucide ChevronDown/ChevronUp

#### StatusBar (`src/components/StatusBar/StatusBar.tsx`)
- 左侧：系统状态 + lucide MemoryStick（内存）+ lucide Cpu（CPU）
- 右侧：lucide ArrowUpCircle（TX 绿色）+ lucide ArrowDownCircle（RX 蓝色）+ 时间

#### ConfigModal (`src/components/ConfigModal/ConfigModal.tsx`)
- 左侧导航：lucide 图标（Settings/FileText/HardDrive/Monitor/Palette/Send）
- 导航项 hover 效果由 CSS class（`.modal-nav-item`）驱动，无内联事件
- 右侧设置内容 + 底部保存/取消按钮
- 关闭按钮：lucide X 图标

### 3.4 图标系统

所有 UI 图标统一使用 **lucide-react**（已安装为项目依赖），不再使用 emoji 或字符图标。

常用图标列表：
- 导航/操作：`Settings`, `X`, `Plus`, `ChevronDown`, `ChevronUp`, `ChevronRight`, `ArrowUpDown`, `RefreshCw`, `Save`
- 串口控制：`Play`, `Square`, `Cable`, `PlugZap`, `Unplug`, `Eye`, `EyeOff`
- 编辑：`Pencil`, `Edit3`, `Search`
- 终端：`Send`, `Eraser`, `FileText`, `FolderOpen`, `FileSearch`
- 状态：`Cpu`, `MemoryStick`, `ArrowUpCircle`, `ArrowDownCircle`, `Pin`, `Clock`
- 分屏：`Columns2`, `Rows2`

### 3.5 样式系统

使用 **CSS 变量** 实现主题切换，定义在 `src/styles.css`：

#### 暗色主题（默认）
```css
:root {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d30;
  --text-primary: #cccccc;
  --text-secondary: #858585;
  --terminal-tx-color: #dcdcaa;
  --terminal-rx-color: #4fc1ff;
  /* ... 完整变量见 styles.css */
}
```

#### 亮色主题
```css
:root[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f3f3f3;
  --text-primary: #333333;
  --terminal-tx-color: #b8860b;
  --terminal-rx-color: #0066cc;
  /* ... 完整变量见 styles.css */
}
```

#### CSS class 体系

所有组件样式通过 BEM 风格的 CSS class 管理，不再使用内联 style 属性：

| 类别 | 示例 |
|------|------|
| 侧边栏 | `.sidebar`, `.sidebar-toolbar`, `.sidebar-search-*`, `.port-item-*`, `.port-group-*` |
| 终端 | `.terminal-view-container`, `.terminal-view`, `.terminal-line`, `.terminal-timestamp`, `.terminal-direction`, `.terminal-content`, `.terminal-toolbar-*` |
| 标题栏 | `.titlebar`, `.titlebar-left`, `.titlebar-right`, `.titlebar-*` |
| 操作面板 | `.operation-panel`, `.op-section-*`, `.op-send-*`, `.op-loop-*`, `.op-param-*` |
| 状态栏 | `.statusbar`, `.statusbar-left`, `.statusbar-right`, `.statusbar-item`, `.statusbar-dot` |
| 配置弹窗 | `.modal-overlay`, `.modal-dialog`, `.modal-nav-*`, `.modal-content-*`, `.config-*` |
| 右键菜单 | `.context-menu`, `.context-menu-item`, `.context-menu-icon`, `.context-menu-separator` |
| 通用 | `.btn`, `.btn-primary`, `.btn-danger`, `.btn-icon`, `.btn-sm`, `.input`, `.select`, `.divider`, `.divider-h` |

### 3.6 状态管理

状态管理使用 **Zustand + Immer**，定义在 `src/stores/useAppStore.ts`。

核心状态包括：
- `ports: SerialPort[]` — 串口列表
- `tabs: TabItem[]` — 标签页列表
- `terminals: Record<string, TerminalState>` — 终端内容（按串口ID索引）
- `config: AppConfig` — 应用配置
- `systemStatus: SystemStatus` — 系统状态
- `ui: UIState` — UI状态（配置弹窗开关、侧边栏宽度等）
- `opXxx` — 操作面板各种状态（波特率、数据位、发送内容等）

Actions 包括：setPorts, updatePort, openTab, closeTab, appendTerminalLine, clearTerminal, setConfig, setUIState, setOpState 等约 40 个方法。

### 3.7 Tauri 服务层 (`src/services/tauri.ts`)

类型化的 Tauri invoke 包装器，为所有后端命令提供类型安全的 API：

```typescript
// 串口服务
serialService.listAvailablePorts()           // → AvailablePortInfo[]
serialService.openSerialPort(params)          // → void
serialService.closeSerialPort(portId)         // → void
serialService.sendSerialData(params)          // → number (bytesWritten)
serialService.setSerialParams(portId, baud)   // → void
serialService.setFlowControl(portId, dtr, rts)// → void

// 配置服务
configService.getConfig()                     // → AppConfig
configService.setConfig(config)               // → void
configService.resetConfig()                   // → AppConfig

// 日志服务
logService.startLogging(portId)               // → void
logService.stopLogging(portId)                // → void
logService.saveLogAs(portId, path)            // → void
logService.setLogDirectory(path)              // → void
logService.getLogFiles()                      // → LogFileInfoResult[]

// 系统服务
systemService.getSystemStatus()               // → SystemStatusResult
systemService.preventScreenOff(enable)        // → void
systemService.preventSleep(enable)             // → void

// 事件监听
eventService.onSerialData(callback)           // → UnlistenFn
eventService.onSerialStatus(callback)         // → UnlistenFn
eventService.onSystemStatus(callback)         // → UnlistenFn
```

所有参数使用 snake_case 命名（如 `port_id`, `baud_rate`），与后端 Rust 结构体的 `#[serde(rename_all = "camelCase")]` 配合。Tauri v2 invoke() 内部会自动进行 camelCase 转换。

### 3.8 React Hooks 层 (`src/hooks/useTauri.ts`)

将 Tauri 服务层桥接到 Zustand Store 和 React 组件生命周期：

| Hook | 功能 | 返回值 |
|------|------|--------|
| `useSerialPorts(interval)` | 定时刷新串口列表 | `{ refreshPorts }` |
| `useSerialConnection()` | 串口连接/断开操作 | `{ openPort, closePort, toggleConnection }` |
| `useSerialData()` | 串口数据收发 | `{ sendData }` |
| `useConfigPersistence()` | 配置持久化 | `{ loadConfig, saveConfig, resetAndReload }` |
| `useSystemStatus(interval)` | 系统状态轮询 | void（自动写入 store） |
| `useAppInit()` | 应用初始化 | void（挂载时调用 loadConfig + refreshPorts） |

**数据流示例 — 发送数据：**
```
用户点击发送 → OperationPanel.handleSend()
  → useSerialData().sendData(portId, data, isHex, lineEnding)
    → serialService.sendSerialData(params)
      → invoke('send_serial_data', { args: params })
        → Rust: commands::send_serial_data()
          → SerialManager::send_data()
            → serialport write
```

**数据流示例 — 接收数据：**
```
Rust 读取线程 → MPSC channel → (TODO: app.emit("serial:data", event))
  → 前端 eventService.onSerialData(callback)
    → useSerialData 内 unlisten 回调
      → useAppStore.getState().appendTerminalLine()
        → 终端内容更新
```

### 3.9 类型定义

（与之前文档相同，无变更。详见 `src/types/index.ts`。）

---

## 四、后端架构

### 4.1 应用状态 (`src-tauri/src/lib.rs`)

```rust
pub struct AppState {
    pub serial_manager: std::sync::Mutex<serial::SerialManager>,
    pub config_manager: std::sync::Mutex<config::ConfigManager>,
    pub log_manager: std::sync::Mutex<logger::LogManager>,
    pub storage_manager: std::sync::Mutex<storage::StorageManager>,
}
```

所有 Manager 使用 `std::sync::Mutex` 包装，因为 Tauri 命令是同步函数。在 `run()` 中通过 `.manage()` 注入。

### 4.2 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| 命令层 | `commands/mod.rs` | 所有 Tauri invoke 命令的入口，参数校验、调用 Manager、返回结果 |
| 串口管理 | `serial/mod.rs` | 串口枚举、打开/关闭、参数配置、数据收发、读取线程 |
| 配置管理 | `config/mod.rs` | JSON 配置读写、默认值、AppConfig 结构体 |
| 日志管理 | `logger/mod.rs` | BufWriter 写入、按串口独立文件、分片检测、另存为 |
| 存储管理 | `storage/mod.rs` | SQLite 连接池（延迟初始化）、表结构、CRUD（待实现） |

### 4.3 命令层接口

所有命令使用 `#[tauri::command]` 宏标记，参数结构体使用 `#[serde(rename_all = "camelCase")]`。

**串口命令：**

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `list_available_ports` | — | `Vec<PortInfo>` | 枚举系统可用串口 |
| `open_serial_port` | `OpenPortArgs` | `()` | 打开串口（含波特率、数据位等） |
| `close_serial_port` | `port_id: String` | `()` | 关闭串口 |
| `send_serial_data` | `SendDataArgs` | `usize` | 发送数据，返回写入字节数 |
| `set_serial_params` | `port_id, baud_rate` | `()` | 修改波特率 |
| `set_flow_control` | `port_id, dtr, rts` | `()` | 设置 DTR/RTS |

**配置命令：**

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `get_config` | — | `AppConfig` | 获取当前配置 |
| `set_config` | `new_config: AppConfig` | `()` | 更新并持久化配置 |
| `reset_config` | — | `AppConfig` | 重置为默认配置 |

**日志命令：**

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `start_logging` | `port_id: String` | `()` | 开始记录日志 |
| `stop_logging` | `port_id: String` | `()` | 停止记录日志 |
| `save_log_as` | `port_id, path` | `()` | 手动另存日志 |
| `set_log_directory` | `path: String` | `()` | 设置日志目录 |
| `get_log_files` | — | `Vec<LogFileInfo>` | 获取日志文件列表 |

**系统命令：**

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `get_system_status` | — | `SystemStatus` | 获取系统资源状态（当前为硬编码） |
| `prevent_screen_off` | `enable: bool` | `()` | 防止系统息屏（当前为日志占位） |
| `prevent_sleep` | `enable: bool` | `()` | 防止系统休眠（当前为日志占位） |

### 4.4 Tauri 权限配置 (`src-tauri/capabilities/default.json`)

Tauri v2 使用 capabilities 声明前端可用的权限：

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "shell:allow-open"
  ]
}
```

目前所有 invoke 命令在开发模式下默认可用。生产发布前需为每个命令添加精细权限声明。

### 4.5 事件系统

后端通过 `app.emit("event_name", payload)` 向前端推送事件：

| 事件名 | Payload 类型 | 说明 |
|--------|-------------|------|
| `serial:data` | `SerialDataEvent` | 串口接收到数据 |
| `serial:status` | `SerialStatusEvent` | 串口连接状态变化 |
| `system:status` | `SystemStatusResult` | 系统资源状态更新 |

> **注意**：当前读取线程使用 MPSC channel 发送数据，但未接入 Tauri 事件系统。需要在 `open_port` 中传入 `AppHandle`，读取线程通过 `app.emit()` 推送数据。

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

### 5.5 为什么使用共享 ContextMenu 组件？
- Sidebar、TabBar、TerminalView 均需要右键菜单功能
- 抽取共享组件避免重复实现（视口检测、关闭逻辑、样式）
- `useContextMenu` Hook 简化接入，一行 `show(e, items)` 即可

### 5.6 为什么使用 lucide-react 而非 emoji/字符图标？
- 矢量图标在任何分辨率下清晰渲染
- 统一的设计语言（Lucide 图标库）
- 支持 `size` 属性精确控制尺寸
- 支持 `color` / CSS `currentColor` 继承主题颜色
- 替代 emoji 在不同平台渲染不一致的问题

### 5.7 为什么前端服务层和 Hooks 层分离？
- `src/services/tauri.ts` 只负责 invoke 调用和事件监听，不涉及 React 生命周期
- `src/hooks/useTauri.ts` 负责将服务层桥接到 React 组件（useEffect、useState、useCallback）
- 分离后，服务层可以在非 React 上下文中使用（如 Zustand middleware）
- Hooks 层处理轮询、清理、错误日志等横切关注点

### 5.8 为什么使用后端 serde rename_all = "camelCase"？
- Rust 结构体字段使用 snake_case 命名（Rust 惯例）
- 前端 JavaScript 使用 camelCase 命名（JS 惯例）
- Tauri v2 invoke 内部默认使用 camelCase 序列化参数
- `#[serde(rename_all = "camelCase")]` 自动转换，避免手动映射

---

## 六、接口契约

（与之前文档相同，后端接口无变更。）

---

## 七、开发规范

### 7.1 代码组织原则
- 每个组件一个文件夹，包含 `.tsx` 文件
- 共享组件放在 `src/components/shared/` 目录
- 类型定义统一放在 `src/types/index.ts`
- 状态管理统一放在 `src/stores/useAppStore.ts`
- 后端每个模块一个文件夹，包含 `mod.rs`

### 7.2 命名规范
- 前端：PascalCase 组件名，camelCase 变量/函数名
- 后端：snake_case 函数/变量名，PascalCase 结构体名
- 类型：前端 `Type` 后缀，后端 无特殊后缀
- CSS class：kebab-case（`.port-item-name`, `.terminal-toolbar-title`）

### 7.3 样式规范（重要）
- **禁止内联 `onMouseEnter`/`onMouseLeave` 实现 hover 效果**，统一使用 CSS `:hover` 或 `.active` class
- **禁止内联 `style` 实现可复用的组件样式**，统一使用 CSS class
- 新增组件样式应在 `src/styles.css` 中定义对应的 class
- 右键菜单统一使用 `ContextMenu` 组件 + `useContextMenu` Hook
- 图标统一使用 `lucide-react`，禁止使用 emoji 或特殊字符

### 7.4 注释规范
- 每个组件文件顶部应有简要注释说明组件用途
- TODO 标记使用 `// TODO: 说明`
- 复杂逻辑需要行内注释

---

## 八、附录

### 8.1 前端依赖清单

| 依赖 | 版本 | 用途 |
|------|------|------|
| react | ^18.3.1 | UI 框架 |
| react-dom | ^18.3.1 | DOM 渲染 |
| zustand | ^5.0.13 | 状态管理 |
| immer | ^11.1.6 | 不可变数据更新 |
| lucide-react | latest | 矢量图标库 |
| @dnd-kit/core | latest | 拖拽排序核心 |
| @dnd-kit/sortable | latest | 可排序列表 |
| @dnd-kit/utilities | latest | 拖拽工具函数 |
| @tauri-apps/api | ^2.0.0 | Tauri 前端 API |
| @tauri-apps/plugin-shell | ^2.0.0 | Shell 插件 |

### 8.2 相关文件索引

| 文件 | 说明 |
|------|------|
| `src/services/tauri.ts` | Tauri 后端服务层（类型化 invoke 包装器 + 事件监听） |
| `src/hooks/useTauri.ts` | React Hooks 层（桥接 Tauri 服务与 Zustand Store） |
| `src/types/index.ts` | 前端类型定义 |
| `src/stores/useAppStore.ts` | 前端状态管理（Zustand + Immer） |
| `src/components/shared/ContextMenu.tsx` | 共享右键菜单组件 |
| `src/components/TitleBar/TitleBar.tsx` | 标题栏（lucide 图标） |
| `src/components/Sidebar/Sidebar.tsx` | 串口边栏（右键菜单 + AliasDialog + useSerialPorts） |
| `src/components/MainDisplay/MainDisplay.tsx` | 主显示区（lucide 分屏图标） |
| `src/components/MainDisplay/TabBar.tsx` | 标签栏（共享 ContextMenu） |
| `src/components/MainDisplay/TerminalView.tsx` | 终端视图（右键菜单 + HEX 转换） |
| `src/components/OperationPanel/OperationPanel.tsx` | 操作面板（useSerialData + useSerialConnection） |
| `src/components/StatusBar/StatusBar.tsx` | 状态栏（useSystemStatus） |
| `src/components/ConfigModal/ConfigModal.tsx` | 配置弹窗（useConfigPersistence） |
| `src/styles.css` | 全局样式（含亮色主题、组件 class 体系） |
| `src/App.tsx` | 主应用入口（调用 useAppInit） |
| `src-tauri/capabilities/default.json` | Tauri v2 权限配置 |
| `src-tauri/src/commands/mod.rs` | Tauri 命令层 |
| `src-tauri/src/serial/mod.rs` | 串口管理模块 |
| `src-tauri/src/config/mod.rs` | 配置管理模块 |
| `src-tauri/src/logger/mod.rs` | 日志管理模块 |
| `src-tauri/src/storage/mod.rs` | 数据库存储模块 |

### 8.3 外部依赖文档

- [Tauri v2](https://v2.tauri.app/)
- [serialport-rs](https://github.com/serialport/serialport-rs)
- [sqlx](https://github.com/launchbadge/sqlx)
- [Zustand](https://github.com/pmndrs/zustand)
- [Immer](https://immerjs.github.io/immer/)
- [Lucide React](https://lucide.dev/)