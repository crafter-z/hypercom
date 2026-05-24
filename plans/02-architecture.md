# 技术架构

## 整体分层

```
App.tsx (根组件)
 ├─ TitleBar (标题栏)
 ├─ [Sidebar | ResizeHandle | MainDisplay | OperationPanel]
 │      260px    4px    flex:1           280px
 ├─ StatusBar (状态栏)
 └─ ConfigModal (模态弹窗)

数据流:
  Backend  ──invoke──→  tauri.ts  ──→  useTauri.ts  ──→  useAppStore.ts  ──→  Components
          ←──event───           (服务层)     (Hooks层)       (状态管理)        (UI层)
```

## 前端目录结构

```
src/
├── App.tsx                     # 根组件：布局编排 + useAppInit + 全局右键禁用
├── main.tsx                    # ReactDOM.createRoot 挂载
├── styles.css                  # 全局样式 (~1426 行)：CSS变量、组件class、动画
├── types/index.ts              # 全局 TS 类型 (256 行)
├── services/tauri.ts           # Tauri invoke 包装器 + event 监听 (5 个服务模块)
├── hooks/useTauri.ts           # React Hooks 桥接层 (7 个 Hooks)
├── stores/useAppStore.ts       # Zustand + Immer 状态管理 (55+ Actions)
├── utils/highlightEngine.ts    # 语法高亮引擎
└── components/
    ├── shared/ContextMenu.tsx  # 通用右键菜单 (ContextMenu + useContextMenu)
    ├── TitleBar/TitleBar.tsx
    ├── Sidebar/Sidebar.tsx
    ├── MainDisplay/
│   ├── MainDisplay.tsx     # 多分屏容器 + Pane + ResizeHandle
│   ├── TabBar.tsx          # 标签页栏 (含 @dnd-kit 拖拽)
│   └── TerminalView.tsx    # 终端视图 (含虚拟滚动 + 语法高亮 + 文件导出)
    ├── OperationPanel/OperationPanel.tsx  # 操作面板 (发送 + 循环 + 参数)
    ├── StatusBar/StatusBar.tsx           # 系统状态 + 流量统计 + 时钟
    └── ConfigModal/ConfigModal.tsx       # 6 页配置弹窗
```

## 后端目录结构

```
src-tauri/
├── Cargo.toml                  # Rust 依赖
├── tauri.conf.json             # Tauri 配置 (窗口、CSP、构建)
├── capabilities/default.json   # 权限声明
└── src/
    ├── main.rs                 # 程序入口 (windows_subsystem)
    ├── lib.rs                  # 应用状态 + 命令注册 + setup 钩子
    ├── commands/mod.rs         # 32 个 Tauri command (invoke 入口)
    ├── serial/mod.rs           # 串口管理器 (真实 + 模拟)
    ├── config/mod.rs           # JSON 配置管理
    ├── logger/mod.rs           # BufWriter 日志写入 (含分片/多编码)
    └── storage/mod.rs          # SQLite CRUD (6 张表)
```

## 前端架构

### 布局约束链

整个 Flexbox 链必须逐层传递 `min-height: 0` 才能让终端滚动：

```
App root (flex column, 100vh)
  ├─ TitleBar (auto)
  ├─ Middle area (flex:1, flex row, overflow:hidden)
  │   ├─ Sidebar (flex-shrink:0, fixed width)
  │   └─ Main area (flex:1, flex column, overflow:hidden)
  │       ├─ .main-display (flex:1, flex column, min-height:0)
  │       │   ├─ Toolbar (auto)
  │       │   ├─ Pane container (flex:1, overflow:hidden)
  │       │   │   └─ .pane-container-inner (flex:1, flex column, min-height:0)
  │       │   │       ├─ TabBar row (auto)
  │       │   │       ├─ Toolbar (auto)
  │       │   │       └─ .terminal-view-container (flex:1, flex column, min-height:0)
  │       │   │           └─ .terminal-view (flex:1, min-height:0, overflow-y:auto)
  │       └─ .operation-panel (flex-shrink:0, height:280px / 32px collapsed)
  └─ StatusBar (auto)
```

### 组件职责简述

