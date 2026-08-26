# 工作区与通知模块

分屏（paneTree）、标签页、弹出体系（popout）、操作面板布局、侧边栏、通知中心、状态栏、自定义文本右键菜单。

## Pane 树（2026-07 重构）

`panes: SplitPane[]` 平铺数组已替换为 `paneTree: PaneNode`（单根递归树）：

```ts
type PaneNode = LeafPane | BranchPane;
interface LeafPane   { id: string; type: 'leaf';   tabIds: string[];    size: number; }
interface BranchPane { id: string; type: 'branch'; direction: SplitDirection; children: PaneNode[]; size: number; }
```

- `focusedPaneId` 引用树中的**叶子 id**（不再是扁平数组索引）。
- 树辅助函数全部在 `src/stores/useAppStore.ts` 顶层 export：`findLeafById`、`findLeafByTabId`、`findParentBranch`、`findBranchById`、`collectLeaves`、`countLeaves`、`pruneTree`（私有）。
- `pruneTree` 自动：① 删除非根空叶子 → ② 折叠只有 1 个子节点的分支为该子节点（继承 size）→ ③ 根分支为空时退化为空叶 `'main'`。
- `MainDisplay.tsx` 用 `renderNode(node, parentBranch)` 递归渲染；分支 flex 容器内 ResizeHandle 调 `resizeChildren(branchId, childIndex, deltaFraction)`。
- `useTabDragEnd` 用 `findLeafByTabId` / `findLeafById` 树遍历，**不再用 `state.panes.find(...)`**。
- 新 splitPane：找焦点叶子 → 在父分支子数组里替换为含 [源叶(0.5), 新叶(0.5)] 的新分支；焦点叶是根时整树替换。
- 测试断言：`state.paneTree.type === 'branch'` 后 `as BranchPane` 再断 `children`——严禁 `state.panes[0]` / `state.panes.length`。

## 标签页

- TabBar 右键菜单：批量开关串口（「打开/断开所有标签页」遍历全局 tabs 逐个 open/close，100ms 节流，issue #2-1）、外部工具（与侧边栏同源 `usePortToolActions`）。
- **关闭标签页 ≠ 关闭串口（issue #11）**：`Pane.cleanupClosedTab` 不再调 `closePort`（端口/日志保持连接），改 `getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` + `releaseViewportManager`——重开标签页从零开始新一轮输出。
- **TTY 标签常驻挂载**：Pane 对当前 Pane 内所有 TTY 标签各渲染一个 TtyView（非活动 `display:none`），TRX 标签照旧只在展示时挂载（缓冲在 manager，无实例生命周期）——见 tty.md。

## 弹出体系（popout，issue #10）

**核心架构原则**：弹出窗之间**不共享可变前端态，只交换「意图/事件」**；后端 / config.json 是唯一真相，事件只当「刷新信号」（不携带数据）——弹窗收到信号后自己回库读，避免两个 store 对不齐。

### 通用弹出管线（Rust `commands/popout.rs`）

- 窗口注册表 `AppState.popouts: Mutex<HashMap<String, PopoutMeta>>`，key 为窗口 label，value 记 `{kind, target_id}`；label 约定：快捷发送 = `"quick-send"`（单例）、终端 = `"terminal-{safe_id}"`（每端口一个，portId 需安全化映射）。
- `open_popout(kind, target_id)`：label 已存在 → `set_focus()` 拉起；否则 WebviewWindowBuilder 新建。URL `index.html?popout={kind}&id={target_id}`；`.decorations(false)` + `.always_on_top(true)` + `.skip_taskbar(true)` + `.parent(&main)`（owner 语义：随主窗最小化/销毁、恒在主窗之上）+ 按 kind 取默认尺寸；位置/尺寸从持久化配置恢复（`popoutBounds`，跨会话持久化）。
- `close_popout(label)` / `set_popout_always_on_top(label, on)`；窗口移动/缩放结束回写持久化位置。

### 前端路由分流（main.tsx）

- 无 React Router：`new URLSearchParams(window.location.search)` 读 `popout` 参数；有 → `<PopoutShell/>`（按 kind 分发 QuickSendPanel / TerminalPopout）；无 → `<App/>`。

### 意图/事件协议（`usePopoutBridge` + `popoutEventService`）

| 事件 | 方向 | 载荷 | 用途 |
|---|---|---|---|
| `command-sets:changed` | 主窗 → 快捷发送窗 | **完整 `SendCommandSet[]`** | 命令集改动后弹窗直接 `setSets(载荷)`（曾是无载荷信号回库重读——未保存编辑只存在于主窗 store，弹窗读不到；改为主窗 store 是唯一真相） |
| `active-tab:changed` | 主窗 → 快捷发送窗 | `portId` | 弹窗知道发送到哪个端口 |
| `serial:data` | 后端 → 所有窗 | 字节流 | 终端弹窗订阅（主窗与弹出窗各自模块单例） |
| `popout:terminal:snapshot` | 主窗 → 终端弹窗 | 历史行（一次性） | 弹出时补历史（快照与现有实时行合并，不丢新行——曾 replaceAll 竞态丢行） |
| `popout:open-config` | 弹窗 → 主窗 | `{page}` | 弹窗请求主窗打开 ConfigModal 指定页 |

