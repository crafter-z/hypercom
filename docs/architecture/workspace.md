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
- **树辅助函数已移出 `useAppStore`**，收在纯函数模块 `src/utils/paneTree.ts`（纯数据进、纯数据出，与 Zustand 无关）：`newPaneId`、`findLeafById`、`findLeafByTabId`、`findParentBranch`、`findBranchById`、`collectLeaves`、`countLeaves`、`pruneTree`。store 只保留 Immer action（`splitPane` / `moveTabToPane` / `resizeChildren` / 4 个关闭动作），内部按需 import 这些函数。
- `pruneTree` 自动：① 删除非根空叶子 → ② 折叠只有 1 个子节点的分支为该子节点（继承 size）→ ③ 根分支为空时退化为空叶 `'main'`。
- `MainDisplay.tsx` 用 `renderNode(node, parentBranch)` 递归渲染；分支 flex 容器内 ResizeHandle 调 `resizeChildren(branchId, childIndex, deltaFraction)`——拖拽的 press → window mousemove → window mouseup 生命周期来自共享原语 `shared/useDragResize`（`mode:'delta'` 报累计位移，组件自行对累计值取差还原 store 的「逐事件增量」语义）。
- `useTabDragEnd` 从 `src/utils/paneTree.ts` 引入 `findLeafByTabId` / `findLeafById` 做树遍历（**不再用 `state.panes.find(...)`**）。
- 新 splitPane：找焦点叶子 → 在父分支子数组里替换为含 [源叶(0.5), 新叶(0.5)] 的新分支（新分支继承源叶原 size）；焦点叶是根时整树替换（新分支 size = 1）。
- 测试断言：`state.paneTree.type === 'branch'` 后 `as BranchPane` 再断 `children`——严禁 `state.panes[0]` / `state.panes.length`。

## 标签页

- `TabItem = SerialTabItem | PluginTabItem`：公共 `id` 是工作区 UUID，`paneTree`、`activeTabId`、拖拽、固定和关闭动作都引用这个 UUID，不再把端口号当作标签身份。串口标签为 `{ kind: 'serial', portId, ... }`；插件标签为 `{ kind: 'plugin', pluginId, installGeneration, viewId, boundPortId, instanceKey, restoreOnStartup, ... }`，其中 `boundPortId` 可为 `null`。
- `openTab(portId)` 只查找或创建该端口的串口标签，并返回工作区 UUID；额外插件标签不占用这个串口标签身份。串口连接、收发管线、TTY、流量和发送历史仍按 `portId` 索引。显式目标用目标端口；活动目标由 `getActivePortId` / `getTabPortId` 解析，无端口工具页返回 `null`，绝不回退到上一次活动串口。
- TabBar 右键菜单的「打开/断开所有标签页」解析全局标签的端口并去重，跳过无端口工具页，顺序执行并按 100ms 节流；外部工具入口与侧边栏共用 `usePortToolActions`。
- **关闭标签页 ≠ 关闭串口**：关闭一个插件标签只退休该视图实例与输入订阅，不关闭原始串口标签、同端口其他插件标签或物理连接；关闭原始串口标签也不终止仍在消费该端口的插件视图。后端日志独立于标签继续运行。批量关闭用 `getClosingTabIds(tabId, scope)` 取得与 store 动作一致的集合。
- 串口标签关闭时 `Pane.cleanupClosedTab` 按 `portId` detach TTY、释放 viewport 并丢弃原始终端待显示队列；移除标签后经 `releaseUnusedPortState(portId)` 检查剩余消费者。只有没有串口标签、绑定视图或相关行消费者时，才回收该端口的终端显示状态、流量累计与 TX 历史；不会因关掉一个视图破坏其他消费者。断开串口不是同一回收动作，仍存标签的编码等显示态可跨重连保留。
- **TRX 与 TTY 都由稳定的 `SerialContentHost` 持有**：宿主在变化的 Pane 树之外，按串口标签 UUID 渲染 `TerminalView` / `TtyView`；Pane 中的 `PluginViewSurface` 只上报内容区坐标与可见性。切标签、分屏拖动或选择插件显示时隐藏原始内容层，不因 Pane 的挂载变化重建串口组件；关闭标签、弹出或切换 TRX/TTY 模式仍可能结束相应实例。

