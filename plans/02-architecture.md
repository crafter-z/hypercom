# 技术架构

## 整体分层

```
App.tsx (根组件: ErrorBoundary + ThemeProvider + useSerialReceive)
  ├─ TitleBar (标题栏)
  ├─ [Sidebar | ResizeHandle | MainDisplay | OperationPanel]
  │      260px    4px    flex:1           280px
  ├─ StatusBar (状态栏)
  └─ ConfigModal (模态弹窗)

数据流:
  Backend  ──invoke──→  tauri.ts  ──→  useTauri.ts  ──→  4 Stores  ──→  Components
           ←──event───           (服务层)     (Hooks层)    (状态管理)      (UI层)
```

## 前端目录结构

```
src/
├── App.tsx                     # 根组件: 布局 + ErrorBoundary + ThemeProvider + useSerialReceive (163 行)
├── main.tsx                    # ReactDOM.createRoot 挂载 (9 行)
├── styles.css                  # @import 入口，聚合 10 个 CSS 文件 (14 行)
├── styles/                     # 拆分后的样式模块
│   ├── base.css                # CSS 变量、主题、reset
│   ├── titlebar.css
│   ├── sidebar.css
│   ├── main-display.css
│   ├── tabbar.css
│   ├── terminal-view.css
│   ├── operation-panel.css
│   ├── status-bar.css
│   ├── config-modal.css
│   └── context-menu.css
├── types/index.ts              # 全局 TS 类型 (219 行)
├── services/tauri.ts           # Tauri invoke 包装 + event 监听 (268 行，6 个服务模块)
├── hooks/useTauri.ts           # React Hooks 桥接层 (378 行，8 个 Hooks)
├── stores/                     # 4 个 Zustand Store (从单一 596 行 god store 拆分)
│   ├── useAppStore.ts          # 主 Store: ports/groups/tabs/panes/config/ui/system/traffic/simulation (437 行)
│   ├── useOperationStore.ts    # 操作区: 16 个 op 字段 + setOpState (55 行)
│   ├── useTerminalStore.ts     # 终端: terminals + ensureTerminal/appendTerminalLine/clearTerminal/setTerminalConfig (49 行)
│   ├── useRuleStore.ts         # 规则集: highlightRuleSets + sendCommandSets CRUD (47 行)
│   └── useAppStore.test.ts     # vitest 单测 (470 行，49 cases)
├── utils/
│   ├── highlightEngine.ts      # 语法高亮引擎 (104 行)
│   ├── highlightEngine.test.ts # 高亮引擎单测 (197 行)
│   └── hexUtils.ts             # hexToString / stringToHex (21 行)
└── components/
    ├── shared/ContextMenu.tsx  # 通用右键菜单 (94 行)
    ├── TitleBar/TitleBar.tsx   # 标题栏 (60 行)
    ├── Sidebar/
    │   ├── Sidebar.tsx         # 串口列表 + 分组 + 拖拽 (482 行)
    │   ├── AliasDialog.tsx     # 备注名弹窗 (37 行)
    │   └── hooks/usePortDragEnd.ts  # 端口拖拽结束处理 (80 行)
    ├── MainDisplay/
    │   ├── MainDisplay.tsx     # 多分屏容器 (132 行)
    │   ├── Pane.tsx            # 单个分屏 (160 行)
    │   ├── ResizeHandle.tsx    # 可拖拽分割线 (34 行)
    │   ├── TabBar.tsx          # 标签页栏 + @dnd-kit 拖拽 (190 行)
    │   ├── TerminalView.tsx    # 终端 + 虚拟滚动 + 高亮 + 导出 (227 行)
    │   └── hooks/useTabDragEnd.ts  # 标签拖拽结束处理 (73 行)
    ├── OperationPanel/
    │   ├── OperationPanel.tsx  # 三栏布局容器 (138 行)
    │   ├── SendSection.tsx     # 发送区 (136 行)
    │   ├── RulesSection.tsx    # 规则/循环发送区 (108 行)
    │   ├── ParamsSection.tsx   # 串口参数区 (137 行)
    │   └── hooks/useCyclicSend.ts  # 循环发送逻辑 (119 行)
    ├── StatusBar/StatusBar.tsx # 系统状态 + 流量 + 时钟 (69 行)
    └── ConfigModal/
        ├── ConfigModal.tsx     # 6 页配置弹窗容器 (109 行)
        ├── RuleSetAccordion.tsx # 通用 CRUD 手风琴 (78 行)
        ├── editors/            # 规则/命令编辑器
        │   ├── HighlightRuleEditor.tsx (35 行)
        │   └── SendCmdEditor.tsx (30 行)
        └── pages/              # 6 个设置页
            ├── GeneralSettings.tsx (92 行)
            ├── LogSettings.tsx (55 行)
            ├── BackupSettings.tsx (33 行)
            ├── DisplaySettings.tsx (45 行)
            ├── HighlightSettings.tsx (126 行)
            └── CommandSettings.tsx (142 行)
```

