# 符号与模块索引

> 由原根 `AGENTS.md` 的「新增/迁移的前端模块」与 CODE MAP 迁移而来，用于跨模块符号定位。逐目录文件清单见各子目录 `AGENTS.md`，模块行为细节见对应架构文档；新增代码优先复用下表中的模块实现，勿再造第二份。

## 前端模块索引（新代码优先复用）

| 模块 | 职责 |
|---|---|
| `utils/paneTree.ts` | `PaneNode` 树算法：`newPaneId` / `findLeafById` / `findLeafByTabId` / `findBranchById` / `findParentBranch` / `collectLeaves` / `countLeaves` / `pruneTree`。store 只留 action；`useAppStore` 另导出 `getClosingTabIds(tabId, scope)` 供批量关闭取与 store 关闭动作同一集合 |
| `utils/hexFormat.ts` | `hexByte` / `bytesToSpacedHex`——**bytes→HEX 的唯一实现**（terminalSearch / protocolRenderer / sendUtils / triggerEngine / TerminalRenderer 共用） |
| `utils/bounds.ts` | `CONFIG_BOUNDS` / `BoundedNumericSetting`——数值边界的前端镜像 |
| `utils/uiScale.ts` | `normalizeUiScalePercent` / `applyUiScale`——按当前 WebView 应用持久化 UI 缩放；调用 Tauri `getCurrentWebview().setZoom(percent / 100)` |
| `utils/sequential.ts` | `runSequential<T>`——串行发送/循环的通用次序原语 |
| `stores/useSystemStore.ts` | `systemStatus` / `trafficStats` / `simulationMode` / `ui` + `setSystemStatus` / `setTrafficStats` / `clearTrafficStats` / `setSimulationMode` / `setUIState` / `toggleConfigModal` / `setConfigActiveTab`——**从 `useAppStore` 拆出** |
| `stores/releaseTerminalState.ts` | `releaseUnusedPortState(portId)`：最后一个显示/行消费者退休后才回收 terminals / trafficStats / TX 历史；`releaseTerminalState` 委托同一守卫 |
| `ConfigModal/hooks/useEntityPage.ts` + `utils/entityEditor.ts` | 五类实体页共用会话草稿、新增/删除/启用/排序暂存、显式保存/放弃；挂载不回库覆盖，提交成功才发布 `useRuleStore` 运行态；单条保存保留其他草稿 |
| `OperationPanel/hooks/useSequentialSend.ts` | **循环发送两套状态机合一**（原弹窗侧与面板侧的分叉已消除） |
| `OperationPanel/hooks/{useHexCompose,useFileSend,useQuickStripLayout,useSendHistoryRecall}.ts` | HEX 组包 / 文件发送（守卫 + TX 统计）/ 快捷条宽度自适应（`utils/sendStrip.ts` `computeFitCount`）/ 发送历史回溯 |
| `shared/{useOutsideDismiss,useDragResize,menuPlacement}.ts` + `shared/PluginViewPicker.tsx` | 三个共享交互原语：外点关闭 / 拖拽调整尺寸 / 菜单定位；PluginViewPicker 统一插件视图自定义选择浮层（勿在各组件内手写第五份） |
| `Popout/{usePopoutSync,usePanelTextConfig,usePortSerialFeed}.ts` | 弹窗↔主窗同步（命令集/活动标签/端口状态事件总线）/ 面板文本配置 / 终端弹窗 RX 喂入（快照交接 + 时间戳闸门防重复） |
| `shared/usePluginViewOverlay.ts` + `utils/pluginViewOverlay.ts` | `usePluginViewOverlay` / `acquirePluginViewOverlay`：菜单等待原生矩形裁剪，未覆盖内容保持可见；模态层等待原生子视图隐藏后显示；不属于 `src/hooks/` 的 18 个 hook 文件 |
| `MainDisplay/SerialContentHost.tsx` + `utils/tabContentPlacement.ts` | 原始 TRX/TTY 实例由分屏树之外的稳定宿主拥有，按 workspace tab UUID 保持身份；切标签、跨分屏移动与插件替换只改变位置/可见性 |
| `utils/pluginViewRuntime.ts` / `pluginViewInput.ts` / `pluginViewJson.ts` | 原生视图会话、Worker/UI 状态 ACK、固定端口输入租约与有界 JSON；`services/pluginView.ts` 为四个原生命令及消息事件的 IPC 门面 |
| `shared/SortableEditorList.tsx` + `utils/commandOrder.ts` | 手柄专用指针/键盘拖排序，命令数组与连续 order 统一；行壳提供上下插入，搜索期间禁排 |
| `utils/editorLeave.ts` + `shared/EditorLeaveDialog.tsx` | 保存并关闭/放弃并关闭/继续编辑；保存失败及迟到编辑阻止关闭，主窗和命令面板均等待跨窗确认；原生关闭经 complete_editor_close 审批 |
| `utils/configWriteQueue.ts` + `jsonEqual.ts` | 配置/实体/元数据 CAS 写串行化；JSON 语义比较忽略对象字段顺序，避免 Rust 序列化产生假冲突 |
| `utils/textSend.ts` | 弹窗文本模式的纯函数：按 CRLF/LF 切行（裁尾部空行）、HEX 行合法性与间隔收敛，DOM-free 可单测 |
| `utils/logReplay.ts` | 日志解析（`ParsedLogLine` 允许未知时间，显式 UTC 偏移；不按相邻行 sleep） |
| `utils/timeline/{coordinator,scheduler,trxTimelineAdapter,ReplayClock}.ts` | app-lifetime 时间组、preview/commit 与代次、每目标最新槽背压、公平预算、TRX 适配与单调播放时钟 |
| `utils/terminal/{TerminalSource,TerminalTimeIndex}.ts` | 实时/回放共用只读行接口、按 `(time,seq)` 维护的可见时间索引 |
| `utils/replay/{ReplayDocument,replayRuntime}.ts` | 完整只读历史、轨道/分片与资源预算、宿主授权分块导入、共享组时钟及描述恢复 |
| `MainDisplay/TimelineControls.tsx` + `utils/terminalNavigation.ts` | 链条入口/成员/校时弹窗与显式导航生命周期；整组跟随复用 Pin，无额外组条；不把裸 scroll 当用户驾驶权 |
| `utils/sessionSnapshot.ts` | 会话快照解析/校验（`parseSessionSnapshot`：按可用端口过滤并重建 UUID），启动恢复用 |