| 组件 | 文件 | 核心职责 |
|------|------|---------|
| TitleBar | `TitleBar.tsx` | 图标、配置按钮、窗口控制 (未绑定API)、拖拽区域 |
| Sidebar | `Sidebar.tsx` | 工具栏、搜索、串口列表、分组、备注名弹窗、@dnd-kit 拖拽 |
| MainDisplay | `MainDisplay.tsx` | 分屏容器、Pane 独立渲染、ResizeHandle 可拖拽分割线 |
| TabBar | `TabBar.tsx` | 标签页渲染、激活样式、右键菜单、@dnd-kit 水平拖拽 |
| TerminalView | `TerminalView.tsx` | 终端内容渲染（`@tanstack/react-virtual` 虚拟滚动）、时间戳、TX/RX 着色、右键菜单（全选/复制/HEX 转换/导出 TXT/CSV 真实文件）、`dangerouslySetInnerHTML` 语法高亮 |
| OperationPanel | `OperationPanel.tsx` | 三栏布局：发送区 + 循环发送 + 串口参数；参数自动下发后端；循环发送 useEffect |
| StatusBar | `StatusBar.tsx` | 系统状态、进程内存、CPU、TX/RX 流量、时钟 |
| ConfigModal | `ConfigModal.tsx` | 6 页设置：通用/日志/备份/显示/高亮规则/命令规则；规则编辑器含数据库存取 |

### 状态管理

`useAppStore.ts` (Zustand + Immer) 管理以下域：

| 域 | 字段 | Actions 数量 |
|----|------|------------|
| 串口 | `ports`, `groups` | 7 (setPorts, updatePort, addGroup, updateGroup, removeGroup, movePortToGroup, reorderPorts) |
| 标签页/分屏 | `tabs`, `panes`, `activeTabId`, `focusedPaneId` | 12 (openTab, closeTab, closeTabsToRight/Left/Others, pinTab, setActiveTab, moveTabToPane, splitPane, removePane, setFocusedPane, reorderTabs) |
| 终端 | `terminals` | 3 (appendTerminalLine, clearTerminal, setTerminalConfig) |
| 配置 | `config` | 2 (setConfig, resetConfig) |
| UI | `ui` | 3 (setUIState, toggleConfigModal, setConfigActiveTab) |
| 操作区 | `op*` (18 字段) | 1 (setOpState) |
| 系统 | `systemStatus`, `trafficStats` | 2 (setSystemStatus, setTrafficStats) |
| 规则集 | `highlightRuleSets`, `activeHighlightSetId` | 5 (set/add/update/remove/setActive) |
| 命令集 | `sendCommandSets`, `activeSendCommandSetId` | 5 (set/add/update/remove/setActive) |
| 模拟 | `simulationMode` | 1 (setSimulationMode) |

### Tauri 服务层

`services/tauri.ts` — 6 个服务模块，纯函数无 React 依赖：

| 模块 | 方法数 | 说明 |
|------|--------|------|
| `serialService` | 8 | listAvailablePorts, openSerialPort, closeSerialPort, sendSerialData, setSerialParams, setFlowControl, enableSimulation, disableSimulation |
| `configService` | 3 | getConfig, setConfig, resetConfig |
| `logService` | 11 | setLogDirectory, saveLogAs, **exportTerminalLog**, getLogFiles, startLogging, stopLogging, setLogSplitSize, setLogFilenameFormat, **setLogAutoSave**, **setLogEncoding**, openPath, openLogDirectory |
| `systemService` | 3 | getSystemStatus, preventScreenOff, preventSleep |
| `storageService` | 6 | saveCommandSet, loadCommandSets, deleteCommandSet, saveHighlightSet, loadHighlightSets, deleteHighlightSet |
| `eventService` | 4 | onSerialData, onSerialStatus, onSystemStatus, onStorageReady |

### React Hooks 层

`hooks/useTauri.ts` — 7 个 Hooks：

| Hook | 频率 | 功能 |
|------|------|------|
| `useSerialPorts(3000)` | 每 3 秒 | 刷新端口列表，`mergePorts` 保留已有状态 |
| `useSerialConnection()` | 按需 | openPort (从 Store 读参数)、closePort、toggleConnection |
| `useSerialData()` | 事件驱动 | 监听 serial:data/serial:status 事件，附加终端行，累加流量统计 |
| `useConfigPersistence()` | 按需 | loadConfig、saveConfig、resetAndReload |
| `useSystemStatus(5000)` | 每 5 秒 | 轮询进程 CPU/内存，写入 Store |
| `useAppInit()` | 挂载一次 | 加载配置 + 刷新端口列表 |
| `useSimulation()` | 按需 | 切换模拟模式，刷新端口 |

### 高亮引擎

`utils/highlightEngine.ts`：

```
applyHighlightSets(text, ruleSets) → HTML string
  └─ 遍历 enabled 规则集的规则
       ├─ 正则匹配: new RegExp(pattern, 'g').exec(text)
       ├─ 关键词匹配: indexOf 循环查找
       └─ 合并去重 (按位置排序，优先留长匹配)
  └─ 构建 <span style="color:...;font-weight:...;font-style:...">...</span>
```

输出通过 `dangerouslySetInnerHTML` 注入终端，文本已 `escapeHtml` 转义防 XSS。
