# 组件参考

## 布局视图

```
┌─────────────────────────────────────────────────────────┐
│ TitleBar                                    [_] [□] [X] │  36px
├──────────┬──────────────────────────────────────────────┤
│ Sidebar  │ MainDisplay                                   │
│ ┌──────┐ │ ┌──────────────────────────────────────────┐ │
│ │Toolbar│ │ │ TabBar: [● COM3] [● COM5] [+] [分屏]    │ │
│ ├──────┤ │ ├──────────────────────────────────────────┤ │
│ │Search │ │ │ TerminalView                              │ │
│ ├──────┤ │ │ 09:30:01.000 RX System start...           │ │
│ │Group1▸│ │ │ 09:30:02.100 TX >>>>>>SEND AT+PING       │ │
│ │ ● COM3│ │ │ 09:30:02.200 RX +PONG: OK               │ │
│ │ ● COM4│ │ │                                          │ │
│ │Group2▸│ │ │                                          │ │
│ │ 未分组 │ │ └──────────────────────────────────────────┘ │
│ │ ● COM7├──────────────────────────────────────────────┤
│ │ 已隐藏 │ │ OperationPanel                              │
│ └──────┘ │ │ [SendSection | RulesSection | ParamsSection]│  280px
│          │ └──────────────────────────────────────────────┘
├──────────┴──────────────────────────────────────────────┤
│ StatusBar  ● 运行正常  150MB/1024MB  CPU 2.3% │ TX:1.2KB RX:8.5KB  14:30 │
└─────────────────────────────────────────────────────────┘
```

## 组件树与 Props

```
App
  ├─ ErrorBoundary (捕获子树渲染错误)
  ├─ ThemeProvider (设置 data-theme 属性)
  │   ├─ TitleBar
  │   │   └─ props: 无 (直接操作 Store)
  │   ├─ Sidebar
  │   │   └─ props: 无 (直接操作 Store + Hooks)
  │   │   └─ 子组件:
  │   │       ├─ SidebarToolbar (showHidden, onToggleHidden, onRefresh, ...)
  │   │       ├─ SearchBox (value, onChange)
  │   │       ├─ GroupItem (group, ports, onOpenTab, onToggleConnect, ...)
  │   │       │   └─ DndContext → SortableContext → SortablePortItem[]
  │   │       ├─ SortablePortItem (port, isConnected, onOpenTab, ...)
  │   │       ├─ AliasDialog (portId, currentAlias, onSave, onCancel)
  │   │       └─ usePortDragEnd (拖拽结束处理 Hook)
  │   ├─ SidebarResizeHandle (拖拽调整宽度)
  │   ├─ MainDisplay
  │   │   ├─ 全局工具栏 (分屏按钮)
  │   │   └─ Pane[] (每个分屏)
  │   │       ├─ TabBar (tabs, activeTabId, onTabClick, ...)
  │   │       │   └─ DndContext → SortableContext → SortableTab[]
  │   │       │   └─ useTabDragEnd (拖拽结束处理 Hook)
  │   │       ├─ ResizeHandle (分割线拖拽)
  │   │       ├─ terminal-toolbar (端口信息 + 编码选择)
  │   │       └─ TerminalView (portId, terminal)
  │   ├─ OperationPanel
  │   │   └─ props: 无 (直接操作 Store + Hooks)
  │   │   └─ 子组件:
  │   │       ├─ SendSection (发送区: 输入 + HEX + 行结束符)
  │   │       ├─ RulesSection (循环发送: 命令集选择 + 启停)
  │   │       │   └─ useCyclicSend (循环发送逻辑 Hook)
  │   │       └─ ParamsSection (串口参数: 波特率/数据位/校验/停止位/流控/DTR/RTS)
  │   ├─ StatusBar
  │   │   └─ props: 无 (直接操作 Store + Hooks)
   │   └─ ConfigModal (overlay)
   │       ├─ 左侧导航 (general/log/backup/display/highlight/commands/protocol)
   │       └─ 右侧内容:
   │           ├─ GeneralSettings
   │           ├─ LogSettings
   │           ├─ BackupSettings
   │           ├─ DisplaySettings
   │           ├─ HighlightSettings
   │           │   └─ RuleSetAccordion (通用 CRUD 手风琴)
   │           │       └─ HighlightRuleEditor
   │           ├─ CommandSettings
   │           │   └─ RuleSetAccordion
   │           │       └─ SendCmdEditor
   │           └─ ProtocolSettings
   │               └─ RuleSetAccordion
   │                   └─ ProtocolTemplateEditor
```

## 类型定义速查

