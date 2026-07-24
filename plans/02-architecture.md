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
├── types/index.ts              # 全局 TS 类型 (288 行, 含 SendHistoryEntry)
├── services/tauri.ts           # Tauri invoke 包装 + event 监听 (410 行，6 个服务模块)
├── hooks/
│   ├── useTauri.ts             # React Hooks 桥接层 (886 行，8 个 Hooks + lostPortIds/filterLostTabIds)
│   └── useHotkeys.ts           # 快捷键绑定 (61 行)
├── stores/                     # 4 个 Zustand Store (从单一 596 行 god store 拆分)
│   ├── useAppStore.ts          # 主 Store: ports/groups/tabs/panes/config/ui/system/traffic/simulation (672 行)
│   ├── useOperationStore.ts    # 操作区: 串口参数 + 发送字段 (45 行) — 无显示状态/编码/循环间隔
│   ├── useTerminalStore.ts     # 终端: terminals + ensureTerminal/appendTerminalLine/clearTerminal/setTerminalConfig/setTerminalEncoding (73 行)
│   ├── useRuleStore.ts         # 规则集: highlightRuleSets + sendCommandSets CRUD (47 行)
│   └── useAppStore.test.ts     # vitest 单测 (606 行，56 cases)
├── utils/
│   ├── highlightEngine.ts      # 语法高亮引擎 (104 行)
│   ├── highlightEngine.test.ts # 高亮引擎单测 (197 行, 22 cases)
│   ├── hexUtils.ts             # hexToString / stringToHex (21 行)
│   ├── sendUtils.ts            # HEX<->文本双向转换 + sanitize (108 行)
│   ├── sendUtils.test.ts       # 发送工具单测 (120 行, 21 cases)
│   ├── timeFormat.ts           # 时间戳格式化
│   └── timeFormat.test.ts      # 时间格式化单测 (88 行, 13 cases)
└── components/
    ├── shared/ContextMenu.tsx  # 通用右键菜单 (94 行)
    ├── shared/HotkeyHelpDialog.tsx # 快捷键帮助弹窗 (66 行)
    ├── TitleBar/TitleBar.tsx   # 标题栏 (60 行)
    ├── Sidebar/
    │   ├── Sidebar.tsx         # 串口列表 + 分组 + 拖拽 + open-all/close-all 按钮 (527 行)
    │   ├── AliasDialog.tsx     # 备注名弹窗 (37 行)
    │   ├── GuideCard.tsx       # 首启引导卡
    │   └── hooks/usePortDragEnd.ts  # 端口拖拽结束处理 (80 行)
    ├── MainDisplay/
    │   ├── MainDisplay.tsx     # 多分屏容器 (156 行)
    │   ├── Pane.tsx            # 单个分屏 (175 行)
    │   ├── ResizeHandle.tsx    # 可拖拽分割线 (34 行)
    │   ├── TabBar.tsx          # 标签页栏 + @dnd-kit 拖拽 + split 按钮 (211 行)
    │   ├── TerminalFilterBar.tsx # per-tab showTimestamp/scrollLocked/displayFormat/encoding 控件 (162 行)
    │   ├── TerminalView.tsx    # 终端 + 虚拟滚动 + 高亮 + 导出 + 过滤 (316 行)
    │   ├── TerminalRow.tsx     # 单行渲染组件
    │   ├── TerminalSearchBar.tsx # 终端内 Ctrl+F 搜索条
    │   └── hooks/useTabDragEnd.ts  # 标签拖拽结束处理 (73 行)
    ├── OperationPanel/
    │   ├── OperationPanel.tsx  # 顶部 strip (连接/清屏 | 回放速率/启停 | 日志 | 字号) + 三栏布局 (212 行)
    │   ├── SendSection.tsx     # 发送区: HEX<->文本双向 + 文件发送 + 输入框 (283 行)
    │   ├── RulesSection.tsx    # 循环发送 + 命令集区 (110 行) — 无 loopInterval 字段
    │   ├── ParamsSection.tsx   # 串口参数: apply-only 预设下拉 (119 行)
    │   └── hooks/useCyclicSend.ts  # 循环发送逻辑 (138 行)
    ├── StatusBar/
    │   ├── StatusBar.tsx       # 系统状态 + 流量 + 时钟 (69 行)
    │   └── DisconnectBanner.tsx # 断线横幅 (filterLostTabIds 驱动) (71 行)
    └── ConfigModal/
        ├── ConfigModal.tsx     # 6 页配置弹窗容器 (109 行)
        ├── RuleSetAccordion.tsx # 通用 CRUD 手风琴 (78 行)
        ├── editors/            # 规则/命令编辑器
        │   ├── HighlightRuleEditor.tsx (35 行)
        │   └── SendCmdEditor.tsx (30 行)
        └── pages/              # 6 个设置页
            ├── GeneralSettings.tsx (248 行) — 含 Enter 行为开关 + 预设管理
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
| TabBar | `MainDisplay/TabBar.tsx` + `useTabDragEnd` | 标签页渲染、激活样式、右键菜单、@dnd-kit 水平拖拽、右端分屏按钮 (`onSplitVertical` / `onSplitHorizontal`) |
| TerminalView | `MainDisplay/TerminalView.tsx` + `TerminalFilterBar.tsx` + `TerminalRow.tsx` + `TerminalSearchBar.tsx` | 终端虚拟滚动、虚拟滚动；per-tab 显示控件（时间戳/滚动锁/HEX·字符串/编码）走 `TerminalFilterBar` 直写 `useTerminalStore`；编码切换通过 `setTerminalEncoding` 重解码存量行；Ctrl+F 搜索条穿透虚拟视口 |
| DisconnectBanner | `StatusBar/DisconnectBanner.tsx` | 仅展示本次会话真实断线（`filterLostTabIds` 驱动，`isPortLost` 仅 connected→disconnected 的端口入 Set） |
| OperationPanel | `OperationPanel/` 4 文件 + `useCyclicSend` hook | 顶部 strip 集中了连接/清屏、回放速率/启停、日志另存/打开/打开目录、字号；下方三栏 SendSection + RulesSection + ParamsSection；useCyclicSend 仅按 per-command delay + 命令集 loopDelay + 错误重试 500ms 驱动（无 loopInterval 字段） |
| StatusBar | `StatusBar/StatusBar.tsx` | 系统状态、进程内存、CPU、TX/RX 流量、时钟 |
| ConfigModal | `ConfigModal/` 10 文件 | 6 页设置 + RuleSetAccordion 通用 CRUD + 2 个编辑器；`GeneralSettings.tsx` 承载 Enter 行为开关 (`!config.sendOnEnter`) 与预设列表/命名/保存当前参数 |