### 插件显示与独立工作区标签

- 串口标签顶部「显示方式」可选「原始终端」或声明了 `serial-content` 的插件视图，只替换内容区，不改变端口参数与串口标签身份。顶部「在新标签中打开…」可创建声明了 `workspace-tab` 的独立视图，固定绑定当前明确端口，允许原始终端与表格、波形同时存在。
- 主显示区的「打开插件工具页…」列出可无端口运行的工作区视图；这类标签不隐式绑定当前或最近端口。插件侧边栏按钮、端口菜单也可经 Worker 请求打开视图。
- 插件标签标题旁显示宿主提供的插件 ID，内容工具栏显示插件 ID 与绑定端口（如有）；选择器以插件名与视图名标明来源。插件 HTML 不注入主窗口，而在独立原生 WebView 内运行；一个插件仍只有一个业务 Worker，各视图有独立会话与输入租约。
- Worker `tabs.open` 按 `(pluginId, installGeneration, viewId, boundPortId, instanceKey)` 去重，重复打开返回已有标签。默认后台打开不抢焦点；请求前台打开或激活必须消费真实宿主用户操作产生的短时、单次、作用域匹配令牌。用户直接使用宿主选择器则直接前台打开；宿主创建入口不要求 `ui:tabs`，插件 Worker 自主管理标签才要求该权限。用户关闭的同一实例键不能被后台请求立即重新打开，显式用户打开或有效前台动作可以再打开。
- 禁用、撤权、升级、缺失端口、模式不兼容或 UI/Worker 错误时，**独立插件标签**保留带来源与错误的不可用占位，可重试或关闭；**串口内容替换**回退原始终端并显示不可用提示与重试按钮，保留用户原选择供排错。切回「原始终端」才显式清除该偏好。
- 串口显示偏好落在 `config.portMeta[].displayView`，内容仅为 `{ pluginId, installGeneration, viewId }`，随端口元数据自动保存，和会话恢复开关独立。额外插件标签只在开启「启动时恢复上次会话」且声明允许恢复时，把标签描述符与 Pane 布局写入会话快照；不保存解析模型、输入历史、打开参数、操作令牌或原生句柄。启动恢复重新核对安装代次、授权、视图和端口，不能恢复授权，不能自动连接串口。
- 插件工作区标签与生效中的插件串口显示均禁止弹出；回退或手动切回原始 TRX 终端后，可按既有终端弹出规则操作，TTY 仍禁止弹出。
- 当前只有 **Windows 原生适配器**实现隔离视图；其他平台在原生创建入口明确拒绝，不使用 iframe 或主窗口 HTML 降级。跨平台隔离策略验收仍是开放对应平台的发布门禁，不代表已完成全平台或完整安全验收。