```typescript
// 串口
SerialPort       { id, name, alias?, status, type, isHidden, groupId?, baudRate?, dataBits?, parity?, stopBits?, handshake? }
PortStatus       'disconnected' | 'error' | 'connected'
PortType         'real' | 'virtual' | 'sim'
PortGroup        { id, name, isExpanded, portIds[], order }
DataBits         5 | 6 | 7 | 8
Parity           'None' | 'Even' | 'Odd' | 'Mark' | 'Space'
StopBits         'One' | 'Two' | 'OnePointFive'
Handshake        'None' | 'XonXoff' | 'RequestToSend' | 'RequestToSendXonXoff'
LineEnding       '\\r\\n' | '\\r' | '\\n' | 'None'
Encoding         'ASCII' | 'UTF-8' | 'GBK' | 'ISO-8859-1'
DisplayFormat    'string' | 'hex' | 'binary'

// 标签页
TabItem          { id, title, isPinned, isActive, splitPaneId }
SplitPane        { id, direction, tabIds[], size }

// 终端
TerminalLine     { id, timestamp, direction, content, displayContent?, rawData?, isHex }
TerminalState    { lines[], maxLines, scrollLocked, showTimestamp, displayFormat, encoding }

// 高亮
HighlightRule    { id, name, pattern, isRegex, color?, bold?, italic? }
HighlightRuleSet { id, name, rules[], isEnabled }

// 命令
SendCommand      { id, name, order, delay, type, content, appendLineEnding }
SendCommandSet   { id, name, commands[], isLoop, loopDelay }

// 配置 (18 组 36 字段)
AppConfig        { closeBehavior, memoryLimitMB, language, theme, preventScreenOff,
                   preventSleep, terminalFont, terminalFontSize, uiFont, uiFontSize,
                   backgroundImage?, defaultBaudRates[], defaultLineEnding, sendPrefix,
                   showPortType, timestampMode, autoSaveLog, logDirectory,
                   logFilenameFormat, logFormat, logEncoding, logSplitEnabled,
                   logSplitSizeMB, backupEnabled, backupInterval, backupDirectory }

// 系统
SystemStatus     { status, memoryUsedMB, memoryLimitMB, cpuUsage }
TrafficStats     { portId, txTotal, rxTotal }
UIState          { isConfigOpen, configActiveTab, sidebarWidth, operationPanelHeight, isOperationPanelCollapsed }
```

## 样式系统 (CSS Variables)

样式从单文件 `styles.css` (1470 行) 拆分为 10 个模块文件，`styles.css` (14 行) 仅作 `@import` 入口。重构中清理了 20 个无用 class。

| 文件 | 职责 |
|------|------|
| `styles/base.css` | CSS 变量、主题、reset |
| `styles/titlebar.css` | 标题栏 |
| `styles/sidebar.css` | 侧边栏 |
| `styles/main-display.css` | 主显示区 |
| `styles/tabbar.css` | 标签页栏 |
| `styles/terminal-view.css` | 终端视图 |
| `styles/operation-panel.css` | 操作面板 |
| `styles/status-bar.css` | 状态栏 |
| `styles/config-modal.css` | 配置弹窗 |
| `styles/context-menu.css` | 右键菜单 |

暗色主题 (`:root`)：
```css
--bg-primary: #1e1e1e;     --bg-secondary: #252526;    --bg-tertiary: #2d2d30;
--text-primary: #cccccc;    --text-secondary: #858585;   --text-link: #4fc3f7;
--border-color: #3e3e42;    --bg-hover: #2a2d2e;         --bg-active: #094771;
--status-connected: #4ec9b0; --status-error: #f44747;     --status-disconnected: #6a9955;
--terminal-tx-color: #dcdcaa; --terminal-rx-color: #4fc1ff;
```

亮色主题 (`:root[data-theme="light"]`) 对应覆盖所有变量。

组件 CSS class 体系遵循 kebab-case 命名 (`.port-item-name`, `.terminal-toolbar-title`)。

## 共享组件

### ContextMenu (`shared/ContextMenu.tsx`，94 行)

```tsx
// 使用 useContextMenu Hook (推荐)
const { show, element } = useContextMenu();
return (
  <div onContextMenu={(e) => show(e, items)}>
    内容
    {element}
  </div>
);

// 使用 ContextMenu 组件 (直接)
<ContextMenu x={e.clientX} y={e.clientY} items={items} onClose={...} />

// items 类型
type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;
interface ContextMenuItem {
  label: string; icon?: ReactNode; onClick: () => void;
  danger?: boolean; disabled?: boolean;
}
interface ContextMenuSeparator { type: 'separator'; }
```

特性：视口边界自动检测、ESC/点击外部关闭、CSS 入场动画、danger/disabled 样式。

## 配置弹窗组件

### RuleSetAccordion (`ConfigModal/RuleSetAccordion.tsx`，78 行)

通用 CRUD 手风琴组件，被 HighlightSettings 和 CommandSettings 复用，消除两页之间的重复列表/增删逻辑：

```tsx
<RuleSetAccordion
  sets={ruleSets}
  activeSetId={activeId}
  onSelect={handleSelect}
  onAdd={handleAdd}
  onDelete={handleDelete}
  onToggle={handleToggle}
  renderEditor={(set) => <HighlightRuleEditor ... />}
/>
```

### 编辑器 (`ConfigModal/editors/`)

| 编辑器 | 文件 | 职责 |
|--------|------|------|
| `HighlightRuleEditor` | 35 行 | 单条高亮规则编辑 (pattern/isRegex/color/bold/italic) |
| `SendCmdEditor` | 30 行 | 单条发送命令编辑 (type/content/appendLineEnding/delay) |