### 状态管理 (4 个 Store)

从单一 596 行 god store 拆分为 4 个聚焦 Store：

| Store | 文件 | 职责 | Actions |
|-------|------|------|---------|
| `useAppStore` | 672 行 | ports, groups, tabs, paneTree, config, ui, system, traffic, simulation + removeEmptyPanes | setPorts, updatePort, addGroup, updateGroup, removeGroup, movePortToGroup, reorderPorts, openTab, closeTab, pinTab, setActiveTab, moveTabToPane, splitPane, removePane, setFocusedPane, reorderTabs, setConfig, resetConfig, setUIState, toggleConfigModal, setConfigActiveTab, setSystemStatus, setTrafficStats, setSimulationMode 等 |
| `useOperationStore` | 45 行 | 仅串口参数 + 发送字段 (`baudRate`, `dataBits`, `parity`, `stopBits`, `handshake`, `dtr`, `rts`, `ignoreEmptyChars`, `sendIsHex`, `sendAppendLineEnding`, `sendInput`, `isLoopSending`, `loopRepeatCount`)，**无** `scrollLocked`/`showTimestamp`/`displayFormat`/`encoding`/`loopInterval` | setOpState |
| `useTerminalStore` | 73 行 | terminals Map (per-tab `scrollLocked`/`showTimestamp`/`displayFormat`/`encoding`) | ensureTerminal, appendTerminalLine, clearTerminal, setTerminalConfig, **setTerminalEncoding** (重解码存量行) |
| `useRuleStore` | 47 行 | highlightRuleSets, activeHighlightSetId, sendCommandSets, activeSendCommandSetId | set/add/update/remove + setActive (各 2 套) |

### Tauri 服务层

`services/tauri.ts` (410 行) — 6 个服务模块，纯函数无 React 依赖：

| 模块 | 方法数 | 说明 |
|------|--------|------|
| `serialService` | 8 | listAvailablePorts, openSerialPort, closeSerialPort, sendSerialData, setSerialParams, setFlowControl, enableSimulation, disableSimulation |
| `configService` | 3 | getConfig, setConfig, resetConfig |
| `logService` | 11 | setLogDirectory, saveLogAs, exportTerminalLog, getLogFiles, startLogging, stopLogging, setLogSplitSize, setLogFilenameFormat, setLogAutoSave, setLogEncoding, openPath, openLogDirectory |
| `systemService` | 3 | getSystemStatus, preventScreenOff, preventSleep |
| `storageService` | 6 | saveCommandSet, loadCommandSets, deleteCommandSet, saveHighlightSet, loadHighlightSets, deleteHighlightSet |
| `eventService` | 4 | onSerialData, onSerialStatus, onSystemStatus, onStorageReady |

### React Hooks 层

`hooks/useTauri.ts` (886 行) — 8 个 Hooks + 模块级 `lostPortIds: Set<string>` + `isPortLost` helper：

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
| `useCyclicSend` | `OperationPanel/hooks/useCyclicSend.ts` | 循环发送序列执行 + per-command delay + 命令集 loopDelay + 错误重试 500ms（无 loopInterval 字段） |
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