## 前端符号

> 前端为人工维护的符号表（改动后同步本表）。

| Symbol | File | Type | Role |
|--------|------|------|------|
| `useAppStore` | `src/stores/useAppStore.ts` | Zustand store | tabs / ports / `paneTree` / config / groups + `sortPortsByNumber`；**不持有** systemStatus/trafficStats/simulationMode/ui（见 `useSystemStore`），无树算法（见 `utils/paneTree.ts`） |
| `getClosingTabIds` | `src/stores/useAppStore.ts` | pure fn | 批量关闭（toLeft/toRight/others）的标签集合，供 `Pane` 的 cleanup 与 store 关闭动作取同一集合 |
| `getTabPortId` / `getActivePortId` / `findSerialTabByPortId` | `src/stores/useAppStore.ts` | pure fns | 显式 workspace→端口解析；plugin 可绑定 null，无 last-port 回退；串口引擎始终按 portId 索引 |
| `useOperationStore` | `src/stores/useOperationStore.ts` | Zustand store | serial params + send (NO `op` prefix; NO display state); `cyclicLoops: Record<portId, boolean>` 每端口循环发送开关（`setCyclicLoop` 逐端口启停，替代旧全局 `isLoopSending`） |
| `useTerminalStore` | `src/stores/useTerminalStore.ts` | Zustand store | 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt）；`ensureTerminal` / `setTerminalConfig` / `setTerminalEncoding` / `setTerminalConnectedAt` / `releaseTerminal`；**无行数组、无 Immer**（行缓冲在 viewportManager 环形缓冲区） |
| `useRuleStore` | `src/stores/useRuleStore.ts` | Zustand store | 已保存的 highlight/protocol/command/tool/trigger 运行数组及活动命令集；表单不得直接修改运行态，使用 entityEditor |
| `useSystemStore` | `src/stores/useSystemStore.ts` | Zustand store | systemStatus / trafficStats / simulationMode / ui（+ `clearTrafficStats`） |
| `releaseUnusedPortState` / `releaseTerminalState` | `src/stores/releaseTerminalState.ts` | pure fns | 最后一份显示/行消费者释放后统一回收 terminals + trafficStats + TX 历史，保留其他插件租约的共享状态 |
| `paneTree` helpers | `src/utils/paneTree.ts` | pure fns | recursive `PaneNode` tree traversal（`findLeafById` / `findLeafByTabId` / `findParentBranch` / `findBranchById` / `collectLeaves` / `countLeaves` / `pruneTree` / `newPaneId`） |
| 18 hook files: 15 个既有 hook + `usePlugins` / `usePluginUi` / `usePluginPanel` | `src/hooks/*.ts` + barrel `index.ts` | hooks | 插件宿主在主窗 `usePluginHost` 一次装配；设置页 `usePluginList` 用后端权威状态；Sidebar/UI 面板用外部 store 订阅。串口与工具 hook 仍遵循原生命周期（详 `src/hooks/AGENTS.md`）。 |
| `RxLineAssembler` / `RxPipeline` / `getRxPipeline` | `src/utils/rxAssembler.ts`, `src/utils/rxPipeline.ts` | RX 管线 | 字节级行聚合 + rAF 批写（目标=viewportManager 环形缓冲区）+ 静默/断线/编码切换 flush + `maxLinesPerTick` 写量限制 + visibility-aware 调度 + 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）；主窗与弹出窗各自模块单例（裁剪是常态滚动，不弹通知） |
| `ttyService` | `src/utils/ttyService.ts` | module singleton | TTY 模式 RX/TX 服务：流式 UTF-8 解码（`lineText.createDecoder`）+ 每端口队列 + visibility-aware 批写 `term.write`；`attach`/`detach`/`feed`/`clear`/`disconnect`/`send`/`resize`；队列上限 `MAX_TTY_QUEUE`；TX 刻意不走 `sendToPort`（无本地回显） |
| `TtyView` | `src/components/MainDisplay/TtyView.tsx` | component | TTY 端口 xterm 宿主：Terminal + FitAddon fit（ResizeObserver + rAF 防抖）、onData→`ttyService.send`、onResize→`ttyService.resize`；`hidden` prop = 非活动标签（`.tty-view-hidden` display:none，恢复可见显式 re-fit，**会话跨标签保留**）；字体/字号经 `term.options` 活更新不重建；Ctrl+滚轮缩放；Terminal 实例由本组件拥有，卸载时 dispose（`ttyService.detach` 不清实例） |
| `ReassemblerSegment` | `src/utils/protocolParser.ts` | type | `ProtocolFrameReassembler.feed()` 返回有序段数组（frame/raw 按流顺序），不再是 `{frames, flushedBytes}` |
| Pop-out intent bridge | `hooks/usePopoutBridge.ts` + `services/popout.ts` | hook/service | separate WebViews exchange versioned editor requests/snapshot/ACKs and committed broadcasts; pending client text participates in app-exit guard; serial sends reuse sendToPort |
| `evaluateTriggers` | `src/utils/triggerEngine.ts` | pure fn | conditional trigger matching engine (contains/exact/regex/hex) |
| `hexFormat` | `src/utils/hexFormat.ts` | pure fns | `hexByte` / `bytesToSpacedHex`——bytes→HEX 唯一实现 |
| `lineText` | `src/utils/lineText.ts` | pure fns | 全仓唯一 TextDecoder 工厂（`createDecoder` 缓存 / `decodeBytes` / `getLineText`，`ignoreBOM: false`） |
| `CONFIG_BOUNDS` | `src/utils/bounds.ts` | const | 数值边界（镜像 Rust；由 `bounds.test.ts` 断言） |
| `normalizeUiScalePercent` / `applyUiScale` | `src/utils/uiScale.ts` | runtime | 80–200% 收敛 / Tauri `getCurrentWebview().setZoom(percent / 100)`；每个 WebView 独立应用 |
| `runSequential` | `src/utils/sequential.ts` | pure fn | 串行执行原语（循环发送/批量开关） |
| `pluginHost` / `pluginObserver` / `pluginBytesObserver` / `pluginKv` | `src/utils/plugin*.ts` | runtime | Worker 调用时权限、RX 行/字节有界旁路、逐插件 KV 串行落盘（详 `docs/architecture/plugins.md`） |
| `tauri` service modules | `src/services/tauri.ts` (barrel) + `src/services/*.ts` | service | 14 个非测试文件（13 域 + barrel）；插件域 `plugin.ts`、原生视图域 `pluginView.ts` |