## 后端目录结构

```
src-tauri/
├── Cargo.toml                  # Rust 依赖
├── tauri.conf.json             # Tauri 配置 (窗口、CSP、构建)
├── capabilities/default.json   # 权限声明
└── src/
    ├── main.rs                 # 程序入口 (5 行)
    ├── lib.rs                  # AppState + 32 命令注册 + setup (135 行)
    ├── system.rs               # Win32 电源 FFI (SetThreadExecutionState) (55 行)
    ├── commands/               # 命令层 (从单文件 590 行拆分为 8 个文件)
    │   ├── mod.rs              # CommandError enum + re-exports (39 行)
    │   ├── serial.rs           # 串口命令 (141 行)
    │   ├── simulation.rs       # 模拟模式命令 (39 行)
    │   ├── config.rs           # 配置命令 (36 行)
    │   ├── log.rs              # 日志命令 (196 行)
    │   ├── system_cmds.rs      # 系统命令 (67 行)
    │   └── storage.rs          # 存储命令 (251 行)
    ├── config/mod.rs           # JSON 配置管理 (219 行)
    ├── logger/mod.rs           # BufWriter 日志 + encoding_rs GBK 解码 (467 行)
    ├── serial/mod.rs           # 串口管理器 + emit_data_event helper (483 行)
    └── storage/mod.rs          # SQLite CRUD (571 行)
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
| TitleBar | `TitleBar/TitleBar.tsx` | 图标、配置按钮、窗口控制、拖拽区域 |
| Sidebar | `Sidebar/Sidebar.tsx` + `AliasDialog` + `usePortDragEnd` | 工具栏、搜索、串口列表、分组、备注名弹窗、@dnd-kit 拖拽 |
| MainDisplay | `MainDisplay/MainDisplay.tsx` + `Pane` + `ResizeHandle` | 分屏容器、Pane 独立渲染、可拖拽分割线 |
| TabBar | `MainDisplay/TabBar.tsx` + `useTabDragEnd` | 标签页渲染、激活样式、右键菜单、@dnd-kit 水平拖拽 |
| TerminalView | `MainDisplay/TerminalView.tsx` | 终端虚拟滚动、时间戳、TX/RX 着色、右键菜单、语法高亮、文件导出 |
| OperationPanel | `OperationPanel/` 5 文件 | 三栏布局：SendSection + RulesSection + ParamsSection；useCyclicSend 处理循环 |
| StatusBar | `StatusBar/StatusBar.tsx` | 系统状态、进程内存、CPU、TX/RX 流量、时钟 |
| ConfigModal | `ConfigModal/` 10 文件 | 6 页设置 + RuleSetAccordion 通用 CRUD + 2 个编辑器 |

### 状态管理 (4 个 Store)

从单一 596 行 god store 拆分为 4 个聚焦 Store：

| Store | 文件 | 职责 | Actions |
|-------|------|------|---------|
| `useAppStore` | 437 行 | ports, groups, tabs, panes, config, ui, system, traffic, simulation + removeEmptyPanes | setPorts, updatePort, addGroup, updateGroup, removeGroup, movePortToGroup, reorderPorts, openTab, closeTab, pinTab, setActiveTab, moveTabToPane, splitPane, removePane, setFocusedPane, reorderTabs, setConfig, resetConfig, setUIState, toggleConfigModal, setConfigActiveTab, setSystemStatus, setTrafficStats, setSimulationMode 等 |
| `useOperationStore` | 55 行 | 16 个 op 字段 (opSendInput, opIsHex, opLineEnding, opIsLoopSending, opLoopInterval, opActiveSendCommandSetId, opCurrentCmdIdx 等) | setOpState |
| `useTerminalStore` | 49 行 | terminals Map | ensureTerminal, appendTerminalLine, clearTerminal, setTerminalConfig |
| `useRuleStore` | 47 行 | highlightRuleSets, activeHighlightSetId, sendCommandSets, activeSendCommandSetId | set/add/update/remove + setActive (各 2 套) |

### Tauri 服务层

`services/tauri.ts` (268 行) — 6 个服务模块，纯函数无 React 依赖：

| 模块 | 方法数 | 说明 |
|------|--------|------|
| `serialService` | 8 | listAvailablePorts, openSerialPort, closeSerialPort, sendSerialData, setSerialParams, setFlowControl, enableSimulation, disableSimulation |
| `configService` | 3 | getConfig, setConfig, resetConfig |
| `logService` | 11 | setLogDirectory, saveLogAs, exportTerminalLog, getLogFiles, startLogging, stopLogging, setLogSplitSize, setLogFilenameFormat, setLogAutoSave, setLogEncoding, openPath, openLogDirectory |
| `systemService` | 3 | getSystemStatus, preventScreenOff, preventSleep |
| `storageService` | 6 | saveCommandSet, loadCommandSets, deleteCommandSet, saveHighlightSet, loadHighlightSets, deleteHighlightSet |
| `eventService` | 4 | onSerialData, onSerialStatus, onSystemStatus, onStorageReady |

### React Hooks 层

`hooks/useTauri.ts` (378 行) — 8 个 Hooks：

| Hook | 频率 | 功能 |
|------|------|------|
| `useSerialPorts(3000)` | 每 3 秒 | 刷新端口列表，`mergePorts` 保留已有状态 |
| `useSerialConnection()` | 按需 | openPort (从 Store 读参数)、closePort、toggleConnection |
| `useSerialReceive()` | 事件驱动 | 监听 serial:data/serial:status 事件，附加终端行，累加流量统计 |
| `useSerialSend()` | 按需 | sendData 封装，发送后附加 TX 终端行 + 累加流量 |
| `useConfigPersistence()` | 按需 | loadConfig、saveConfig、resetAndReload |
| `useSystemStatus(5000)` | 每 5 秒 | 轮询进程 CPU/内存，写入 Store |
| `useAppInit()` | 挂载一次 | 加载配置 + 刷新端口列表 |
| `useSimulation()` | 按需 | 切换模拟模式，刷新端口 |

组件内 Hook：

| Hook | 文件 | 功能 |
|------|------|------|
| `useCyclicSend` | `OperationPanel/hooks/useCyclicSend.ts` | 循环发送序列执行 + 延时控制 |
| `usePortDragEnd` | `Sidebar/hooks/usePortDragEnd.ts` | 端口拖拽结束处理 |
| `useTabDragEnd` | `MainDisplay/hooks/useTabDragEnd.ts` | 标签拖拽结束处理 |

### 高亮引擎

`utils/highlightEngine.ts` (104 行)：

```
applyHighlightSets(text, ruleSets) → HTML string
  └─ 遍历 enabled 规则集的规则
       ├─ 正则匹配: new RegExp(pattern, 'g').exec(text)
       ├─ 关键词匹配: indexOf 循环查找
       └─ 合并去重 (按位置排序，优先留长匹配)
  └─ 构建 <span style="color:...;font-weight:...;font-style:...">...</span>
```

输出通过 `dangerouslySetInnerHTML` 注入终端，文本已 `escapeHtml` 转义防 XSS。配套 `highlightEngine.test.ts` (197 行) 覆盖正则、关键词、去重、嵌套等场景。