- 发送：弹窗直接 `invoke('send_data')` → 共享 AppState → 后端 emit serial:data → 主窗 useSerialReceive 自动写终端——**发送→回显链路天然跨窗口**。弹窗发送经 `popout:send-command` → `sendToPort(activeTabId)`（模块级 sendToPort，TX echo/流量/历史工作）。
- `usePopoutBridge` 全部 fire-and-forget emit 补 `.catch`（弹窗销毁时 rejection 不再 unhandled）。
- 主窗 `command-sets:changed` / `active-tab:changed` 在 store 变更时广播；`popout:request-sync` → 回放 active-tab。

### 耦合度判据（为何串口控制栏被排除弹出）

| 弹出对象 | 数据关系 | 耦合度 |
|---|---|---|
| 快捷发送 | 只**发**（走后端命令，天然跨窗口） | 低 |
| 终端标签 | 只**收**（订阅 serial:data 流 + 一次性历史快照） | 中（TTY 端口阻止弹出——独立 webview 不共享 ttyService/xterm 实例） |
| 串口控制栏 | **又读又写前端态**（端口列表同步 + 开标签/切焦点反映到主窗 useAppStore） | 高（排除） |

- `popoutBounds` 配置持久化；`quickSendInlineCount` 默认 6（0 = 隐藏内联条，纯窗口模式）。
- 权限：capabilities 给弹出窗 label 授权（**漏配会导致弹窗内 invoke 静默失败**）。

## 操作面板与侧边栏

- OperationPanel 分区：`OperationPanel.tsx` + `SendSection.tsx` + `ParamsSection.tsx`（旧 `RulesSection.tsx` 已删——命令集选择+循环开关收进 SendSection 紧凑头部 `.op-send-header`，高亮下拉是死控件）。**组件定义在模块级**（父组件内定义子组件会因函数身份变化导致 DOM 销毁/输入失焦）。
- Resize：`OperationPanelResizeHandle.tsx` + `ui.operationPanelHeight`（默认 280px，clamp [160,600]）。
- 布局防线：`.op-section > * { flex-shrink: 0 }`（面板变矮时发送键不被压塌叠压）；`.op-section-params` `max-width: 300px` 封顶（宽窗口参数栏不挤占发送区）。
- Sidebar：`Sidebar.tsx` + `AliasDialog.tsx`；端口右键菜单分组控制（见 serial.md）。
- 设置弹窗 ConfigModal 框选文字松手界外不关闭（issue #6-8）：overlay pointerdown 记录起点是否在弹窗内，click 时起点在弹窗内则忽略关闭。

## 通知中心 / toast

- `useToastStore` + `StatusBar/NotificationCenter.tsx`：`durationMs === 0` = 粘滞（Toast.tsx 跳过自动关闭计时）；超过 `MAX_VISIBLE=5` 进 `stashed` 溢出队列不丢弃；`clearAll()` / `setCenterOpen`；铃铛+badge 挂 StatusBar `.statusbar-right`，外点/Escape 关闭。
- `ToastItem.portId?`（issue #7-1）：串口来源消息（触发告警/断线/发送目标关闭/重连失败）携带串口号，通知行渲染 `.notify-row-port` chip + `.notify-row-time` HH:MM:SS 时间戳（`createdAt` push 时打点）。
- 面板尺寸：`.notify-panel` 360×400px（issue #6-7）。

## 状态栏

- `StatusBar.tsx`：端口连接计数、CPU、**应用进程树级内存**（`get_system_status`：本进程+全部后代进程含 WebView2/Chromium 子进程 RSS 之和——`collect_app_pids` 纯函数 + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`；CPU 仍系统级；`memory_used_mb`/`load_status` 纯函数可注入进程表单测）。
- `useSystemStatus` 5s 轮询；DisconnectBanner（`disconnectTracking.ts` `isPortLost`/`filterLostTabIds`，suppresses 会话恢复标签的启动误报）。

## 自定义文本右键菜单（issue #7-10）

- `TextEditContextMenu` + `useTextEditContextMenu()`：输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`contextMenu.*` i18n）；document 级拦截——可编辑目标 preventDefault + 弹菜单（右键时快照选区，点击项先 `focus({preventScroll:true})` + 恢复选区再 `document.execCommand`——mousedown 在菜单上会先 blur 目标丢掉选区），非可编辑目标一律 preventDefault。
- **必须在 App 根 + PopoutShell 各挂一次**（弹窗是独立 webview，旧 App.tsx effect 从未覆盖）。组件级 `onContextMenu`（stopPropagation 的终端行/侧边栏/标签页）不受影响。