用户操作见[设置：插件视图与工具标签](../userwiki/设置.md#插件视图与工具标签)，作者 API 见[插件开发指南](../plugin-development.md)，可运行示例见[Sensor Workspace](../../examples/plugin-views-demo/README.md)。

## 弹出体系（popout，issue #10）

**核心架构原则**：弹出窗与主窗**不共享可变前端态**。后端 / config.json 是唯一持久真相，主窗的 `useRuleStore` / `useAppStore` 是唯一**活实体**来源；跨窗事件分两类——**意图**（弹窗 → 主窗请求动作，如 `popout:send-command` / `popout:open-config`）与**完整载荷广播**（主窗 → 弹窗，弹窗直接消费、不回库重读；盘上内容落后于未保存编辑，回库读会读到旧值）。

### 通用弹出管线（Rust `commands/popout.rs`）

- 窗口注册表 `AppState.popouts: Mutex<HashMap<String, PopoutMeta>>`，key 为窗口 label，value 记 `{kind, target_id}`；label 约定：快捷发送 = `"quick-send"`（单例）、终端 = `"terminal-{safe_id}"`（每端口一个）。
- **label 只由 Rust 计算**：`sanitize`（portId 安全化）+ `compute_label`（按 kind + target_id 拼 label，未知 kind 返回 Err）是唯一实现；三个命令只收业务语义参数，前端不复制这套规则（前端 `Popout/popoutLabel.ts` 已删除）。
- `open_popout(kind, target_id)`（**async**——Windows/Webview2 下同步命令建窗会死锁）：label 已存在 → `show()` + `set_focus()` 拉起；否则 WebviewWindowBuilder 新建。URL `index.html?popout={kind}&id={target_id}`；`.decorations(false)` + `.always_on_top(true)` + `.skip_taskbar(true)` + `.parent(&main)`（owner 语义：随主窗最小化/销毁、恒在主窗之上）+ 按 kind 取默认尺寸（快捷发送 280×640 / 终端 720×480）。
- `close_popout(kind, target_id)` / `set_popout_always_on_top(kind, target_id, on)`（窗口由 kind + target_id 算出，不存在时返回 Err）。弹窗位置/尺寸**不跨会话持久化**，每次新建都取默认尺寸。
- 终端弹窗销毁由 `lib.rs::on_window_event` 的 `Destroyed` 分支感知（X 按钮与 `close_popout` 两条路径都恰好触发一次）：先从注册表移除，再 emit `popout:terminal:closed`——主窗据此清除标签的 detach 标记、恢复终端显示。

### 前端路由分流（main.tsx）

- 无 React Router：`new URLSearchParams(window.location.search)` 读 `popout` 参数；有 → `<PopoutShell/>`（按 kind 分发 QuickSendPanel / TerminalPopout）；无 → `<App/>`。
- `Popout/` 模块：`PopoutShell.tsx` / `QuickSendPanel.tsx` / `QuickSendList.tsx`（命令列表 + 行内编辑）/ `QuickSendText.tsx`（文本逐行，直接复用 `hooks/useSequentialSend`，旧 `usePanelCyclicSend` 已删）/ `TerminalPopout.tsx` / `usePopoutSync.ts`（跨窗同步）/ `usePanelTextConfig.ts`（面板文本配置）/ `usePortSerialFeed.ts`（终端弹窗 RX 喂入：快照交接 + 时间戳闸门）。

### 意图/事件协议（`usePopoutBridge` + `popoutEventService`）

| 事件 | 方向 | 载荷 | 用途 |
|---|---|---|---|
| `command-sets:changed` | 主窗 → 快捷发送窗 | **完整 `SendCommandSet[]`** | 命令集改动后弹窗直接 `setSets(载荷)`（曾是无载荷信号回库重读——未保存编辑只存在于主窗 store，弹窗读不到；改为主窗 store 是唯一真相） |
| `popout:command-set-updated` | 弹窗 → 主窗 | `{ set: SendCommandSet }`（整集） | 弹窗里改了命令集则**整集回传**，主窗写回 `useRuleStore` 活实体（弹窗本地不持有可写副本；主窗之后经 `command-sets:changed` 广播回所有弹窗） |
| `active-tab:changed` | 主窗 → 快捷发送窗 | `portId: string \| null` | 弹窗知道发送到哪个明确端口；无端口工具页为 `null`，不沿用旧目标 |
| `port-statuses:sync` | 主窗 → 弹窗 | 全部端口连接状态 | 对表时全量回放（实时增量走 `serial:status` 广播），弹窗在已连接状态下打开时提示灯即刻准确 |
| `serial:data` | 后端 → 所有窗 | 字节流 | 终端弹窗订阅（主窗与弹出窗各自模块单例） |
| `popout:terminal:request-snapshot` | 弹窗 → 主窗 | `portId` | 终端弹窗挂载时请求历史（request → reply，避免竞态） |
| `popout:terminal:snapshot` | 主窗 → 终端弹窗 | `{ portId, terminal }`（显示态 + 历史行，一次性） | 弹出时补历史（快照与现有实时行合并，不丢新行——曾 replaceAll 竞态丢行；弹窗照快照末行时间戳丢弃重复/更早的实时事件） |
| `popout:terminal:closed` | 后端 → 主窗 | `portId` | 弹窗销毁回贴：清除标签 detach 标记（见通用弹出管线） |
| `popout:open-config` | 弹窗 → 主窗 | `{page}` | 弹窗请求主窗打开 ConfigModal 指定页 |
| `popout:request-sync` | 弹窗 → 主窗 | 无 | 弹窗监听器**注册就绪后**请求对表，主窗回放 active-tab + command-sets + port-statuses |
| `ui-scale:changed` | 主窗 → 已打开弹窗 | `{percent}` | 设置保存成功后同步软件 UI 缩放；弹窗自己启动时先读 config.json 并缩放各自 WebView |

- 发送：弹窗直接 `invoke('send_data')` → 共享 AppState → 后端 emit serial:data → 主窗 useSerialReceive 自动写终端——**发送→回显链路天然跨窗口**。快捷发送弹窗经 `popout:send-command` → 主窗 `sendToPort(payload.portId ?? getActivePortId(state))`（显式端口优先；解析结果为空时不发送；TX echo/流量/历史仍按端口处理）。
- `usePopoutBridge` 全部 fire-and-forget emit 补 `.catch`（弹窗销毁时 rejection 不再 unhandled）。
- 主窗在 store 变更时广播 `command-sets:changed` / `active-tab:changed`；对表必须等监听器注册完成后再发 `popout:request-sync`，否则回放会早于监听器到达而丢失（指示器失真）。

### 耦合度判据（为何串口控制栏被排除弹出）

| 弹出对象 | 数据关系 | 耦合度 |
|---|---|---|
| 快捷发送 | 只**发**（走后端命令，天然跨窗口） | 低 |
| 终端标签 | 只**收**（订阅 serial:data 流 + 一次性历史快照） | 中（TTY 端口阻止弹出——独立 webview 不共享 ttyService/xterm 实例） |
| 串口控制栏 | **又读又写前端态**（端口列表同步 + 开标签/切焦点反映到主窗 useAppStore） | 高（排除） |

- `quickSendInlineCount` 默认 6（0 = 隐藏内联条，纯窗口模式）。
- 权限：capabilities 给弹出窗 label 授权（**漏配会导致弹窗内 invoke 静默失败**）。

## 操作面板与侧边栏

- OperationPanel 分区：`OperationPanel.tsx` + `SendSection.tsx` + `ParamsSection.tsx`（旧 `RulesSection.tsx` 已删——命令集选择+循环开关收进 SendSection 紧凑头部 `.op-send-header`，高亮下拉是死控件）。**组件定义在模块级**（父组件内定义子组件会因函数身份变化导致 DOM 销毁/输入失焦）。
- Resize：`OperationPanelResizeHandle.tsx`（共享 `useDragResize`，`mode:'delta'` + `invert`：hook 只报累计拖动位移，组件以拖拽起始高度加位移、clamp [160,600] 后写 `useSystemStore.ui.operationPanelHeight`，默认 280px；开始拖动同时展开折叠的面板）。
- 布局防线：`.op-section > * { flex-shrink: 0 }`（面板变矮时发送键不被压塌叠压）；`.op-section-params` `max-width: 300px` 封顶（宽窗口参数栏不挤占发送区）。
- Sidebar：`Sidebar.tsx` + `AliasDialog.tsx`；端口右键菜单分组控制（见 serial.md）。侧边栏宽度由 `App.tsx` 渲染的 `shared/SidebarResizeHandle.tsx` 调整（共享 `useDragResize`，clamp [200,400]，写 `useSystemStore.ui.sidebarWidth`）。
- 设置弹窗 ConfigModal 框选文字松手界外不关闭（issue #6-8）：overlay pointerdown 记录起点是否在弹窗内，click 时起点在弹窗内则忽略关闭。
- **UI 运行态与系统态都在 `useSystemStore`**（`src/stores/useSystemStore.ts`），`useAppStore` **不再持有** `systemStatus` / `trafficStats` / `simulationMode` / `ui.*`：`ui.*`（`sidebarWidth` / `sidebarCollapsed` / `operationPanelHeight` / `isConfigOpen` / `configActiveTab` / `configReady` 等）写入口是 `setUIState` / `toggleConfigModal` / `setConfigActiveTab`，流量回收是 `clearTrafficStats`。这些字段写点密集（5s 系统轮询、每端口 1s 流量 flush、拖拽 resize），与端口/标签数据分开后各自订阅面互不干扰。

## 通知中心 / toast

- `useToastStore` + `StatusBar/NotificationCenter.tsx`：宿主 `push` 的 `durationMs === 0` 为粘滞（Toast.tsx 跳过自动关闭计时）；可见栈最多 5 条，已接纳通知超出后进入 `stashed`，面板按 `createdAt` 倒序合并展示。`clearAll()` 清空两队列；铃铛 badge 上限 99+，外点 / Escape 关闭由共享 `useOutsideDismiss` 提供。
- `ToastItem.portId?`（issue #7-1）：串口来源消息（触发告警/断线/发送目标关闭/重连失败）携带串口号，通知行渲染 `.notify-row-port` chip + `.notify-row-time` HH:MM:SS 时间戳（`createdAt` push 时打点）。
- 插件通知必须经 `pushPlugin(pluginId, input)`，不能借宿主 `push` 绕过配额；`ToastItem.pluginId` 由宿主赋值，不接受插件伪造。插件速率、文本和积压上限见[开发指南](../plugin-development.md#限制与错误处理)；超额静默丢弃，不逐条生成错误通知。宿主/串口粘滞记录不因插件配额被移除。
- 面板几何以 `styles/notification-center.css` 的 `.notify-panel` 为准：宽 360px、最大高度 400px，不是固定高度。

## 状态栏

- `StatusBar.tsx`：端口连接计数、CPU、**应用进程树级内存**（`get_system_status`：本进程+全部后代进程含 WebView2/Chromium 子进程 RSS 之和——`collect_app_pids` 纯函数 + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`；CPU 仍系统级；`memory_used_mb`/`load_status` 纯函数可注入进程表单测）。
- 内存胶囊显示「JS堆 XMB · 进程 YMB」（`readJsHeapMb()` + `systemStatus.memoryUsedMb`），**无总预算分母**（旧的「双层内存预算」已删）；CPU 负载状态只看 CPU：`load_status` 在 `cpu > 90` 时才报 `high_load`，与内存无关。
- `systemStatus` / `trafficStats` 读自 `useSystemStore`（非 `useAppStore`）；`useSystemStatus` 5s 轮询；DisconnectBanner（`disconnectTracking.ts` 的 `isPortLost` 读会话级 `lostPortIds`；`filterLostTabIds` 在 `StatusBar/DisconnectBanner.tsx`；`lostPortIds` 只在「本会话 connect → 非用户触发的 disconnect」时打点，故会话恢复标签不会在启动时误报）。

## 共享交互原语（`src/components/shared/`）

三个交互此前在各处手写/复制，现各只有一份实现：

- `useOutsideDismiss(ref, onDismiss, active = true)`：外点（document mousedown）+ Escape 关闭浮层；ref 内按下不关（浮层自带的触发按钮才能继续 toggle）；`active` 门控使关闭态零监听开销。`ContextMenu` / `TextEditContextMenu` / `NotificationCenter` 共用。
- `useDragResize({axis, mode, min, max, invert, onChange, onDragStart})`：press → window mousemove → window mouseup 的拖拽生命周期（每次拖拽只挂一次监听、必拆；options 经 ref 读取，父级重渲染不重绑）。`mode:'absolute'` 报钳位后的指针坐标（左/下停靠面板的宽度/高度），`mode:'delta'` 报自拖拽起点的累计位移（分屏分隔条，几何归父级）。`ResizeHandle` / `OperationPanelResizeHandle` / `SidebarResizeHandle` 共用。
- `useMenuPlacement(x, y)`：菜单坐标计算 + 贴边溢出时翻转/夹紧，返回 `{ref, pos}`。`ContextMenu` 与 `TextEditContextMenu` 共用。

## 自定义文本右键菜单（issue #7-10）

- `TextEditContextMenu` + `useTextEditContextMenu()`：输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`contextMenu.*` i18n）；document 级拦截——可编辑目标 preventDefault + 弹菜单（右键时快照选区，点击项先 `focus({preventScroll:true})` + 恢复选区再 `document.execCommand`——mousedown 在菜单上会先 blur 目标丢掉选区），非可编辑目标一律 preventDefault。菜单定位与外点关闭走共享 `useMenuPlacement` / `useOutsideDismiss`。
- **必须在 App 根 + PopoutShell 各挂一次**（弹窗是独立 webview，旧 App.tsx effect 从未覆盖）。组件级 `onContextMenu`（stopPropagation 的终端行/侧边栏/标签页）不受影响。
