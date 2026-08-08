# PROJECT KNOWLEDGE BASE — HyperCom

**Generated:** 2026-08-06 · **Stack:** Tauri v2 (2.11.x) + React 18 + Rust (tokio + serialport)

## OVERVIEW

HyperCom — modern serial-port debug tool. Rust owns I/O; React owns UI. State in 4 Zustand stores; 12 hooks in individual files under `src/hooks/` own the Tauri bridge. Backend commands split into 10 domain files + `CommandError` enum. `paneTree: PaneNode` (recursive) replaced the flat `panes` array on 2026-07. Per-tab display state (scrollLocked/displayFormat/encoding/showTimestamp) lives in `useTerminalStore`, NOT in `useOperationStore`. Decorations disabled — custom TitleBar drives window controls. Cross-platform power management (Win32/macOS/Linux). Conditional trigger engine (pattern match → alert/auto-respond, per-port scoping via `portId`, wired in `useSerialReceive` — issue #3-1).

v0.4.1 (issue #6): 双层内存预算（`memoryLimitMb` 整个应用含 webview 总预算软兜底，默认 2048MB；`memoryPerPortBudgetMb` 每端口硬约束，默认 200MB，超限一次性裁到 50%）；`TerminalLine.rawData` 由 number[] 改 `Uint8Array`（内存 8 倍削减 + 免解码临时拷贝）；RX 管线写量限制（`maxLinesPerTick` 默认 2000）；`send_serial_data` 改 async + `tokio::task::spawn_blocking`（消除每次 TX 主线程卡顿与 tao 警告白屏），`AppState` 字段改 `Arc<Mutex<..>>`；状态栏内存为应用进程树 RSS（本进程 + 含 WebView2/Chromium 的后代进程）；端口排序改一次性动作 `sortPortsByNumber()`（移除持久 sortMode 开关）；串口右键菜单分组控制；QuickSendPanel 文本模式「执行当前行并移至下一行」按钮；ConfigModal 框选文字松手界外不再关闭；通知中心面板加大；快捷发送 pill 两行显示。

v0.4.2 (issue #6-10)：TX 读写句柄 try_clone 拆分（`SerialPortHandle` 拆为 read_port/write_port 双 `Arc<Mutex<..>>`，读线程独占读句柄、发送独占写句柄，TX 阻塞不再饿死 RX）；热路径摘除无界 `flush()`（Windows = FlushFileBuffers，无超时、受流控约束）+ `write_all_with_deadline` 总写期限（`WRITE_TOTAL_DEADLINE` 2s）；发送两段式（全局锁内只取写句柄克隆，锁外只持 per-port 写锁写，不再持全局 serial_manager 锁执行写）；前端 RX 管线 visibility-aware 排空（document.hidden 时 rAF 停摆 → setTimeout 兜底，visibilitychange 重排）+ 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）。

v0.4.3 (issue #7 UI 缺陷修复十项)：通知中心——`ToastItem` 新增可选 `portId`（触发告警/断线/发送目标关闭/重连失败均携带），通知行显示串口 chip + HH:MM:SS 时间戳；快捷发送条「打开命令面板」按钮改**按压按钮样式**（accent 填充 + 文字标签 `quickSend.openPanelShort`，min-height 34px 与两行药丸对齐）；发送提示前缀 `sendPrefix` 默认留空（功能保留，DisplaySettings 可配）；快捷发送面板目标串口下拉去掉 `· REAL/VIRTUAL` 后缀，底栏「发送到」提示灯跟随真实状态（订阅 `serial:status` + 新 `port-statuses:sync` 对表事件：绿=连接呼吸/灰=断开）；发送区命令集选择/循环/编辑三控件紧跟「发送命令」标题（去 `margin-left:auto`）；设置界面移除「串口参数预设」（操作面板参数区已有完整管理）；去「一键」文案；分组整组执行外部工具改 **Promise.all 并行**；新 `TextEditContextMenu`/`useTextEditContextMenu`——输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`document.execCommand` + 选区快照恢复），App 根 + PopoutShell 各挂一次，取代 App.tsx 旧 contextmenu effect。

v0.4.4 (issue #11 TTY 模式)：每端口新增 `mode: 'trx' | 'tty'`——TRX=既有行级终端（不变）；TTY=xterm.js（`@xterm/xterm` + `@xterm/addon-fit`）渲染的完整交互终端（真实 ANSI/VT100、光标、备用屏幕 vim/top、onData 尺寸协商，**无本地回显**由对端 echo），取代该端口的 TerminalView。切换在 OperationPanel→ParamsSection 分段控件（i18n `params.mode.*`），经 `port_meta`（config.json）持久化；`useSerialReceive` 按 `mode==='tty'` 分流字节直喂 `ttyService`（跳过触发引擎/协议解析/RxPipeline），断线走 `ttyService.disconnect`；`sendToPort` TTY 分支跳过 TX 回显与 flushNow（保留后端发送/流量统计/发送历史）。新增调试专用「模拟终端」GIT:BASH 虚拟串口（Cargo `portable-pty` 0.9，Windows = ConPTY，spawn 本地 git bash pty），门控与 SIM:Loopback 一致（前端 `import.meta.env.DEV`、后端 `cfg(not(debug_assertions))` 命令拒绝），侧边栏工具栏按钮（Terminal 图标，i18n `sidebar.toolbar.enableGitBashSim`/`disableGitBashSim`）。

## STRUCTURE

```
hypercom/
├── src/                          # React frontend
│   ├── main.tsx, App.tsx         # entrypoints (App.tsx owns AppInit + SerialReceive + global custom text-edit context menu)
│   ├── i18n.ts                   # i18next + react-i18next, ~529 keys × zh-CN/en-US
│   ├── services/tauri.ts         # invoke wrapper layer (6 service modules)
│   ├── hooks/                    # 12 hooks in individual files + barrel index.ts + disconnectTracking.ts
│   ├── stores/                   # 4 Zustand + Immer stores (no god store)
│   │   ├── useAppStore.ts        # tabs / ports / paneTree / config / groups + tree helpers
│   │   ├── useOperationStore.ts  # serial params + send (NO `op` prefix; NO display state fields)
│   │   ├── useTerminalStore.ts   # terminal buffer + appendTerminalLine + setTerminalEncoding
│   │   └── useRuleStore.ts       # highlight + send-command + trigger rule sets + CRUD
│   ├── utils/                    # highlightEngine / protocolParser / triggerEngine / hexUtils / rxAssembler / rxPipeline / diagLog / followLogic / sendStrip / textSend / sendGuard / configMerge / groupTool + their tests
│   ├── types/index.ts            # shared TS types
│   └── components/               # MainDisplay / ConfigModal / OperationPanel / Sidebar / TitleBar / StatusBar(含 NotificationCenter) / Popout / shared(含 GroupToolDialog)
├── src-tauri/src/                # Rust backend
│   ├── main.rs, lib.rs           # entrypoint + AppState + command registration + setup
│   ├── system.rs                 # cross-platform power mgmt (Win32 FFI / macOS caffeinate / Linux systemd-inhibit)
│   ├── diaglog.rs                # 应用自身诊断日志（全局 log::Log，落盘 + 轮转 + 读/清/追加）
│   ├── commands/                 # 10 domain files + mod.rs (CommandError enum + re-exports)
│   ├── serial/mod.rs             # serialport + SIM:Loopback virtual port (505 lines)
│   ├── logger/mod.rs             # BufWriter + rotation + path templating (501 lines)
│   └── config/mod.rs             # JSON config + 8 settings entity types + session.json + versioning + validation + path + backup
└── plans/                        # design docs (see "Key design reference" below)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add frontend state field | `src/stores/use{App,Operation,Terminal,Rule}Store.ts` | pick correct store only; god store is deprecated |
| Add Tauri command | `src-tauri/src/commands/<domain>.rs` + register in `lib.rs` | return `Result<T, CommandError>`, NOT `String` |
| Cross `.await` lock | extract + clone + drop the `MutexGuard` first | see pattern in `commands/log.rs` |
| Add serial hook | `src/hooks/<hookName>.ts` + export from `index.ts` | follow 12-hook lifecycle; do not revive `useSerialData`-style |
| 应用自身诊断日志 | `src-tauri/src/diaglog.rs` + `commands/diag.rs` + `src/utils/diagLog.ts` + `shared/DiagnosticLogDialog.tsx` | 后端 `log::*` + 前端 `console.*`（`setupDiagLogCapture` 拦截转发）统一落盘 `%APPDATA%/hypercom/diag/hypercom-debug.log`（512KB 轮转保留 3 份）；查看入口在「关于 → 诊断日志」，开关 `config.diagLogEnabled`（Rust 序列化名，前端线名已对齐，issue #5-2） |
| Split pane recursively | `useAppStore.splitPane` action via tree helpers | NO flat `state.panes` anywhere |
| Pane tree traversal | module-top exports in `useAppStore.ts` (`findLeafById` … `countLeaves`) | do not hand-roll tree walks |
| Highlight engine | `src/utils/highlightEngine.ts` + tests | state in `useRuleStore`, persisted via `storageService` |
| ConfigModal page edit | `src/components/ConfigModal/pages/*.tsx` | rule state in `useRuleStore`; persisted via config.json (`storageService` wraps config-backed commands) |
| Cyclic send | `src/components/OperationPanel/hooks/useCyclicSend.ts` | reads `useRuleStore.sendCommandSets` via `getState`; timing via per-command `delay` + set `loopDelay` only (no global interval) |
| 命令发送区 / 快捷发送条 / 命令面板 | `OperationPanel/SendSection.tsx` + `Popout/QuickSendPanel.tsx` + `hooks/useSerialSend.ts` | 快捷条 pill 两行显示（`.op-quick-cmd-name-row`：HEX 徽标+名称在上、`.op-quick-cmd-content` 内容在下，issue #6-9）、宽度自适应（ResizeObserver + `utils/sendStrip.ts` `computeFitCount`）、首槽固定「打开命令面板」按钮（`op-quick-panel-btn`：**accent 填充按压按钮** + 文字标签 `quickSend.openPanelShort`，min-height 34px 两行药丸高度，issue #7-2）；`quickSendInlineCount` 仅 0=隐藏条；QuickSendPanel 双模式（列表+行内编辑 / 文本逐行发送，`usePanelCyclicSend` 4 种运行方式，文本模式另含「执行当前行并移至下一行」`runCurrentLineAndAdvance`/`moveCursorToNextLine`，issue #6-3）；目标串口下拉只显示串口号（去 `· REAL/VIRTUAL` 后缀，issue #7-4）；底栏「发送到」提示灯跟随真实连接状态（订阅 `serial:status` + `port-statuses:sync` 对表：绿=连接呼吸/灰=断开，issue #7-5）；`sendToPort` 经 `utils/sendGuard.ts` 守卫未打开端口 |
| Cross-platform power | `src-tauri/src/system.rs` | Win32 `SetThreadExecutionState` / macOS `caffeinate` / Linux `systemd-inhibit` |
| Multi-encoding | backend `encoding_rs::GBK`, frontend `TextDecoder` + `setTerminalEncoding` | RX 切行/解码/批写统一走 `RxPipeline`（每端口按 label 缓存 decoder，`ignoreBOM:true`）；切换编码 live re-decode |
| RX 高频接收管线 | `src/utils/rxAssembler.ts` + `rxPipeline.ts` | 字节级行聚合（CR/LF/跨事件 CRLF/4KB 强制发射）+ rAF 批写 + 250ms 静默 flush（时间戳=最后事件时间）+ **写量限制** `maxLinesPerTick`（默认 2000：每端口每帧最多写 N 行超出顺延；`flushNow` 同步最多排空 N 行其余 rAF 续写，issue #6-2）+ **visibility-aware 排空**（issue #6-10）：document.hidden 时 rAF 停摆 → setTimeout 兜底 + visibilitychange 重排；每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）；`getRxPipeline()` 每 webview 一个单例，cleanup 不得 dispose |
| TTY 模式管线 | `src/utils/ttyService.ts` + `TtyView.tsx` | 每端口 `mode:'tty'` 的 RX/TX 服务单例（镜像 `getRxPipeline()` 模块单例）：`serial:data` 字节流式 UTF-8 解码（`TextDecoder('utf-8',{stream:true})` 缓冲跨事件多字节字符）→ 每端口队列 → visibility-aware 批写 `term.write`（页面可见 rAF、隐藏 setTimeout(16ms) 兜底）+ 队列上限 `MAX_TTY_QUEUE`（10000 丢最旧）；`attach`/`detach`/`feed`/`clear`/`disconnect`（断线 flush 保留 term 跨重连）/`send`（onData→send_serial_data，失败仅 console.error 不弹 toast）/`resize`（仅 GIT: 走后端 pty resize）；TX 刻意不经过 `sendToPort`（无本地回显） |
| TTY 视图 / 渲染分流 | `TtyView.tsx` + `Pane.tsx` | `Pane` 按 `displayPort?.mode === 'tty'` 渲染 `TtyView`（xterm + FitAddon，ResizeObserver + rAF 防抖 fit，onData→`ttyService.send`、onResize→`ttyService.resize`）否则 `TerminalView`；TTY 端口阻止弹出窗（`Pane.handlePopOut` 提示 `tty.popoutUnsupported`，弹出窗是独立 webview 不共享 ttyService/xterm 实例） |
| 模式开关（TRX/TTY） | `OperationPanel/ParamsSection.tsx` + `useAppStore.setPortMode` | 分段控件（`.segmented` 复刻 TerminalFilterBar HEX/Text）写 `port.mode`（经 `port_meta` 持久化）；切换副作用=清 TerminalStore + `getRxPipeline().flushAndReset` + `ttyService.clear`，避免旧模式 buffered 数据混入新模式首屏 |
| 内存预算 / 终端缓冲裁剪 | `useTerminalStore.ts` `totalBytes`/`maxBytes` + `config.memoryLimitMb`/`memoryPerPortBudgetMb` + `rxPipeline.ts` | `memoryLimitMb`=整个应用（含 webview）内存总预算软兜底（默认 2048MB）；`memoryPerPortBudgetMb`=每端口硬约束（默认 200MB，`maxLines = 预算×500`）；`appendTerminalLine(s)` 返回 boolean（true=触发裁剪），超预算**一次性裁到 50%**；「因内存限制清屏」toast（`toast.memoryTrim`，每端口 10s 节流）由 RxPipeline 接线层在 store 返回 true 时弹出（store 保持纯净，issue #6-2） |
| 日志保存子目录 / RX 日志行组装 | `logger/mod.rs` + `config/mod.rs` `log_subdir_mode` + `LogSettings.tsx` | `log_subdir_mode: 'none'|'date'|'port'`（默认 `date`，非法值 clamp 回 date）→ `create_writer_with_encoding` 路径 join（create_dir_all）+ `collect_log_files` 递归 list_files（MAX_LIST_DEPTH=16）；RX 日志经 `LogManager::write_rx` + `LogLineAssembler` 字节级组行（镜像前端 rxAssembler，250ms 陈旧尾 flush），不再按读取块一行（issue #5-9/10） |
| 滚动锁定 / 快捷跳转 | `TerminalView.tsx` + `utils/followLogic.ts` + `.terminal-jump-btn` | `scrollLocked` 仅由图钉按钮/跳转按钮/手势 settle 写入，**无 onScroll 隐式解锁**；跟随路径 `scrollToBottom` 走双 rAF 原始 `scrollTop = computePinTarget(scrollHeight, clientHeight)` 测量钉底（**不用** `virtualizer.scrollToIndex`——避免 @tanstack 10 次重试循环），settle/抑制/锁定迁移逻辑下沉纯函数 `isAtBottom`/`computePinTarget`/`becameLocked`/`shouldFollow`；到顶/搜索跳转这类用户一次性滚动才走 scrollToIndex；跳转按钮钉在滚动条两端（到顶解锁、到底锁定跟随） |
| DisconnectBanner | `src/components/StatusBar/DisconnectBanner.tsx` + `hooks/disconnectTracking.ts` `isPortLost`/`filterLostTabIds` | suppresses startup false alarm for session-restored tabs |
| Conditional triggers | `src/utils/triggerEngine.ts` + `useRuleStore.triggerRules` + `ConfigModal/pages/TriggerSettings.tsx` + `StatusBar/NotificationCenter.tsx` | pattern match (contains/exact/regex/hex) → alert/auto-respond; per-port via `portId` (empty=all); **wired in `useSerialReceive`** (issue #3-1); alert 是 sticky toast 显示 `rule.actionContent`（`durationMs:0` 不自动关闭，标题带端口/规则上下文）；规则 300ms 防抖逐条自动落盘（`savedSnapshotRef` diff，issue #5-3） |
| 通知中心 / toast | `src/stores/useToastStore.ts` + `src/components/StatusBar/NotificationCenter.tsx` | `durationMs === 0` = 粘滞（Toast.tsx 跳过自动关闭计时）；超过 `MAX_VISIBLE=5` 进 `stashed` 溢出队列不丢弃；`clearAll()` / `setCenterOpen` + `centerOpen`；铃铛+badge 挂 StatusBar `.statusbar-right`，外点/Escape 关闭，样式 `notification-center.css`；`ToastItem.portId?`（issue #7-1）——串口来源消息（触发告警/断线/发送目标关闭/重连失败）携带串口号，通知行显示 `.notify-row-port` chip + `.notify-row-time` HH:MM:SS 时间戳 |
| Add translation | `src/i18n.ts` | add key under `zh-CN` and `en-US`; don't translate protocol acronyms (None/Even/Xon/RTS/GBK/...) |
| Loopback virtual port | `useSimulation` hook + `commands/simulation.rs` | flask icon in sidebar toolbar |
| External tool (flasher) | `commands/serial.rs` `run_port_tool`/`kill_port_tool` + `useToolOutput` hook + `ToolSettings` page | close→spawn→stream→reopen 闭环；`{port}` 模板替换；配置在设置弹窗「外部工具」页；触发在侧边栏右键菜单 |
| 分组整组执行外部工具 | `Sidebar.tsx` 分组右键菜单 + `shared/GroupToolDialog.tsx` + `usePortToolActions.runToolForGroup` | 分组菜单 `sidebar.group.contextMenu.runTool` → 对话框列出配置/未配置端口（Cancel / Configure Missing 跳工具设置页 / Run Configured Only）；严格配置判定=配置存在+portId 匹配+`command.trim() !== ''`；`utils/groupTool.ts` `partitionGroupPorts` 纯函数；**`Promise.all` 并行**运行已配置端口（issue #7-9，跳过运行中端口，单端口失败不中断整组） |
| Resize operation panel | `src/components/shared/OperationPanelResizeHandle.tsx` + `ui.operationPanelHeight` | vertical drag handle between MainDisplay and OperationPanel; default 280px (issue #2-6), clamp [160,600] |
| 标签页批量开关串口 / 标签外部工具菜单 | `TabBar.tsx` 右键菜单 + `Pane.tsx` 接线 + `usePortToolActions` | 「打开/断开所有标签页」遍历全局 tabs 逐个 open/close（100ms 节流）；工具三入口与侧边栏同源（`usePortToolActions`），文案复用 `sidebar.port.contextMenu.*` key |
| 串口分组持久化 | `config/mod.rs` `port_groups` + `commands/storage.rs` `save_port_groups` + `useAppInit` | 分组是第 7 类 config 实体；启动经 `get_config` 恢复并回填 `ports.groupId`；groups 变更 500ms 防抖自动保存（无手动「保存布局」按钮） |
| 端口自然排序 | `src/utils/portSort.ts` + `useAppStore.sortPortsByNumber` | `naturalCompare` 数字段按数值比较（COM1<COM2<COM12）；排序是**一次性动作** `sortPortsByNumber()`（重排 ports + 各分组 portIds，幂等、不重置 groupId，issue #6-4），Sidebar 无持久 sortMode 开关，拖拽/分组始终可用；组内顺序随 `save_port_groups` 持久化、未分组顺序不保存；`mergePorts` 按 existing 顺序合并，轮询不冲掉顺序 |
| 串口右键菜单分组控制 | `Sidebar.tsx` + `useAppStore.ts` | 按端口分组态动态渲染菜单项（issue #6-5）：未分组且有组→逐组「移入分组『{{name}}』」；未分组无组→「新建分组并移入」；已在组里→「移出分组」；i18n keys `sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}` |
| 发送异步化 | `commands/serial.rs` `send_serial_data` + `lib.rs` `AppState` | `send_serial_data` 改 async fn + `tokio::task::spawn_blocking`（原同步命令在事件循环主线程执行 write_all+flush+日志写→每次 TX 卡顿 + tao `NewEvents`/`RedrawEventsCleared` 警告白屏，issue #6-1）；`AppState.serial_manager`/`log_manager` 改 `Arc<Mutex<..>>`（Deref 使 `.lock()` 调用点零改动）；`send_file` 本就是 async（tokio::fs::read + 分块 yield），无同类阻塞；**写路径读写句柄分离 + 无界 flush 摘除**（issue #6-10）：`SerialPortHandle` try_clone（Windows = DuplicateHandle）拆 read_port/write_port；热路径不再 `flush()`（FlushFileBuffers 无超时受流控约束）+ `write_all_with_deadline` 总写期限（2s）；两段式发送（全局锁内只取写句柄克隆，锁外只持 per-port 写锁写） |
| 模拟串口仅调试模式 | `src/utils/devMode.ts` + `commands/simulation.rs` | 前端 `DEV_FEATURES_ENABLED = import.meta.env.DEV` 隐藏全部 SIM UI；后端 release（`cfg(not(debug_assertions))`）命令直接报错；仅 `npm run tauri dev` 可用 |
| 模拟终端 git bash | `src-tauri/src/serial/tty_sim.rs` + `commands/tty_sim.rs` + `hooks/useGitBashSim.ts` | 调试专用 GIT:BASH 虚拟串口——portable-pty（Windows = ConPTY）spawn 本地 git bash pty，pty stdout→`serial:data`（RX）、`send_serial_data`→pty stdin（TX）；`find_bash`/`spawn_bash`/`TtySimPortHandle`（writer/master/child/读线程）；`SerialManager` `gitbash_sim`/`tty_sim_ports` 字段 + GIT: 路由（open_port/send_data/write_raw/close_port/resize_tty_sim）；**打开时携带前端 xterm 尺寸**（`OpenPortArgs.cols/rows`，spawn 即正确尺寸，否则 pty 固定 80×24 致 vim/top 全屏错乱）+ 连接后 `ttyService.resync` 保险；**读线程应答 DSR**（`\x1b[6n`→`\x1b[rows;colsR`，`scan_dsr` 跨 chunk 检测）——bash/readline 启动时阻塞等终端应答，TRX 模式无终端模拟器，后端不应答则命令全部不执行；TTY 模式由 xterm 自动应答，前端 TtyView 对 GIT: 端口过滤 xterm 应答防双响应；双层门控（前端 `import.meta.env.DEV` 隐藏 + 后端 `cfg(not(debug_assertions))` 命令拒绝，issue #11） |
| 终端搜索字符级高亮 | `terminalSearch.ts` `markSearchMatchesInHtml` | HTML tag/实体感知的 `<mark>` 叠加层，只在命中行应用；匹配计算仅搜索栏打开时进行 + `findMatchesIncremental` 前缀收窄 |
| First-run config creation | `config/mod.rs` `ConfigManager::new` | config.json created on first run with default `AppConfig` (empty entity arrays); no database |
| Config versioning / migration | `config/mod.rs` `migrate()` + `config_version` field | fresh schema (`config_version = 1`), forward-compatible, additive |
| Config path customization | CLI `--config` / `HYPERCOM_CONFIG` env / portable mode | resolution order in `ConfigManager::new` |
| Config validation | `config/mod.rs` `validate_and_clamp()` | runs on `set_config` to enforce bounds |
| Config backup / recovery | `config/mod.rs` `save()` writes `.bak` / `new()` falls back to `.bak` | corrupt JSON auto-recovered |
| Session snapshot update | `update_session_snapshot` dedicated command | writes separate `session.json` (not config.json); avoids full config save + `.bak` churn |
| 状态栏内存显示 | `commands/system_cmds.rs` `get_system_status` | **应用进程树级内存**：本进程+全部后代进程（含 WebView2/Chromium 子进程）RSS 之和（`collect_app_pids` 纯函数 + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`，issue #6-6）；CPU 仍系统级；`memory_used_mb`/`load_status` 纯函数（issue #5-5 / #6-6） |
| ConfigModal 框选不关闭 | `ConfigModal.tsx` | overlay pointerdown 记录起点是否在弹窗内，click 时起点在弹窗内则忽略关闭（框选文字松手界外不再误关，issue #6-8） |
| 通知中心面板 / 快捷发送 pill 样式 | `notification-center.css` + `operation-panel.css` | `.notify-panel` 320→360px 宽、340→400px 高（issue #6-7）；`.op-quick-cmd` flex column：`.op-quick-cmd-name-row`（HEX 徽标+名称）在上、`.op-quick-cmd-content` 在下（issue #6-9）；`.notify-row-port`/`.notify-row-time`（issue #7-1）；`.op-quick-panel-btn` accent 填充按压按钮 + `.op-quick-panel-btn-label`（issue #7-2） |
| 自定义文本右键菜单 | `src/components/shared/TextEditContextMenu.tsx` + `App.tsx` / `PopoutShell.tsx` | 输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`contextMenu.*` i18n）；`useTextEditContextMenu()` document 级拦截——可编辑目标 `preventDefault` + 弹自定义菜单（右键时快照选区，点击项先恢复焦点+选区再 `document.execCommand`），非可编辑目标一律 `preventDefault`（取代旧 App.tsx effect）；App 根 + PopoutShell 各挂一次；组件级 `onContextMenu`（stopPropagation 的终端行/侧边栏/标签页）不受影响 |
| 配置持久化审计（全量保存不丢实体） | `utils/configMerge.ts` `mergeLiveRuleEntities` + `ConfigModal.tsx` / `DiagnosticLogDialog.tsx` | store.config 实体数组是启动快照、从不跟随 `useRuleStore`——全量 `set_config` 前必须 `mergeLiveRuleEntities(config, useRuleStore.getState())` 合并 5 个活实体（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs）；`portPresets` 无 store 镜像（仅 store.config + 设置页本地态）；`portGroups`/`portMeta` 已由 useAppInit 同步（#4-10 模式，issue #5-2） |

## CODE MAP

Frontend (manual review; TypeScript LSP unavailable in this environment):

| Symbol | File | Type | Role |
|--------|------|------|------|
| `useAppStore` | `src/stores/useAppStore.ts:266` | Zustand store | tabs / ports / `paneTree` / config / groups + `sortPortsByNumber`（一次性自然序排序动作，issue #6-4） |
| `useOperationStore` | `src/stores/useOperationStore.ts:29` | Zustand store | serial params + send (NO `op` prefix; NO display state) |
| `useTerminalStore` | `src/stores/useTerminalStore.ts:22` | Zustand store | line buffer + `appendTerminalLine` (单行：TX/工具/回放) + `appendTerminalLines` (RX 批写) + `setTerminalEncoding` (re-decode on switch)；`totalBytes`/`maxBytes` 字节记账，两个 append 返回 boolean（true=触发内存裁剪，一次性裁到 50%） |
| `useRuleStore` | `src/stores/useRuleStore.ts:32` | Zustand store | highlight + send-command rule sets + CRUD |
| `findLeafById` / `findLeafByTabId` / `findParentBranch` / `findBranchById` / `collectLeaves` / `countLeaves` | `src/stores/useAppStore.ts:25-85` | pure fns | recursive `PaneNode` tree traversal |
| 12 hooks: `useSerialPorts` / `useSerialConnection` / `useSerialReceive` / `useSerialSend` / `useConfigPersistence` / `useSystemStatus` / `useAppInit` / `useSimulation` / `useGitBashSim` / `useToolOutput` / `usePopoutBridge` / `usePortToolActions` | `src/hooks/*.ts` + barrel `index.ts` | hooks | Tauri bridge — see `src/hooks/AGENTS.md`; RX → `RxPipeline` 批写（TTY 端口走 `ttyService.feed`），TX 回显前 `flushNow` 排空队列保时序；`useAppInit` 还负责分组/端口元数据（备注名/隐藏）恢复 + 防抖自动保存（issue #2-3 / #4-9/10）；`useGitBashSim` 是调试专用 GIT:BASH 模拟终端开关（issue #11，双层门控）；`usePortToolActions` 是侧边栏/标签页外部工具菜单的共享动作源（issue #2-2），现还返回 `runToolForGroup`（分组整组执行，issue #5-7） |
| `RxLineAssembler` / `RxPipeline` / `getRxPipeline` | `src/utils/rxAssembler.ts`, `src/utils/rxPipeline.ts` | RX 管线 | 字节级行聚合 + rAF 批写 + 静默/断线/编码切换 flush + `maxLinesPerTick` 写量限制 + 内存裁剪 toast 接线 + visibility-aware 调度（页面隐藏时 rAF 停摆 → setTimeout 兜底，visibilitychange 重排）+ 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧，issue #6-10）；主窗与弹出窗各自模块单例 |
| `ttyService` | `src/utils/ttyService.ts` | module singleton | TTY 模式 RX/TX 服务（issue #11）：流式 UTF-8 解码 + 每端口队列 + visibility-aware 批写 `term.write`；`attach`/`detach`/`feed`/`clear`/`disconnect`/`send`/`resize`；队列上限 `MAX_TTY_QUEUE`（10000 丢最旧）；TX 刻意不走 `sendToPort`（无本地回显） |
| `TtyView` | `src/components/MainDisplay/TtyView.tsx` | component | TTY 端口 xterm 宿主（issue #11）：Terminal + FitAddon fit（ResizeObserver + rAF 防抖）、onData→`ttyService.send`、onResize→`ttyService.resize`；Terminal 实例由本组件拥有，卸载时 dispose（`ttyService.detach` 不清实例） |
| `ReassemblerSegment` | `src/utils/protocolParser.ts` | type | `ProtocolFrameReassembler.feed()` 返回有序段数组（frame/raw 按流顺序），不再是 `{frames, flushedBytes}` |
| Pop-out intent bridge | `src/hooks/usePopoutBridge.ts` + `popoutEventService` in `src/services/tauri.ts` | pop-outs are separate webviews: exchange intents (`popout:send-command` / `popout:open-config` / `popout:request-sync`) + refresh signals (`command-sets:changed` / `active-tab:changed`), never shared mutable state; sends route through module-level `sendToPort` so TX echo/traffic/history work |
| `evaluateTriggers` | `src/utils/triggerEngine.ts` | pure fn | conditional trigger matching engine (contains/exact/regex/hex) |
| `tauri` service modules | `src/services/tauri.ts` | service | wrapped `invoke` calls (6 modules) |

Backend:

| Symbol | File | Type | Role |
|--------|------|------|------|
| `CommandError` | `src-tauri/src/commands/mod.rs:20` | enum (thiserror) | Serial/Config/Log/System/Lock/Io/Other; manual `serde::Serialize` |
| All Tauri commands (10 domain files) | `src-tauri/src/commands/*.rs` | Tauri cmd | see `src-tauri/src/commands/AGENTS.md` |
| `ConfigManager` + `AppConfig` | `src-tauri/src/config/mod.rs` | struct | holds all settings entities (8 Vec fields) + session.json + versioning + validation + path resolution + backup/recovery |
| `AppState` | `src-tauri/src/lib.rs` | struct | holds `serial_manager` / `logger` / `config_manager` behind `Arc<Mutex<..>>`（issue #6-1：Deref 使 `.lock()` 调用点零改动，`spawn_blocking` 闭包可持 'static 句柄） |
| `SerialPortHandle` | `src-tauri/src/serial/mod.rs` | struct | `read_port`（读线程独占，只锁读）/ `write_port`（发送路径独占，只锁写）双 `Arc<Mutex<Box<dyn SerialPort>>>` 句柄；`open_real_port` 内 DTR/RTS 设置（clone 前，设备级共享）后 `port.try_clone()`（Windows = DuplicateHandle）得写句柄、原句柄作读句柄——**不能对同一 COM 口二次 CreateFile**（crate 以 dwShareMode=0 打开）；`set_params`/`set_flow_control` 改在写句柄上（DCB/COMMTIMEOUTS 设备级、两句柄共享）；`get_write_handle` 全局锁内只做 HashMap 查找 + Arc 克隆（issue #6-10） |
| `win32_power` / `macos_power` / `linux_power` | `src-tauri/src/system.rs` | mod | cross-platform `prevent_sleep` / `prevent_screen_off` |
| `collect_app_pids` / `get_system_status` | `src-tauri/src/commands/system_cmds.rs` | fn / cmd | 应用进程树内存：本进程+后代进程（含 WebView2/Chromium 子进程）RSS 之和（`refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`）；CPU 仍系统级；纯函数可注入进程表便于单测（issue #6-6） |
| `TtySimPortHandle` / `find_bash` / `spawn_bash` | `src-tauri/src/serial/tty_sim.rs` | mod | git bash pty 模拟终端（issue #11，portable-pty 0.9，Windows = ConPTY）：writer（TX）/`master`（resize）/child（kill）/读线程（stdout→`serial:data`，退出发 disconnected）；`find_bash` 查 PATH + 常见 Git 安装路径；门控在命令层（release 拒绝） |
| `enable_gitbash_sim` / `disable_gitbash_sim` / `resize_gitbash_sim` | `src-tauri/src/commands/tty_sim.rs` | Tauri cmd | 调试专用（issue #11，`cfg(not(debug_assertions))` 命令直接报错）——启用/停用 GIT:BASH 虚拟端口、前端 xterm fit 后 `resize_tty_sim` 同步 pty 尺寸 |

Subdir guides: [`src/stores/AGENTS.md`](src/stores/AGENTS.md) · [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) · [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) · [`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md) · [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md) · [`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md)

---

## Detailed gotchas

## Build & verify

```bash
# Run the full app (frontend + backend)
npm run tauri dev

# TypeScript check only (fast, no Rust)
npx tsc --noEmit

# Rust check only (fast, skips codegen)
cargo check
# or full build:
cargo build

# Both must pass before committing.
# Run cargo commands inside src-tauri/:
cargo check --manifest-path src-tauri/Cargo.toml
```

On Windows PowerShell, `npm` may be blocked by execution policy — use:
```powershell
cmd /c "npm run tauri dev"
```

## Two-compiler project

- Frontend: React 18 + TypeScript + Vite (`src/`)
- Backend: Rust + Tauri v2 (`src-tauri/`)
- Tauri v2 uses ```invoke` for frontend→backend calls and `app.emit` for backend→frontend events
- `@tauri-apps/api` (npm) and `tauri` (Cargo) must be same minor version. Currently both **2.11.x**.

## Zustand: always use selectors

**Critical**: Calling any store without a selector subscribes to the ENTIRE store. Every serial data event will re-render that component, causing input focus loss and jank.

State is split across **4 Zustand stores**. Always pick the right store and subscribe with a selector.

### useAppStore — tabs, ports, panes, config, groups

```tsx
// WRONG — re-renders on every appendTerminalLine
const { ports, openTab } = useAppStore();

// CORRECT — only subscribes to specific fields
const ports = useAppStore(s => s.ports);
const openTab = useAppStore(s => s.openTab);
```

### useOperationStore — baudRate, dataBits, parity, stopBits, handshake, dtr, rts, sendInput, sendIsHex, sendAppendLineEnding, ...

Operation fields have **NO `op` prefix**. They were renamed from `opBaudRate` to `baudRate`, `opDataBits` to `dataBits`, etc.

**Note**: `sendOnEnter` and `quickSendInlineCount` do NOT live here. They are in `useAppStore.config` only. SendSection reads them via `useAppStore(s => s.config.sendOnEnter)` / `useAppStore(s => s.config.quickSendInlineCount)`. `quickSendInlineCount` 自 issue #5-4 起仅语义为 0=隐藏快捷条，>0 时可见条数宽度自适应（`computeFitCount`）。Display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) and `loopInterval` are also NOT here — they live per-tab in `useTerminalStore`. The cyclic-send repeat count (`loopRepeatCount`) is also NOT here — it moved to per-command-set `SendCommandSet.repeatCount` (config.json), read by `useCyclicSend` from the active set.

```tsx
const baudRate = useOperationStore(s => s.baudRate);
const sendInput = useOperationStore(s => s.sendInput);
const setOpState = useOperationStore(s => s.setOpState);
```

### useTerminalStore — terminals, appendTerminalLine, clearTerminal, setTerminalConfig, setTerminalEncoding, ensureTerminal

Hooks that need to write terminal lines without subscribing should use `getState()`:

```tsx
// Inside a hook callback (no re-render needed)
useTerminalStore.getState().appendTerminalLine(portId, line);

// In a component that renders terminal content
const terminals = useTerminalStore(s => s.terminals);
```

### useRuleStore — highlightRuleSets, sendCommandSets, triggerRules + CRUD

```tsx
const highlightRuleSets = useRuleStore(s => s.highlightRuleSets);
const activeHighlightSetId = useRuleStore(s => s.activeHighlightSetId);
const addHighlightRuleSet = useRuleStore(s => s.addHighlightRuleSet);
```

Use `useAppStore.getState()`, `useOperationStore.getState()`, `useTerminalStore.getState()`, or `useRuleStore.getState()` inside callbacks/effects when you need the latest value without subscribing.

## Components: define at module level

React components defined inside parent functions cause DOM destruction on every re-render because the function identity changes:

```tsx
// WRONG — input loses focus on every keystroke
const Parent = () => {
  const Child = (props) => <input ... />;  // new function every render
  return <Child />;
};

// CORRECT
const Child = (props) => <input ... />;
const Parent = () => <Child />;
```

## Flexbox scrolling: min-height:0 chain

For terminal scrolling to work, every flex ancestor in the column chain must have `min-height: 0`:

```
.pane-container-inner       (flex:1, flex column, min-height:0)
  └─ .terminal-view-container (flex:1, flex column, min-height:0)
       └─ .terminal-view       (flex:1, min-height:0, overflow-y:auto) ← scrolls
```

Without `min-height: 0`, flex children default to `min-height: auto` and won't shrink below content size.

## Rust: no MutexGuard across .await

`std::sync::MutexGuard` is `!Send`. Tauri async commands require the future to be `Send`. Always drop the lock before `.await`:

```rust
// WRONG
let mgr = state.serial_manager.lock().unwrap();
mgr.some_async_method().await;  // MutexGuard held across await

// CORRECT
let cfg = {
    let mgr = state.config_manager.lock().unwrap();
    mgr.get_config().clone()  // extract & clone, then drop MutexGuard
};
some_async_fn(&cfg).await;
```

## Port list polling: preserve state with mergePorts

`useSerialPorts(3000)` polls every 3s. `mapPortInfo()` always sets `status: 'disconnected'`. Use `mergePorts()` to preserve existing port state (status, alias, group, baud rate, etc.) when refreshing the list.

## Hooks: useSerialReceive vs useSerialSend

The old `useSerialData` hook was split into two hooks with different lifecycles:

- **`useSerialReceive()`** — Owns the serial data event listener lifecycle. Called **once** in `App.tsx`. Listens to `serial:data` events and feeds them into the **RX pipeline** (`getRxPipeline()`: byte-level line aggregation + rAF-batched `appendTerminalLines`); TTY 端口（`mode==='tty'`）字节**直喂 `ttyService.feed`**（跳过触发引擎/协议解析/行组装）；on `disconnected` it calls `pipeline.disconnect(portId)` (flush tail + drop per-port state) + `ttyService.disconnect(portId)` (flush queue but keep the xterm instance across reconnect). Holds NO store selector subscriptions. Never call this more than once.
- **`useSerialSend()`** — Returns a send action. Called in `OperationPanel`. Writes to the serial port and appends the sent line to the terminal via `useTerminalStore.getState().appendTerminalLine()`. The actual work lives in the **module-level exported `sendToPort(portId, data, isHex, lineEnding, silent?)`** (TX echo + traffic stats + in-memory history) so non-hook callers — the pop-out intent bridge — reuse the exact same pipeline instead of calling the backend directly. It drains the RX pipeline queue (`flushNow`) BEFORE the TX echo so batched RX can't overtake the send order. **TTY 分支**（`port.mode==='tty'`）跳过 TX 回显与 `flushNow`——无本地回显（对端 echo），仍走后端发送/流量统计/历史。

Both hooks write to the terminal store through `getState()` to avoid re-rendering the hook owner on every line.

The full hook set in `src/hooks/` (12 hooks, individual files):

| Hook | Purpose | Called in |
|------|---------|-----------|
| `useSerialPorts` | Polls port list every 3s | Sidebar |
| `useSerialConnection` | open/close port, routes through `closePort()` | Sidebar / TabBar |
| `useSerialReceive` | `serial:data` event listener → `RxPipeline` (byte-level line aggregation + rAF batch; TTY 端口字节直喂 `ttyService.feed`，跳过触发/协议/行组装) + status handler (`lostPortIds` for DisconnectBanner; 断线走 `pipeline.disconnect` + `ttyService.disconnect`) | App.tsx (once) |
| `useSerialSend` | Send action; `sendToPort` TTY 分支跳过 TX 回显 + `flushNow`（保留后端发送/流量统计/历史） | OperationPanel |
| `useConfigPersistence` | Load/save config to backend | App.tsx |
| `useSystemStatus` | Polls CPU/memory every 5s | StatusBar |
| `useAppInit` | One-shot app bootstrap | App.tsx |
| `useSimulation` | Toggle SIM:Loopback virtual port | Sidebar toolbar |
| `useGitBashSim` | Debug-only GIT:BASH 模拟终端 toggle (issue #11; mirrors `useSimulation` dev gating) | Sidebar toolbar |
| `useToolOutput` | `tool:output` / `tool:exit` event listeners | App.tsx (once) |
| `usePopoutBridge` | pop-out intent bus: `popout:send-command` → `sendToPort(activeTabId)`, `popout:open-config` → ConfigModal page, `popout:request-sync` → replay `active-tab:changed`; broadcasts `command-sets:changed` / `active-tab:changed` on store changes | App.tsx (once) |

## Rust backend: CommandError and commands/ split

All Tauri commands return `Result<T, CommandError>` instead of `Result<T, String>`. `CommandError` is a `thiserror` enum defined in `commands/mod.rs` with variants per domain:

```rust
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("Serial error: {0}")]
    Serial(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("Log error: {0}")]
    Log(String),
    #[error("System error: {0}")]
    System(String),
    #[error("Lock error: {0}")]
    Lock(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}
```

It implements `serde::Serialize` manually so the frontend receives the error string via `invoke`.

Commands are split into 10 domain files under `src-tauri/src/commands/`:

| File | Domain |
|------|--------|
| `serial.rs` | open_port, close_port, send_data, set_serial_params, set_flow_control, send_file, cancel_file_send, attempt_reconnect, run_port_tool, kill_port_tool（GIT: 路由走 send_data/write_raw，issue #11） |
| `simulation.rs` | enable_simulation, disable_simulation |
| `tty_sim.rs` | enable_gitbash_sim, disable_gitbash_sim, resize_gitbash_sim（模拟终端 git bash pty，调试专用，issue #11） |
| `config.rs` | get_config, set_config, reset_config, update_session_snapshot, get_session_snapshot, get_config_path |
| `diag.rs` | get_diag_log_path, read_diag_log, clear_diag_log, append_diag_log（应用自身诊断日志） |
| `log.rs` | start_logging, stop_logging, save_log_as, export_terminal_log, get_log_files, set_log_split_size, set_log_split_enabled, set_log_filename_format, set_log_auto_save, set_log_encoding, open_path, open_log_directory, migrate_log_directory |
| `storage.rs` | settings entities CRUD (command sets / highlight sets / protocol templates / trigger rules / port presets / tool configs) + save_port_groups + save_port_meta — synchronous ConfigManager operations on config.json |
| `file.rs` | write_text_file, read_text_file（配置导入导出） |
| `popout.rs` | open_popout, close_popout, set_popout_always_on_top |
| `system_cmds.rs` | get_system_status, prevent_sleep, prevent_screen_off |

`mod.rs` re-exports all commands and defines `CommandError`.

`src-tauri/src/system.rs` contains the `win32_power` module (Win32 `SetThreadExecutionState` FFI) used by `system_cmds.rs`. It was extracted from the old `commands/mod.rs` during the refactor.

## GBK decoding

GBK encoding uses `encoding_rs::GBK` on the Rust side. The old code returned U+FFFD placeholder characters for non-ASCII bytes. The frontend now receives proper UTF-8 from the backend and decodes with `TextDecoder` for other encodings.

## closeTab lifecycle

Closing a tab routes through `useSerialConnection.closePort()`, which calls `stopLogging` and updates the port status. Never bypass this by directly removing the tab from the store, or the log file handle leaks and the port status stays "connected".

## Commit conventions

```
type(scope): description

type: feat | fix | docs | style | refactor | perf | test | chore
scope: ui | backend | store | hooks | plans
```

## Key design reference

- `plans/04-data-flow.md` — 8 annotated data flow sequences
- `plans/08-defects.md` — active bug tracker
- `plans/09-release-workflow.md` — GitHub Actions release + updater workflow (tag-triggered build, RELEASE_NOTES.md unified notes, secrets, troubleshooting)

## Other gotchas

- `tauri.conf.json` has `"decorations": false` — custom TitleBar handles window controls via `@tauri-apps/api/window`
- `tsconfig.json` enforces `noUnusedLocals` and `noUnusedParameters` — unused vars are compile errors
- Serial data events carry `data: number[]` (bytes). Frontend decodes with `TextDecoder`. `TerminalLine.rawData` is a **`Uint8Array`** since issue #6-2 (8× memory cut + no temp copy on decode) — `TerminalRow`/`terminalSearch`/`protocolRenderer` must use `Array.from` instead of `.map` (Uint8Array has no `.map`); `setTerminalEncoding` decodes `rawData` directly without wrapping.
- **RX 管线（2026-08-04 重构）**：`serial:data` 事件不再「一事件一行」，而是进 `getRxPipeline()`（每 webview 一个模块单例）：`RxLineAssembler` 字节级切行（CR/LF/跨事件 CRLF/4KB 强制发射）→ 每端口队列 → rAF tick 每端口一次 `appendTerminalLines`（高频下把 store 更新压到每帧一次）→ 250ms 静默 flush 未终结尾部（时间戳取最后事件时间）。`sendToPort` 在 TX 回显前 `flushNow` 排空队列保收发时序；断线走 `pipeline.disconnect`；编码切换前必须 `flushAndReset`（旧编码冲刷尾部，`TerminalFilterBar` 已接线）。**不得**在 hook/弹窗 cleanup 里 `dispose()` 单例。`StreamingDecoderCache` 已删除。**visibility-aware 排空（issue #6-10）**：页面隐藏时 rAF 停摆——`defaultScheduleFlush` 在 rAF 可用且页面可见时走 rAF，否则（页面隐藏/无 rAF）走 setTimeout(cb, 16) 兜底；构造函数注册 `visibilitychange` 监听，变 hidden → 取消未触发的 rAF tick 并按当前调度器重排（自然落 setTimeout），变 visible → 同样重排回 rAF（更低延迟），dispose() 移除监听；`feedBytes`/`enqueueLines` 入队后 enforceQueueCap：队列超过 `maxQueuedLines`（默认 10000）splice 丢**最旧**，防隐藏窗口长时间积压无界。
- **滚动锁定（2026-08-04 重设计）**：`scrollLocked` 只由显式意图写入——图钉按钮、`.terminal-jump-btn` 跳转按钮（滚动条两端：到顶解锁、到底锁定并点亮）、手势 settle（滚轮/滚动键/滚动条拖拽/中键，120ms 静默后按 atBottom 50px 容差判定）。`TerminalView` **没有 onScroll 处理器**——程序化滚动/挂载/测量滞后/内容增长产生的 scroll 事件不再碰锁定状态。搜索栏打开时抑制跟随，关闭时若锁定则滚回最新。
- ConfigModal's rule/command editors save to config.json via `storageService` (which wraps config-backed commands). Load on mount via `useEffect`. Rule state lives in `useRuleStore`.
- **config.json is the single source of truth for ALL settings entities** (2026-08 migration: the SQLite layer was removed entirely). The 8 entity types (`SendCommandSetEntry`, `HighlightRuleSetEntry`, `ProtocolTemplateEntry`, `TriggerRuleEntry`, `PortPresetEntry`, `PortToolConfigEntry`, `PortGroupEntry`, `PortMetaEntry`, all `#[serde(rename_all = "camelCase")]`) live as 8 `Vec` fields on `AppConfig` (`send_command_sets`, `highlight_rule_sets`, `protocol_templates`, `trigger_rules`, `port_presets`, `port_tool_configs`, `port_groups`, `port_meta`). `commands/storage.rs` CRUD is synchronous: lock `config_manager` → mutate the Vec via `get_config_mut()` → `save()` writes config.json atomically (tmp + rename + `.bak`). `port_groups` is a whole-list replace (`save_port_groups`, issue #2-3) — groups auto-save via a 500ms-debounced store subscription in `useAppInit`; there is no manual «save layout» button. `port_meta`（备注名/隐藏状态）同款整体替换（`save_port_meta`, issue #4-9）。The session snapshot was split out into a separate `session.json` (next to config.json) via `load_session_snapshot()`/`save_session_snapshot()`; `update_session_snapshot` writes session.json and does NOT trigger a config `.bak`. `LogManager` is initialized FROM `ConfigManager` in `AppState::new()`, and `set_config`/`reset_config` auto-sync log settings via `sync_log_manager_from_config()` — the frontend no longer syncs log settings (`syncLogSettingsToBackend` deleted). Log line prefix format is configurable (issue #3-4): `log_include_timestamp` / `log_include_direction` (`#[serde(default = "default_true")]` — old config.json without them reads back as `true`) control whether `PortLogWriter::write_line` emits `[timestamp] ` / `RX|TX ` prefixes; both off → bare data line. They lock at `create_writer` time (like encoding) and sync via `sync_log_manager_from_config`. The dead `background_image` config field was removed entirely (issue #3-5).
- ConfigModal pages (GeneralSettings, LogSettings, DisplaySettings, BackupSettings) use **per-field selectors** instead of subscribing to the whole config — this prevents unnecessary re-renders when unrelated config fields change.
- SIM:Loopback virtual port is available when `enable_simulation` is called (flask icon in sidebar toolbar)
- CSS is split across `src/styles/` (10 component CSS files + `base.css`). `src/styles.css` is just an `@import` entry point, not the main stylesheet.
- `src/utils/hexUtils.ts` provides `hexToString` and `stringToHex` for HEX send/parse.
- ConfigModal split into 10 files: `ConfigModal.tsx`, `RuleSetAccordion.tsx`, `pages/` (6 settings pages), `editors/` (HighlightRuleEditor, SendCmdEditor).
- OperationPanel split into section components: `OperationPanel.tsx`, `SendSection.tsx`, `ParamsSection.tsx` (the old `RulesSection.tsx` was removed — its command-set select + loop toggle merged into `SendSection`'s compact header, its highlight dropdown was a dead control). The compose-row file button doubles as a **cancel** button while a transfer is in progress (`serialService.cancelFileSend` → backend `cancel_file_send`); the success toast is driven by the `serial:file_progress` `done` event (`sent>=total>0`), so cancel / empty clear the bar silently.
- Serial backend hardening (see `src-tauri/src/commands/AGENTS.md`): `send_file` is cancellable via `cancel_file_send` (per-port token in `AppState.file_send_cancel`) and always emits a terminal `done:true`; `run_port_tool` joins the read thread **outside** the global serial lock and reads tool streams by bytes (`read_until` + `from_utf8_lossy`); `serial/mod.rs` exposes `build_tx_bytes` as the single source of truth for transmitted bytes (used by `send_data` and the TX log); `open_port` guards stale handles and the SIM read thread emits `disconnected` on exit.
- Serial unit tests live in `serial/mod.rs::tests` with **explicit** imports — never `use super::*`: the glob drags the `serialport` FFI into the test binary and the Windows `cargo test` harness then fails to load with `0xc0000139` (no embedded app manifest, unlike the app binary). Tests that touch `serialport` types / `SerialManager` are `#[cfg(not(target_os = "windows"))]` and run on Linux/macOS CI; the FFI-free hex-parser / `build_tx_bytes` tests run everywhere.
- MainDisplay split into: `MainDisplay.tsx`, `Pane.tsx`, `TabBar.tsx`, `TerminalView.tsx`, `TerminalFilterBar.tsx`, `ResizeHandle.tsx`.
- Sidebar split into: `Sidebar.tsx`, `AliasDialog.tsx`.
- Per-tab display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) lives in `useTerminalStore`, NOT in `useOperationStore`. Display controls (TerminalFilterBar, encoding select) must write via `useTerminalStore.getState().setTerminalConfig(portId, ...)` or `setTerminalEncoding(portId, encoding)`. Never reintroduce global display fields in `useOperationStore`.
- `src/utils/sendUtils.ts` provides `textToHexPreview` / `hexToTextPreview` / `sanitizeHexInput` / `computeByteCount` / `parseHexBytes` / `getLineEndingBytes` / `LINE_ENDING_VALUES` / `lineEndingLabelKey` for HEX send/parse (pure, unit-tested). issue #5-6 起所有行结束符下拉统一从 `LINE_ENDING_VALUES` 取（见 JSX 转义 gotcha）。

- **JSX 属性字符串不转义（issue #5-6）**：`<option value="\r\n">` 里 `\r\n` 不会按转义处理，运行时值是 6 字符字面量 `\\r\\n`，与域值 4 字符 `\r\n` 不等 → `formatLineEndingHex`/`getLineEndingBytes` 落到默认分支，行尾提示/字节数/发送字节全错。行结束符选项必须用表达式字面量 `value={'\r\n'}`，label 走 `lineEndingLabelKey(v, ns)`。
- **发送守卫（issue #5-4）**：`sendToPort` 非静默发送前检查 `utils/sendGuard.ts` `isSendablePort`——端口缺失/断开/连接中/错误时推 `sendSection.portClosedWarning` toast 并返回 0；循环发送与触发自动回复的静默发送（`silent=true`）静默返回 0 不打扰用户。新增发送逻辑若绕过 `sendToPort` 直连后端，会失去该守卫与 TX 回显/历史管线。
- **config 实体快照陷阱（issue #5-2）**：`useAppStore.config` 的实体数组（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs/portPresets）是**启动快照**，不会自动跟随 `useRuleStore`。任何全量 `set_config`/`saveConfig` 前必须 `mergeLiveRuleEntities(config, useRuleStore.getState())` 合并活实体，否则用陈旧数据整体覆盖 config.json（曾清空用户编辑）。`portPresets` 无 store 镜像（仅 store.config + 设置页本地态）；`portGroups`/`portMeta` 由 useAppInit 防抖同步（#4-10 模式）。ConfigModal/DiagnosticLogDialog 已接线，新增全量保存点照抄。
- **滚动锁定跟随（issue #5-1）**：跟随路径 `scrollToBottom` 不再用 `virtualizer.scrollToIndex(count-1, align:'end')`（@tanstack 对未测量尾行走 10 次重试，刷 "Failed to scroll to index" 日志）——改双 rAF 原始 `scrollTop = computePinTarget(scrollHeight, clientHeight)` 测量钉底（gestureActiveRef 守卫），`countRef` 已删除；settle/抑制/锁定迁移判断全在 `utils/followLogic.ts` 纯函数；到顶/搜索跳转这类用户一次性滚动仍走 scrollToIndex。
- **通知中心（issue #5-3）**：`durationMs === 0` 的 toast 是粘滞的（Toast.tsx 不启动自动关闭计时）；超过 `MAX_VISIBLE=5` 的 toast 进 `stashed` 队列（不是丢弃），可经 NotificationCenter 查看/逐条关闭/清空。
- **触发规则自动持久化（issue #5-3）**：TriggerSettings 编辑触发规则 300ms 防抖逐条保存（`savedSnapshotRef` 与当前 rules diff），关闭弹窗时 flush 窗口内未保存编辑；新增/修改规则应走 `storageService.saveTriggerRule`，勿绕过。
- **日志 RX 组装与子目录（issue #5-9/10）**：`logger/mod.rs` 现含 `LogLineAssembler`（字节级 CR/LF/CRLF 合并/pendingCR/4096 强制 flush/take_tail，镜像前端 rxAssembler）+ `LogManager::write_rx`（RX 方向组行落盘，TX 保持直写 `write`）+ `subdir_mode`（`none`/`date`/`port`，默认 `date`，非法值 clamp 回 date，路径 join 处 create_dir_all，`collect_log_files` 递归 MAX_LIST_DEPTH=16）。改日志路径/分片/子目录相关代码要同时看这里，`LogManager` 现含 `write_rx`/`maybe_split_writer`/`periodic_flush` 私有助手。
- **状态栏内存（issue #5-5 → #6-6）**：`get_system_status` 的内存自 issue #6-6 起为**应用进程树级**——本进程+全部后代进程（含 WebView2/Chromium 子进程）RSS 之和（`collect_app_pids` + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`）。历史：issue #5-5 曾从单进程 RSS 改**系统级**（`system.refresh_memory()`），但系统级看不到软件自身占用、内存预算软兜底也无法工作；#6-6 再改回进程树级，以当前为准。CPU 仍系统级；`load_status` 阈值语义不变。
- **rawData / 内存瘦身（issue #6-2）**：`TerminalLine.rawData` 由 number[] 改 `Uint8Array`（内存 8 倍削减 + 免解码临时拷贝）；`setTerminalEncoding` 直接 `decoder.decode(rawData)` 不再包一层 Uint8Array；`TerminalRow`/`terminalSearch`/`protocolRenderer` 用 `Array.from` 逐字节（Uint8Array 无 `.map`）。TX 行 `txRawData` 同样存 Uint8Array。
- **双层内存预算（issue #6-2）**：`memoryLimitMb` 语义改为「整个应用（含 webview）内存总预算」默认 2048MB（**软兜底**）；新增 `memoryPerPortBudgetMb` 默认 200MB（**每端口硬约束**，`maxLines = 预算×500`）。Rust `AppConfig.memory_per_port_budget_mb`（`#[serde(default = "default_memory_per_port_budget_mb")]`，旧 config.json 缺省回退 200）+ `validate_and_clamp` [16,2048]；`memory_limit_mb` clamp [64,8192]。
- **裁剪触发（issue #6-2）**：`TerminalState` 新增 `totalBytes`（字节记账）与 `maxBytes`（每端口预算字节）；`appendTerminalLine`/`appendTerminalLines` 返回 boolean（true=触发内存裁剪）；超预算**一次性裁到 50%**（不再逐行 shift）；`clearTerminal`/`setTerminalLines` 重算 totalBytes。触发优先级：每端口硬约束优先、总预算软兜底（`systemStatus.memoryUsedMb` 应用进程级内存超总预算时也裁）。「因内存限制清屏」toast（`toast.memoryTrim`，每端口 10s 节流）由 **RxPipeline 接线层**在 store 返回 true 时弹出——store 保持纯净，避免 useToastStore→i18n→useAppStore 循环依赖。
- **RX 写量限制（issue #6-2）**：`maxLinesPerTick`（默认 2000）每端口每帧最多写 N 行，超出顺延下一帧；`flushNow` 同步最多排空 N 行，其余 rAF 续写（修 TX 卡顿同源根因）。
- **发送异步化（issue #6-1）**：`send_serial_data` 由同步命令改 async fn + `tokio::task::spawn_blocking`——原同步命令在事件循环主线程执行 write_all+flush+日志写，每次 TX 无条件卡顿 + tao `NewEvents`/`RedrawEventsCleared` 警告白屏。`AppState.serial_manager`/`log_manager` 改 `Arc<Mutex<..>>`（Deref 使 `.lock()` 调用点零改动）。`send_file` 本就是 async（tokio::fs::read + 分块 yield），无同类主线程阻塞。
- **TX/RX 读写句柄拆分 + 无界 flush 摘除（issue #6-10）**：此前「TX 后等一分钟才收到响应」的根因有二——① 读写共用同一把 per-port 锁，TX 的 write_all+flush 阻塞时读线程拿不到锁，响应到了 OS 接收缓冲也读不走、显示不出；② 热路径 `flush()`（Windows = FlushFileBuffers）无超时、受流控约束（对端 CTS 拉低/XOFF 时无界阻塞）。修复：`SerialPortHandle` try_clone（Windows = DuplicateHandle）拆 read_port/write_port 双句柄——**不能对同一 COM 口二次 CreateFile**（crate 以 dwShareMode=0 打开），try_clone 是唯一途径；读线程只锁读、发送只锁写，DCB/COMMTIMEOUTS 设备级、两句柄共享。热路径去 flush + `write_all_with_deadline` 总写期限（`pub const WRITE_TOTAL_DEADLINE: Duration = Duration::from_millis(2000)`，Ok(0) 立即报错、TimedOut 重试到总期限、Interrupted 继续，防长 payload 在驱动缓冲不空时以 ~100ms/次无限循环）。发送改**两段式**：全局锁内 `get_write_handle` 只做 HashMap 查找 + Arc 克隆（SIM 走 channel 发送）→ 释放全局锁 → 锁外只持 per-port 写锁调用 write_all_with_deadline——**不再持全局 serial_manager 锁执行写**，端口列表轮询/其它端口命令不被 TX 阻塞拖死。每次 WriteFile 受 WriteTotalTimeoutConstant（`.timeout(100ms)`）约束 ≈100ms，per-port 写锁单次持有上限 = 总期限 2s（极端场景），RX 最坏延迟从分钟级降为百毫秒级（且因读写锁分离，RX 根本不再被 TX 锁饿死）。`send_data`/`write_raw` 仍保留完整 API（SIM + 真实分支），真实分支同样去 flush + 用 write_all_with_deadline + write_port。
- **排序一次性动作（issue #6-4）**：新 store action `sortPortsByNumber()`（重排 ports + 各分组 portIds，自然序）；Sidebar **移除 sortMode 持久开关**，拖拽/分组始终可用。组内顺序随 `save_port_groups` 持久化、未分组顺序不保存。
- **串口右键菜单分组控制（issue #6-5）**：按端口分组态动态渲染——未分组且有组→逐组「移入分组『{{name}}』」；未分组无组→「新建分组并移入」；已在组里→「移出分组」。i18n keys `sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}`。
- **ConfigModal 框选不关闭（issue #6-8）**：overlay pointerdown 记录起点是否在弹窗内，click 时起点在弹窗内则忽略关闭——只响应按下+松开都在遮罩上的点击，框选文字松手界外不再误关弹窗。
- **快捷发送 pill 两行（issue #6-9）**：`.op-quick-cmd` 改 flex column：`.op-quick-cmd-name-row`（HEX 徽标+名称同行）在上、`.op-quick-cmd-content` 内容在下。
- **通知中心面板加大（issue #6-7）**：`.notify-panel` 320→360px 宽、340→400px 高。
- **通知中心串口上下文（issue #7-1）**：串口来源的 toast 必须带 `portId`（触发告警/断线/发送目标关闭/重连失败已接），通知中心据此渲染串口 chip；时间戳取 `createdAt`（push 时打点），不另行记录。非串口消息不设 portId。
- **自定义文本右键菜单（issue #7-10）**：`useTextEditContextMenu()` 取代 App.tsx 旧 contextmenu effect，**必须**在 App 根 + PopoutShell 各挂一次（弹窗是独立 webview，旧 effect 从未覆盖）。可编辑目标右键 → 自定义菜单（`document.execCommand` 执行，右键时快照选区、点击项先 `focus({preventScroll:true})` + 恢复选区再执行——mousedown 在菜单上会先 blur 目标丢掉选区）；组件级 `onContextMenu` 且 stopPropagation 的区域（终端行/侧边栏/标签页）不受影响。
- **发送提示前缀默认空（issue #7-3）**：`sendPrefix` 默认 `''`（TS `useAppStore.defaultConfig` + Rust `AppConfig::default` 两侧同步）；终端 TX 行已有方向标识，前缀只是可选的附加提示。
- **TTY 模式（issue #11）**：TTY 端口（`mode:'tty'`）由 xterm.js 渲染完整终端流——**无本地 TX 回显**（对端 shell 会 echo，本地再插一条 TX 行既重复又破坏终端流），`sendToPort` TTY 分支跳过 TX 回显 + `flushNow`（仍走后端发送/流量统计/历史，快捷发送/命令面板在 TTY 下可复用）；`useSerialReceive` 对 TTY 端口**跳过触发引擎/协议解析/RxPipeline 行组装**（字节流没有「行」语义，交给 xterm 的 ANSI/光标/备用屏幕）直喂 `ttyService.feed`；RX 解码**仅 UTF-8**（`TextDecoder('utf-8',{stream:true})`，无 GBK）——TRX 的多编码切换不适用于 TTY；**弹出窗不支持 TTY**（`Pane.handlePopOut` 阻止 detach 并提示 `tty.popoutUnsupported`，弹出窗是独立 webview 不共享 ttyService/xterm 实例）；**切换模式清空缓冲区**（`ParamsSection.handleModeChange` 清 TerminalStore + `flushAndReset` + `ttyService.clear`，避免旧模式 buffered 数据混入新模式首屏）；`ttyService` 队列上限 `MAX_TTY_QUEUE`（10000）超限丢最旧；`ttyService`/`getRxPipeline` 的 `dispose()`/`reset()` 仅测试用，应用生命周期不得调用（同款模块单例纪律）。

## Pane tree (2026-07 refactor)

`panes: SplitPane[]` 平铺数组已替换为 `paneTree: PaneNode`（单根递归树）。
```ts
type PaneNode = LeafPane | BranchPane;
interface LeafPane   { id: string; type: 'leaf';   tabIds: string[];    size: number; }
interface BranchPane { id: string; type: 'branch'; direction: SplitDirection; children: PaneNode[]; size: number; }
```

- `focusedPaneId` 引用树中的**叶子 id**（不再是扁平数组索引）
- 树辅助函数全部在 `src/stores/useAppStore.ts` 顶层 export：`findLeafById`、`findLeafByTabId`、`findParentBranch`、`findBranchById`、`collectLeaves`、`countLeaves`、`pruneTree`（私有）
- `pruneTree` 会自动：① 删除非根空叶子 → ② 折叠只有 1 个子节点的分支为该子节点（继承 size）→ ③ 根分支为空时退化为空叶 `'main'`
- `MainDisplay.tsx` 用 `renderNode(node, parentBranch)` 递归渲染；分支 flex 容器内 ResizeHandle 调用 `resizeChildren(branchId, childIndex, deltaFraction)` action
- `useTabDragEnd` 用 `findLeafByTabId` / `findLeafById` 树遍历，不要再用 `state.panes.find(...)`
- 新 splitPane：找焦点叶子 → 在父分支子数组里替换为含 [源叶(0.5), 新叶(0.5)] 的新分支；焦点叶是根时整树替换
- 测试断言：`state.paneTree.type === 'branch'` 后 `as BranchPane` 再断 `children` — 严禁再用 `state.panes[0]` / `state.panes.length`

## i18n (2026-07 基础设施)

- `src/i18n.ts` 已就位 — i18next + react-i18next，扁平 dotted key（`keySeparator: false`），250 keys × zh-CN/en-US

  > 2026-07-21 起新增 `general.configPath` key（通用设置页显示配置文件路径），UI/UX overhaul 批次后达 250 keys。
- `main.tsx` 第 5 行 `import './i18n'` 副作用初始化
- `useAppStore.subscribe((state) => ...)` 监听 `config.language` 变化 → `i18n.changeLanguage`
- 组件用：`import { useTranslation } from 'react-i18next'` + `const { t } = useTranslation()` + `{t('namespace.key')}` / `t('namespace.key', { var: value })`
- **类组件**（如 `App.tsx` 的 `AppErrorBoundary`）不能使用 hook，直接 `import i18n from './i18n'` 后 `i18n.t('key')` —— 但不会随语言切换重渲染（仅在错误边界这种边缘场景可接受）
- 不翻译的字符串：协议词汇 `None/Even/Odd/Mark/Space`、`Xon/Xoff`、`RTS/CTS`；编码名 `ASCII/UTF-8/GBK/ISO-8859-1`；单位 `ms/px/MB`；首字母缩写 `SIM/VCP/HEX/DTR/RTS` —— 这些在 i18n.ts 中也无对应 key
- ✅ 全部 30 个组件 `.tsx` 文件已接入 `t()`（2026-07-21 完成）— 新增组件文本必须先查 `src/i18n.ts` 现有 key，不够用则在 zh-CN 和 en-US 两侧同时新增 key
- issue #6 新增 key：`sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}`（串口右键分组）、`quickSend.runCurrentLineAdvance`（文本模式执行当前行并移至下一行）、`toast.memoryTrim`（内存裁剪提示，含 `{{port}}` 插值）
- 切换语言时全部界面实时切换，无硬编码中文残留