## 后端符号

| Symbol | File | Type | Role |
|--------|------|------|------|
| `CommandError` | `src-tauri/src/commands/mod.rs` | enum (thiserror) | Serial/Config/Log/System/Lock/Io/Other; manual `serde::Serialize` |
| All Tauri commands (13 domain files, 89 registered) | `src-tauri/src/commands/*.rs` | Tauri cmd | see `src-tauri/src/commands/AGENTS.md` |
| `ConfigManager` + `AppConfig` + `Entities` | `src-tauri/src/config/mod.rs` | struct | 44 字段 = 43 个普通配置字段 + flatten entities；9 类实体数组含 pluginConfigs。普通字段含 defaultBaudRates 数组，不统称标量；插件安装身份迁移/磁盘恢复先于 Worker 启动 |
| `AppState` | `src-tauri/src/lib.rs` | struct | `serial_manager: Arc<Mutex<..>>`、`config_manager: Mutex<..>`、`plugin_io: tokio::sync::Mutex<()>`（插件磁盘/状态操作互斥）、`log_manager: Arc<LogManager>`、`diag_logger: Arc<..>`、`system_info: Arc<Mutex<..>>`、`tool_processes`/`file_send_cancel`/`popouts` |
| `SerialPortHandle` | `src-tauri/src/serial/ports_real.rs` | struct | `read_port`（读线程独占，只锁读）/ `write_port`（发送路径独占，只锁写）双 `Arc<Mutex<Box<dyn SerialPort>>>` 句柄；`open_real_port` 内 DTR/RTS 设置（clone 前，设备级共享）后 `port.try_clone()`（Windows = DuplicateHandle）得写句柄、原句柄作读句柄——**不能对同一 COM 口二次 CreateFile**（crate 以 dwShareMode=0 打开）；`set_params`/`set_flow_control` 改在写句柄上（DCB/COMMTIMEOUTS 设备级、两句柄共享） |
| `PortKind` / `check_virtual_enabled` | `src-tauri/src/serial/mod.rs` | enum / fn | 端口类别唯一分派 + 虚拟端口分派前门控 |
| `win32_backend` / `child_process_backend` | `src-tauri/src/system.rs` | mod | 电源管理的两个平台后端（共享状态机骨架）；**没有** `win32_power`/`macos_power`/`linux_power` 模块名 |
| `dev_only` / `is_debug_build` | `src-tauri/src/commands/system_cmds.rs` | fn | **调试能力门控唯一实现**；命令体不得再写 `#[cfg(debug_assertions)]` 双主体 |
| `collect_app_pids` / `get_system_status` | `src-tauri/src/commands/system_cmds.rs` | fn / cmd | 应用进程树内存：本进程+后代进程（含 WebView2/Chromium 子进程）RSS 之和；CPU 仍系统级；纯函数可注入进程表便于单测 |
| `LogSettings::from_config` | `src-tauri/src/logger/settings.rs` | fn | 日志设置的唯一构造入口 |
| `LogManager::apply_settings` | `src-tauri/src/logger/manager.rs` | fn | 日志设置的唯一应用入口（旧逐字段 setter / `sync_log_manager_from_config` 已删） |
| `LogLineAssembler` | `src-tauri/src/logger/assembler.rs` | struct | 字节级 CR/LF/CRLF 组行 + pendingCR + 4096 强制 flush + 250ms 陈旧尾 flush（`just_forced` 语义与前端 `rxAssembler` 一致） |
| `TtySimPortHandle` / `find_bash` / `spawn_bash` | `src-tauri/src/serial/tty_sim.rs` | mod | git bash pty 模拟终端（portable-pty 0.9，Windows = ConPTY）：writer（TX）/`master`（resize）/child（kill）/读线程（stdout→`serial:data`，退出发 disconnected）；`find_bash` 查 PATH + 常见 Git 安装路径 |
| `enable_gitbash_sim` / `disable_gitbash_sim` / `resize_gitbash_sim` | `src-tauri/src/commands/tty_sim.rs` | Tauri cmd | 调试专用（`dev_only()` / `is_debug_build()` 门控）——启用/停用 GIT:BASH 虚拟端口、前端 xterm fit 后同步 pty 尺寸 |
| `plugin/view_runtime` 模块 | `src-tauri/src/plugin/view_runtime/{mod.rs,resources.rs,windows.rs,sdk.js}` | mod | `mod.rs` 原生视图身份/授权/生命周期；`resources.rs` 声明资产快照（`MAX_FILE_BYTES` 8 MiB / `MAX_TOTAL_BYTES` 32 MiB）；`windows.rs` raw Wry 子控件（仅 Windows）；`sdk.js` 注入视图的插件 SDK |

## 组件目录拆分（侧边栏）

`src/components/Sidebar/`：`Sidebar.tsx`、`AliasDialog.tsx`、`GroupItem.tsx`、`GuideCard.tsx`、`SearchBox.tsx`、`SidebarActions.tsx`、`SidebarToolbar.tsx`、`SortablePortItem.tsx`、`pluginIcon.tsx`、`groupActions.ts`、`hooks/usePortDragEnd.ts`。其余组件目录（MainDisplay / ConfigModal / OperationPanel）的逐文件清单一律见各自子目录 `AGENTS.md`。

命令的完整清单与每域职责见 [`src-tauri/src/commands/AGENTS.md`](../../src-tauri/src/commands/AGENTS.md)；hook 清单见 [`src/hooks/AGENTS.md`](../../src/hooks/AGENTS.md)；终端引擎细节见 [`src/utils/terminal/AGENTS.md`](../../src/utils/terminal/AGENTS.md)。
