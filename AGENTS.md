# PROJECT KNOWLEDGE BASE — HyperCom

**Generated:** 2026-08-06 · **Stack:** Tauri v2 (2.11.x) + React 18 + Rust (tokio + serialport)

## OVERVIEW

HyperCom — modern serial-port debug tool. Rust owns I/O; React owns UI. State in 4 Zustand stores; 15 hooks in individual files under `src/hooks/` own the Tauri bridge. Backend commands split into 11 domain files + `CommandError` enum. `paneTree: PaneNode` (recursive) replaced the flat `panes` array on 2026-07. Per-tab display state (scrollLocked/displayFormat/encoding/showTimestamp) lives in `useTerminalStore`, NOT in `useOperationStore`. Decorations disabled — custom TitleBar drives window controls. Cross-platform power management (Win32/macOS/Linux). Conditional trigger engine (pattern match → alert/auto-respond, per-port scoping via `portId`, wired in `useSerialReceive` — issue #3-1).

v0.4.1 (issue #6): 双层内存预算（`memoryLimitMb` 整个应用含 webview 总预算软兜底，默认 2048MB；`memoryPerPortBudgetMb` 每端口硬约束，默认 200MB，超限一次性裁到 50%）；`TerminalLine.rawData` 由 number[] 改 `Uint8Array`（内存 8 倍削减 + 免解码临时拷贝）；RX 管线写量限制（`maxLinesPerTick` 默认 2000）；`send_serial_data` 改 async + `tokio::task::spawn_blocking`（消除每次 TX 主线程卡顿与 tao 警告白屏），`AppState` 字段改 `Arc<Mutex<..>>`；状态栏内存为应用进程树 RSS（本进程 + 含 WebView2/Chromium 的后代进程）；端口排序改一次性动作 `sortPortsByNumber()`（移除持久 sortMode 开关）；串口右键菜单分组控制；QuickSendPanel 文本模式「执行当前行并移至下一行」按钮；ConfigModal 框选文字松手界外不再关闭；通知中心面板加大；快捷发送 pill 两行显示。

v0.4.2 (issue #6-10)：TX 读写句柄 try_clone 拆分（`SerialPortHandle` 拆为 read_port/write_port 双 `Arc<Mutex<..>>`，读线程独占读句柄、发送独占写句柄，TX 阻塞不再饿死 RX）；热路径摘除无界 `flush()`（Windows = FlushFileBuffers，无超时、受流控约束）+ `write_all_with_deadline` 总写期限（`WRITE_TOTAL_DEADLINE` 2s）；发送两段式（全局锁内只取写句柄克隆，锁外只持 per-port 写锁写，不再持全局 serial_manager 锁执行写）；前端 RX 管线 visibility-aware 排空（document.hidden 时 rAF 停摆 → setTimeout 兜底，visibilitychange 重排）+ 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）。

v0.4.3 (issue #7 UI 缺陷修复十项)：通知中心——`ToastItem` 新增可选 `portId`（触发告警/断线/发送目标关闭/重连失败均携带），通知行显示串口 chip + HH:MM:SS 时间戳；快捷发送条「打开命令面板」按钮改**按压按钮样式**（accent 填充 + 文字标签 `quickSend.openPanelShort`，min-height 34px 与两行药丸对齐）；发送提示前缀 `sendPrefix` 默认留空（功能保留，DisplaySettings 可配）；快捷发送面板目标串口下拉去掉 `· REAL/VIRTUAL` 后缀，底栏「发送到」提示灯跟随真实状态（订阅 `serial:status` + 新 `port-statuses:sync` 对表事件：绿=连接呼吸/灰=断开）；发送区命令集选择/循环/编辑三控件紧跟「发送命令」标题（去 `margin-left:auto`）；设置界面移除「串口参数预设」（操作面板参数区已有完整管理）；去「一键」文案；分组整组执行外部工具改 **Promise.all 并行**；新 `TextEditContextMenu`/`useTextEditContextMenu`——输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`document.execCommand` + 选区快照恢复），App 根 + PopoutShell 各挂一次，取代 App.tsx 旧 contextmenu effect。

v0.5.0 (issue #11 TTY 模式)：每端口新增 `mode: 'trx' | 'tty'`——TRX=既有行级终端（不变）；TTY=xterm.js（`@xterm/xterm` + `@xterm/addon-fit`）渲染的完整交互终端（真实 ANSI/VT100、光标、备用屏幕 vim/top、onData 尺寸协商，**无本地回显**由对端 echo），取代该端口的 TerminalView。切换在 OperationPanel→ParamsSection 分段控件（i18n `params.mode.*`），经 `port_meta`（config.json）持久化；`useSerialReceive` 按 `mode==='tty'` 分流字节直喂 `ttyService`（跳过触发引擎/协议解析/RxPipeline），断线走 `ttyService.disconnect`；`sendToPort` TTY 分支跳过 TX 回显与 flushNow（保留后端发送/流量统计/发送历史）。**TTY 标签在 Pane 内常驻挂载**（非活动标签 `.tty-view-hidden` display:none 隐藏，恢复可见自动 re-fit），**会话跨标签切换保留**——仅模式切换/关闭标签/跨 Pane 拖拽销毁实例（xterm `open()` 只能调用一次）。字体/字号经 `term.options` 活更新不重建 Terminal。新增调试专用「模拟终端」GIT:BASH 虚拟串口（Cargo `portable-pty` 0.9，Windows = ConPTY，spawn 本地 git bash pty），门控与 SIM:Loopback 一致（前端 `import.meta.env.DEV`、后端 `cfg(not(debug_assertions))` 命令拒绝），侧边栏工具栏按钮（Terminal 图标，i18n `sidebar.toolbar.enableGitBashSim`/`disableGitBashSim`）。

v0.5.3+ (issue #12 自动更新)：**通道是运行时用户选择**（设置项 `updateCheckMode: 'none'|'stable'|'preview'`，config.json 持久化，默认 stable；About 手动检查可选正式版/preview，不过 DEV 门控）。由于 JS `check()` 无法运行时指定 endpoint，更新链路由新 `commands/update.rs` 承载（`check_for_update`/`download_and_install_update` + `update:progress` 事件，`cfg(not(debug_assertions))` 门控返回 Ok(None)）——stable 直连 `releases/latest/download/latest.json`（GitHub 原生「最新非 prerelease」指针，永不泄漏 preview）；preview 先经 GitHub API（`api.github.com/releases?per_page=100`，含 prerelease）解析**版本号最大**的 `vX.Y.Z-preview.N` tag（纯函数 `find_latest_preview_tag`；复审：API 按创建时间序，取数值四元组最大而非第一个命中）再指向 `releases/download/<tag>/latest.json`（唯一 tag、preview→preview 自升级；未认证 API 限流 60/h/IP 超限静默降级）。前端 `useAutoUpdate`（等 `ui.configReady` 信号后评估——复审替代旧 3s 启发式窗口，config 加载慢于 3s 会按默认模式误判）：7 天周期 + `shouldAutoCheck` 纯函数（首启立即、snooze 暂停、成功检查才记 lastCheckAt（完成时刻）—— localStorage 记账）；发现更新 → `UpdateDialog` 三动作（立即更新带进度/7 天后提醒写 snooze/永不提醒同步 `updateCheckMode=none`）。版本号约定：稳定 `0.x.y`、preview `0.x.y-preview.N`（属于下一核心，同核心 preview<stable 晋升自洽）。发布：`.github/workflows/publish-preview.yml`（tag `v*-preview*`，唯一 tag + `prerelease:true` + `releaseDraft:false`）与 publish.yml（同过滤器 `!v*-preview*` 否定排除）双流，两流均显式 `updaterJsonPreferNsis: true`（latest.json Windows 块指向 NSIS——tauri-action 默认 false 会指 MSI，偏离验收路径，复审修复）；capabilities 加 `process:default`（relaunch 必需；首轮曾加 `updater:default`，复审移除——更新链路全走 Rust 命令，JS updater IPC 零使用，npm 包 `@tauri-apps/plugin-updater` 一并卸载）；新增 `@tauri-apps/plugin-process`/`tauri-plugin-process`/`reqwest 0.13(rustls)+url` 依赖。评估/周期/snooze 纯逻辑注入测试用 `enabledOverride` 参数（vitest 中 import.meta.env.DEV 被静态替换为 true，无法 stubEnv）。复审加固：安装命令带 `expectedVersion` 安装前重检查版本比对（防「展示 X 装 Y」TOCTOU）；未知 channel 报错（不静默回退 stable）；GitHub API 15s 超时；模式变更清账副作用（clearSnooze+clearLastCheck——lastCheckAt 不分通道，旧通道周期会推迟新通道首检）挪到 ConfigModal 保存边界（旧在 radio onChange，取消时副作用泄漏）；下载中遮罩点击不可关闭弹窗；`channel.ts` 死代码 `detectChannel`/`isPreviewVersion` 删除（仅存 `channelLabelKey`）。二轮增强（2026-08-16，方案级补漏）：preview 通道语义改 **max(preview, stable)**——`check_for_update("preview")` 双检查取 semver 大者（纯函数 `newer_channel`/`version_key`；preview 解析失败降级 stable），preview 用户收尾后自动晋升 stable、热修不缺，`payload.channel` 反映更新实际来源；会话内 6h 周期重评估（常驻挂机覆盖）；改通道保存后立即首检（`runAutoCheck`）+ 设置页显示「上次自动检查」；changelog 轻量 Markdown 渲染（`utils/changelog.ts`，非 dangerouslySetInnerHTML）；弹窗「查看发布页」链接（`releaseUrl`，tag 约定 `v<version>`）；`shouldAutoCheck` 时钟回拨防护；发版 CI 三重护栏（tsc+vitest+cargo test 质量门、RELEASE_NOTES 章节↔版本校验、`verify-release` latest.json 四平台键 gate）；macOS 自动更新声明暂不支持（未签名/公证，产物可手动安装）；密钥轮换/坏版本召回 SOP 见 `docs/architecture/release.md`。详 `docs/architecture/update.md`。

v0.5.2 (issue #13 自定义背景图·全应用毛玻璃)：**四个新配置项**（`backgroundImage` 路径/'未设置'、`backgroundImageEnabled` 默认关、`backgroundImageOpacity` 0–100% 默认 50、`backgroundImageBlur` 0–64px 默认 0；Rust `AppConfig` serde 缺省回退 + `validate_and_clamp` 夹取 + TS 接口/`defaultConfig`/configMerge.test fixture 四侧同步）。**图片加载不走 asset protocol**（老 v1 实现裸 `url("C:\...")` 在硬化 webview 载不动，issue #3-5 因而删除）——新命令 `read_image_data_url`（`commands/file.rs`，`base64` crate）读文件为 `data:image/<mime>;base64,` data URL（dev/prod 一致），20MB 上限 + 扩展名白名单（png/jpg/jpeg/bmp/webp/gif/svg，纯函数 `image_mime_from_ext`）+ 文件缺失/超限静默 `Ok("")` + `log::warn!` 降级。**呈现**：`App.tsx` 首子元素 `<div class="app-background">`（fixed + `z-index:-1` 垫底）经 `ThemeProvider` 映射 CSS 变量（`--app-bg-image/-opacity/-blur` + `html[data-app-bg="on"]` 门控，异步读图带 cancelled 防竞态）；`styles/background.css` 在启用时把**全部 `--bg-*` 表面 token 换半透明 rgba**（终端区最深 0.72、浮层 0.90 保可读）实现全窗毛玻璃，并摘除 `.app-root` 自身底色防双重着色；亮/暗主题两套 alpha 值。**xterm 主题背景创建时快照**（TtyView 初始 `cssVar('--bg-primary')`）——切玻璃开关需活更新：TtyView 新 effect 按 config + `data-theme` 构造 rgba 写入 `term.options.theme`（不读 CSS 变量，避免与 ThemeProvider 父 effect 时序竞态）。设置 UI 在「显示与交互」页新增「背景图」区段（启用勾选 → 只读路径 + 浏览按钮（dialog 插件 png/jpg/jpeg/bmp/webp/gif 过滤器）→ 不透明度/模糊度 number input + `clampNumber`），i18n `displaySettings.background.*` 7 键双语。已知边界：弹出窗（独立 webview）不共享背景层。

v0.6.3 (issue #10/#11/#12)：**① 缓冲裁剪 DOM 泄漏修复**（#10 输出区上下抖动根因）——head trim 前进 firstSeq 后 active 行 visIdx 字段停留在旧窗口值，stale 检查按字段判定永不回收 → DOM 行数无限增长（e2e 实测 6669 vs 正常 27）→ 每帧 O(n) 渲染 → 帧率暴跌抖动。修复：stale 判定改用**实时列表位置** `seqToVisIdx`（identity O(1)、过滤模式二分），越界即回收，DOM 恒 ≤ 窗口+overscan。**② 关闭标签页不再关闭串口**（#11）——`Pane.cleanupClosedTab` 移除 `closePort`（端口/日志保持连接），改 `getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` 清前端管线；`appendTerminalLines/appendTerminalLine/replaceTerminalLines` 语义改「manager 存在才写入」、无标签页时静默丢弃（重开标签页从零开始新一轮输出，后端 RX 日志独立落盘不受影响）；`ttyService.feed` 对「无标签页且未 attach」丢弃（挂载前首帧仍入队等 attach replay）。**③ 拖选滚动黑块修复**（#12）——拖选冻结期间允许物化**新**行（acquire+归位+写内容，新行不在活选区 Range 内安全），仅冻结已有行保护选区锚点。e2e 新增 3 例（#11 关标签 keep 连接+重开从零、#10 trim 期 DOM ≤40+scrollTop 单调、#12 拖选滚动视口行有内容）。

前端整理（2026-08-26，全仓审计后的一次性清理，无版本号变更）：**死代码删除**——`useRuleStore.activeHighlightSetId`/`activeProtocolTemplateId` 及 setter（全仓零生产消费，RulesSection 移除后遗留）+ `useConfigPersistence.resetAndReload`（零消费）+ `logService.setLogDirectory`（零消费，后端命令保留）+ `useSerialReceive.setupPromiseRef`（死 ref）+ `hasViewportManager` 导出 + i18n 12 个零引用 key（550 键/侧）；**重复实现合并**——`clampNumber` 5 份页内拷贝 → `utils/clampNumber.ts` 单一实现；`performance.memory` 读取两份 → `utils/jsHeap.ts`（readJsHeapBytes/Mb）；`usePanelCyclicSend.onProgress` 回调删除（消费者传空函数，本身是死参数）；**异步时序修复**——① 重连循环每轮开头检查 `userClosingPortIds`，用户主动关闭后不再悄悄重开（P0；**不能**看 port.status——后端先发 disconnected 再发 reconnect_hint，attempt=0 时 store 已是 disconnected，会误杀整个循环）；② `runAutoCheck` 模块级 in-flight 锁，改通道首检与 6h 周期并发不再双弹窗/双记账；③ `usePopoutBridge` 全部 fire-and-forget emit 补 `.catch`（弹窗销毁时 rejection 不再 unhandled）；④ `TerminalPopout` 快照 replaceAll 竞态——缓冲已有实时行时改为「快照历史 + 现有行」合并，不丢新行；⑤ `rxPipeline.feedBytes` 不加 tab 存在性门控——弹出窗 store 从不填充 `tabs`（TerminalPopout 只 setConfig），门控会丢光弹窗实时流；对已 release 的 manager 喂数据本就是静默 no-op（有界）；⑥ `openPort`/`closePort` 加 per-port in-flight 守卫，同一事件循环连点不再并发 open 同一句柄；⑦ ThemeProvider 背景图 effect 拆分——opacity/blur 只改 CSS 变量，不再反复读盘；⑧ 触发 respond 失败补 debug 日志；**性能**——OperationPanel/ParamsSection/SendSection 的 `ports.find(...)`/整包 `config` 新引用选择器拆为原语选择器（3s 轮询不再整树重渲染）；**文档**——AGENTS.md/hooks/ConfigModal/MainDisplay 计数断言全部对齐实际（15 hooks / 11 域文件 / 16 CSS / 9 pages / 550 i18n 键），MainDisplay AGENTS.md 移除已删的 TerminalRow.tsx 幽灵条目与 react-virtual 描述。

## STRUCTURE

## STRUCTURE

```
hypercom/
├── src/                          # React frontend
│   ├── main.tsx, App.tsx         # entrypoints (App.tsx owns AppInit + SerialReceive + global custom text-edit context menu)
│   ├── i18n.ts                   # i18next + react-i18next, ~550 keys × zh-CN/en-US
│   ├── services/tauri.ts         # invoke wrapper layer (service modules)
│   ├── hooks/                    # 15 hooks in individual files + barrel index.ts + disconnectTracking.ts
│   ├── stores/                   # 4 Zustand stores (no god store; useTerminalStore 已去 Immer)
│   │   ├── useAppStore.ts        # tabs / ports / paneTree / config / groups + tree helpers
│   │   ├── useOperationStore.ts  # serial params + send (NO `op` prefix; NO display state fields)
│   │   ├── useTerminalStore.ts   # 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt；行缓冲在 utils/terminal）
│   │   └── useRuleStore.ts       # highlight + send-command + trigger rule sets + CRUD
│   ├── utils/                    # highlightEngine / protocolParser / triggerEngine / hexUtils / rxAssembler / rxPipeline / diagLog / followLogic / sendStrip / textSend / sendGuard / configMerge / groupTool + their tests
│   ├── utils/terminal/           # 方案B 终端引擎：TerminalBuffer / TerminalRenderer / viewportManager + tests（见子目录 AGENTS.md）
│   ├── types/index.ts            # shared TS types
│   └── components/               # MainDisplay / ConfigModal / OperationPanel / Sidebar / TitleBar / StatusBar(含 NotificationCenter) / Popout / shared(含 GroupToolDialog)
├── src-tauri/src/                # Rust backend
│   ├── main.rs, lib.rs           # entrypoint + AppState + command registration + setup
│   ├── system.rs                 # cross-platform power mgmt (Win32 FFI / macOS caffeinate / Linux systemd-inhibit)
│   ├── diaglog.rs                # 应用自身诊断日志（全局 log::Log，落盘 + 轮转 + 读/清/追加）
│   ├── commands/                 # 11 domain files + mod.rs (CommandError enum + re-exports)
│   ├── serial/mod.rs             # serialport + SIM:Loopback virtual port + GIT:BASH 路由 + TX 编码/写期限 (1639 lines)
│   ├── logger/mod.rs             # PortLogWriter + LogLineAssembler + 解码/净化/分片/文件枚举 (2032 lines)
│   └── config/mod.rs             # JSON config + 8 settings entity types + session.json + versioning + validation + path + backup
└── docs/                        # design & architecture docs (see "Key design reference" below)
    ├── architecture/            # 按功能模块划分的架构文档（README 索引 + serial/terminal/tty/transmission/logging/config/workspace/update/release/errors）
    └── userwiki/                # 面向普通用户的说明文件（暂空）
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
| 自定义背景图（issue #13） | `ThemeProvider.tsx`（CSS var + `data-app-bg` 门控）/ `styles/background.css`（毛玻璃 token 覆盖）/ `commands/file.rs` `read_image_data_url`（data URL） | 配置四字段存 config.json（`backgroundImage`/`backgroundImageEnabled`/`backgroundImageOpacity`/`backgroundImageBlur`）；路径经后端读为 base64 data URL（不走 asset protocol）；`html[data-app-bg="on"]` 时 `--bg-*` token 换半透明 rgba 实现全窗毛玻璃；xterm 背景在 TtyView 内按 config 活更新 |
| Multi-encoding | backend `encoding_rs::GBK`, frontend `TextDecoder` + `setTerminalEncoding` | RX 切行/解码/批写统一走 `RxPipeline`（每端口按 label 缓存 decoder，`ignoreBOM:true`）；切换编码 live re-decode |
| RX 高频接收管线 | `src/utils/rxAssembler.ts` + `rxPipeline.ts` | 字节级行聚合（CR/LF/跨事件 CRLF/4KB 强制发射）+ rAF 批写 + 250ms 静默 flush（时间戳=最后事件时间）+ **写量限制** `maxLinesPerTick`（默认 2000：每端口每帧最多写 N 行超出顺延；`flushNow` 同步最多排空 N 行其余 rAF 续写，issue #6-2）+ **visibility-aware 排空**（issue #6-10）：document.hidden 时 rAF 停摆 → setTimeout 兜底 + visibilitychange 重排；每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）；`getRxPipeline()` 每 webview 一个单例，cleanup 不得 dispose |
| TTY 模式管线 | `src/utils/ttyService.ts` + `TtyView.tsx` | 每端口 `mode:'tty'` 的 RX/TX 服务单例（镜像 `getRxPipeline()` 模块单例）：`serial:data` 字节流式 UTF-8 解码（`TextDecoder('utf-8',{stream:true})` 缓冲跨事件多字节字符）→ 每端口队列 → visibility-aware 批写 `term.write`（页面可见 rAF、隐藏 setTimeout(16ms) 兜底）+ 队列上限 `MAX_TTY_QUEUE`（10000 丢最旧）；`attach`/`detach`/`feed`/`clear`/`disconnect`（断线 flush 保留 term 跨重连）/`send`（onData→send_serial_data，失败仅 console.error 不弹 toast）/`resize`（仅 GIT: 走后端 pty resize）；TX 刻意不经过 `sendToPort`（无本地回显） |
| TTY 视图 / 渲染分流 | `TtyView.tsx` + `Pane.tsx` | `Pane` 对当前 Pane 内**所有 TTY 标签常驻挂载** TtyView（xterm + FitAddon，ResizeObserver + rAF 防抖 fit，onData→`ttyService.send`、onResize→`ttyService.resize`），非活动标签传 `hidden` → `.tty-view-hidden`（display:none），恢复可见显式 re-fit——**会话跨标签切换保留**；TRX 标签照旧只在展示时挂载 TerminalView；`displayPort?.mode !== 'tty'` 才渲染 TerminalView；TTY 端口阻止弹出窗（`Pane.handlePopOut` 提示 `tty.popoutUnsupported`，弹出窗是独立 webview 不共享 ttyService/xterm 实例） |
| 模式开关（TRX/TTY） | `OperationPanel/ParamsSection.tsx` + `useAppStore.setPortMode` | 分段控件（`.segmented` 复刻 TerminalFilterBar HEX/Text）写 `port.mode`（经 `port_meta` 持久化）；切换副作用=清 TerminalStore + `getRxPipeline().flushAndReset` + `ttyService.clear`，避免旧模式 buffered 数据混入新模式首屏 |
| 内存上限 / 终端缓冲裁剪 | `utils/terminal/TerminalBuffer.ts` + `viewportManager.ts` + `config.maxDisplayLines` + `rxPipeline.ts` | `maxDisplayLines`=每端口终端最大显示行数（默认 100000，clamp [1000,1000000]）；缓冲超限**逐行覆盖最旧**（滚动窗口）；无字节预算/软兜底/内存裁剪 toast（issue #16 改版）。前端默认值 `defaultConfig.maxDisplayLines: 100000` 与 Rust `default_max_display_lines` 100000 两侧同步 |
|日志保存子目录 / RX 日志行组装|`logger/mod.rs` + `config/mod.rs` `log_subdir_mode` + `LogSettings.tsx`|`log_subdir_mode: 'none'|'date'|'port'`（默认 `date`，非法值 clamp 回 date）→ `create_writer_with_encoding` 路径 join（create_dir_all）+ `collect_log_files` 递归 list_files（MAX_LIST_DEPTH=16）；RX 日志经 `LogManager::write_rx` + `LogLineAssembler` 字节级组行（镜像前端 rxAssembler，250ms 陈旧尾 flush），不再按读取块一行（issue #5-9/10）|
|每次打开串口新建日志文件|`logger/mod.rs` `new_file_per_session` + `config/mod.rs` `log_new_file_per_session` + `LogSettings.tsx`|`logNewFilePerSession`（默认关，保持续写行为）开启后：每次 `create_writer`（打开串口/重连）经 `open_new_log_file` 用 `create_new(true)` 原子分配**不存在**的文件（同名冲突 `name-1.log`/`name-2.log`… 后缀，数字插扩展名前），绝不续写；**split 续片经 `create_split_writer` 强制唯一化（与开关无关）**——粗粒度模板（`[com]`/`[com]-[date]`）下 append 重开刚关闭的超阈值文件会令 current_size 从超阈值初始化、每写必分片（死循环）。同步点：`lib.rs` AppState::new + `commands/config.rs` `sync_log_manager_from_config`|
| 滚动锁定 / 快捷跳转 | `TerminalView.tsx` + `utils/followLogic.ts` + `.terminal-jump-btn` | `scrollLocked` 仅由图钉按钮/跳转按钮/手势 settle 写入，**无 onScroll 隐式解锁**；跟随路径由 `TerminalRenderer` **同帧钉底**（render() 内 scrollTop = totalHeight - clientHeight，无 React effect、无双 rAF 链；搜索栏打开时 followEnabled=false 抑制），settle/抑制/锁定迁移逻辑下沉纯函数 `isAtBottom`/`computePinTarget`/`becameLocked`/`shouldFollow`；到顶/搜索跳转这类用户一次性滚动才走 scrollToIndex；跳转按钮钉在滚动条两端（到顶解锁、到底锁定跟随） |
| DisconnectBanner | `src/components/StatusBar/DisconnectBanner.tsx` + `hooks/disconnectTracking.ts` `isPortLost`/`filterLostTabIds` | suppresses startup false alarm for session-restored tabs |
| Conditional triggers | `src/utils/triggerEngine.ts` + `useRuleStore.triggerRules` + `ConfigModal/pages/TriggerSettings.tsx` + `StatusBar/NotificationCenter.tsx` | pattern match (contains/exact/regex/hex) → alert/auto-respond; per-port via `portId` (empty=all); **wired in `useSerialReceive`** (issue #3-1); alert 是 sticky toast 显示 `rule.actionContent`（`durationMs:0` 不自动关闭，标题带端口/规则上下文）；规则 300ms 防抖逐条自动落盘（`savedSnapshotRef` diff，issue #5-3） |
| 通知中心 / toast | `src/stores/useToastStore.ts` + `src/components/StatusBar/NotificationCenter.tsx` | `durationMs === 0` = 粘滞（Toast.tsx 跳过自动关闭计时）；超过 `MAX_VISIBLE=5` 进 `stashed` 溢出队列不丢弃；`clearAll()` / `setCenterOpen` + `centerOpen`；铃铛+badge 挂 StatusBar `.statusbar-right`，外点/Escape 关闭，样式 `notification-center.css`；`ToastItem.portId?`（issue #7-1）——串口来源消息（触发告警/断线/发送目标关闭/重连失败）携带串口号，通知行显示 `.notify-row-port` chip + `.notify-row-time` HH:MM:SS 时间戳 |
| Add translation | `src/i18n.ts` | add key under `zh-CN` and `en-US`; don't translate protocol acronyms (None/Even/Xon/RTS/GBK/...) |
| Loopback virtual port | `useSimulation` hook + `commands/simulation.rs` | flask icon in sidebar toolbar |
| 自动更新（issue #12） | `commands/update.rs` + `hooks/useAutoUpdate.ts` + `utils/updateService.ts` + `utils/channel.ts` + `shared/UpdateDialog.tsx` | **通道是运行时用户选择**：`updateCheckMode: none/stable/preview`（config.json，默认 stable；About 手动检查可选通道且不过 DEV 门控）。JS `check()` 无运行时 endpoint → 命令走 Rust `updater_builder().endpoints(vec![..])`：stable 直连 `releases/latest/download/latest.json`（GitHub「最新非 prerelease」指针，永不泄漏 preview）；preview 先 `api.github.com/releases?per_page=100` 解析**版本号最大**的 `vX.Y.Z-preview.N` tag（纯函数 `find_latest_preview_tag`，数值四元组比较；未认证限流 60/h/IP 超限静默降级）再 tag-pinned。自动检查：`useAutoUpdate` 等 `ui.configReady` 信号（`useConfigPersistence.loadConfig` 完成置位，15s 兜底）后评估——复审替代旧 3s 启发式窗口；7 天周期 + `shouldAutoCheck` 纯函数（首启立即/snooze 暂停/成功才记 lastCheckAt（完成时刻），localStorage 记账；设置改通道时 `updateTiming.clearLastCheck()+clearSnooze()` 使新通道立即生效）；`UpdateDialog` 三动作（立即更新进度+relaunch/7 天后写 snooze/永不提醒同步 mode=none 全量保存；下载中遮罩/X/按钮均不可关闭）。`#[cfg(debug_assertions)]` 命令返回 Ok(None)（自动检查前端另有 `import.meta.env.DEV` 短路；**手动检查不过 DEV 门控**——显式意图，debug 后端子 Ok(None) 兜底，E2E 可 mock 驱动）。复审加固：安装命令带 `expectedVersion` 安装前重检查版本比对（TOCTOU 防护）；未知 channel 报错不静默回退 stable；GitHub API 15s 超时。E2E/单测注入：runCheck 的 `enabledOverride` 参数（vitest 中 import.meta.env.DEV 静态替换为 true 无法 stubEnv）。发布流：`publish-preview.yml`（tag `v*-preview*`、唯一 tag+prerelease+draft:false）与 publish.yml（`!v*-preview*` 否定）双流，均设 `updaterJsonPreferNsis: true`；权限 `process:default`（`updater:default` 复审移除——JS updater IPC 零使用，npm 包已卸载）；依赖 `@tauri-apps/plugin-process`/`tauri-plugin-process`/`reqwest 0.13(rustls)+url`。**二轮**：preview 检查 = max(preview, stable) 双检查取 semver 大（安装按 `payload.channel` 解析 endpoint）；会话内 6h 重评估（`useAutoUpdate` setInterval，shouldAutoCheck 门控）；改通道保存后立即首检 + 设置页「上次自动检查」展示；changelog 轻量 Markdown 渲染（`utils/changelog.ts`：heading/bullet/bold 纯函数，渲染层防注入）；弹窗「查看发布页」（`releaseUrl`，tag 约定 `v<version>`）；时钟回拨防护；发版 CI 三重护栏（质量门 + notes↔版本校验 + `verify-release` latest.json 四平台键 gate）；macOS 自动更新暂不支持（Gatekeeper）。详 `docs/architecture/update.md` |
| External tool (flasher) | `commands/serial.rs` `run_port_tool`/`kill_port_tool` + `useToolOutput` hook + `ToolSettings` page | close→spawn→stream→reopen 闭环；`{port}` 模板替换；配置在设置弹窗「外部工具」页；触发在侧边栏右键菜单 |
| 分组整组执行外部工具 | `Sidebar.tsx` 分组右键菜单 + `shared/GroupToolDialog.tsx` + `usePortToolActions.runToolForGroup` | 分组菜单 `sidebar.group.contextMenu.runTool` → 对话框列出配置/未配置端口（Cancel / Configure Missing 跳工具设置页 / Run Configured Only）；严格配置判定=配置存在+portId 匹配+`command.trim() !== ''`；`utils/groupTool.ts` `partitionGroupPorts` 纯函数；**`Promise.all` 并行**运行已配置端口（issue #7-9，跳过运行中端口，单端口失败不中断整组） |
| Resize operation panel | `src/components/shared/OperationPanelResizeHandle.tsx` + `ui.operationPanelHeight` | vertical drag handle between MainDisplay and OperationPanel; default 280px (issue #2-6), clamp [160,600] |
| 标签页批量开关串口 / 标签外部工具菜单 | `TabBar.tsx` 右键菜单 + `Pane.tsx` 接线 + `usePortToolActions` | 「打开/断开所有标签页」遍历全局 tabs 逐个 open/close（100ms 节流）；工具三入口与侧边栏同源（`usePortToolActions`），文案复用 `sidebar.port.contextMenu.*` key |
| 串口分组持久化 | `config/mod.rs` `port_groups` + `commands/storage.rs` `save_port_groups` + `useAppInit` | 分组是第 7 类 config 实体；启动经 `get_config` 恢复并回填 `ports.groupId`；groups 变更 500ms 防抖自动保存（无手动「保存布局」按钮） |
| 端口自然排序 | `src/utils/portSort.ts` + `useAppStore.sortPortsByNumber` | `naturalCompare` 数字段按数值比较（COM1<COM2<COM12）；排序是**一次性动作** `sortPortsByNumber()`（重排 ports + 各分组 portIds，幂等、不重置 groupId，issue #6-4），Sidebar 无持久 sortMode 开关，拖拽/分组始终可用；组内顺序随 `save_port_groups` 持久化、未分组顺序不保存；`mergePorts` 按 existing 顺序合并，轮询不冲掉顺序 |
| 串口右键菜单分组控制 | `Sidebar.tsx` + `useAppStore.ts` | 按端口分组态动态渲染菜单项（issue #6-5）：未分组且有组→逐组「移入分组『{{name}}』」；未分组无组→「新建分组并移入」；已在组里→「移出分组」；i18n keys `sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}` |
| 发送异步化 | `commands/serial.rs` `send_serial_data` + `lib.rs` `AppState` | `send_serial_data` 改 async fn + `tokio::task::spawn_blocking`（原同步命令在事件循环主线程执行 write_all+flush+日志写→每次 TX 卡顿 + tao `NewEvents`/`RedrawEventsCleared` 警告白屏，issue #6-1）；`AppState.serial_manager`/`log_manager` 改 `Arc<Mutex<..>>`（Deref 使 `.lock()` 调用点零改动）；`send_file` 本就是 async（tokio::fs::read + 分块 yield），无同类阻塞；**写路径读写句柄分离 + 无界 flush 摘除**（issue #6-10）：`SerialPortHandle` try_clone（Windows = DuplicateHandle）拆 read_port/write_port；热路径不再 `flush()`（FlushFileBuffers 无超时受流控约束）+ `write_all_with_deadline` 总写期限（2s）；两段式发送（全局锁内只取写句柄克隆，锁外只持 per-port 写锁写） |
| 模拟串口仅调试模式 | `src/utils/devMode.ts` + `commands/simulation.rs` | 前端 `DEV_FEATURES_ENABLED = import.meta.env.DEV` 隐藏全部 SIM UI；后端 release（`cfg(not(debug_assertions))`）命令直接报错；仅 `npm run tauri dev` 可用 |
| 模拟终端 git bash | `src-tauri/src/serial/tty_sim.rs` + `commands/tty_sim.rs` + `hooks/useGitBashSim.ts` | 调试专用 GIT:BASH 虚拟串口——portable-pty（Windows = ConPTY）spawn 本地 git bash pty，pty stdout→`serial:data`（RX）、`send_serial_data`→pty stdin（TX）；`find_bash`/`spawn_bash`/`TtySimPortHandle`（writer/master/child/读线程）；`SerialManager` `gitbash_sim`/`tty_sim_ports` 字段 + GIT: 路由（open_port/send_data/write_raw/close_port/resize_tty_sim）；**打开时携带前端 xterm 尺寸**（`OpenPortArgs.cols/rows`，spawn 即正确尺寸，否则 pty 固定 80×24 致 vim/top 全屏错乱）+ 连接后 `ttyService.resync` 保险；**读线程应答 DSR**（`\x1b[6n`→`\x1b[1;1R`，`scan_dsr` 跨 chunk 检测）——bash/readline 启动时阻塞等终端应答，TRX 模式无终端模拟器，后端不应答则命令全部不执行；应答 **`\x1b[1;1R`（新建会话真实光标位置）而非终端尺寸**——按尺寸应答会把提示符画到右下角「命令行未正确显示」；TTY 模式由 xterm 自动应答，前端 TtyView 对 GIT: 端口过滤 xterm 应答防双响应；**断线关闭 drop master**（ClosePseudoConsole → 读线程解除阻塞）+ `close_serial_port` 异步 join（读线程永久阻塞时也不冻结 UI）；双层门控（前端 `import.meta.env.DEV` 隐藏 + 后端 `cfg(not(debug_assertions))` 命令拒绝，issue #11） |
| 终端搜索字符级高亮 | `terminalSearch.ts` `markSearchMatchesInHtml` | HTML tag/实体感知的 `<mark>` 叠加层，只在命中行应用；匹配计算仅搜索栏打开时进行 + `findMatchesIncremental` 前缀收窄 |
| First-run config creation | `config/mod.rs` `ConfigManager::new` | config.json created on first run with default `AppConfig` (empty entity arrays); no database |
| Config versioning / migration | `config/mod.rs` `migrate()` + `config_version` field | fresh schema (`config_version = 1`), forward-compatible, additive |
| Config path customization | CLI `--config` / `HYPERCOM_CONFIG` env / portable mode | resolution order in `ConfigManager::new` |
| Config validation | `config/mod.rs` `validate_and_clamp()` | runs on `set_config` to enforce bounds |
| Config backup / recovery | `config/mod.rs` `save()` writes `.bak` / `new()` falls back to `.bak` | corrupt JSON auto-recovered |
| Session snapshot update | `update_session_snapshot` dedicated command | writes separate `session.json` (not config.json); avoids full config save + `.bak` churn |
| 状态栏内存显示 | `commands/system_cmds.rs` `get_system_status` | **应用进程树级内存**：本进程+全部后代进程（含 WebView2/Chromium 子进程）RSS 之和（`collect_app_pids` 纯函数 + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`，issue #6-6）；CPU 仍系统级；`memory_used_mb`/`load_status` 纯函数（issue #5-5 / #6-6；内存总预算已删，`load_status` 现只按 CPU>90 判 high_load）；状态栏显示「JS堆 XMB · 进程 YMB」（无总预算分母） |
| ConfigModal 框选不关闭 | `ConfigModal.tsx` | overlay pointerdown 记录起点是否在弹窗内，click 时起点在弹窗内则忽略关闭（框选文字松手界外不再误关，issue #6-8） |
| 通知中心面板 / 快捷发送 pill 样式 | `notification-center.css` + `operation-panel.css` | `.notify-panel` 320→360px 宽、340→400px 高（issue #6-7）；`.op-quick-cmd` flex column：`.op-quick-cmd-name-row`（HEX 徽标+名称）在上、`.op-quick-cmd-content` 在下（issue #6-9）；`.notify-row-port`/`.notify-row-time`（issue #7-1）；`.op-quick-panel-btn` accent 填充按压按钮 + `.op-quick-panel-btn-label`（issue #7-2） |
| 自定义文本右键菜单 | `src/components/shared/TextEditContextMenu.tsx` + `App.tsx` / `PopoutShell.tsx` | 输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`contextMenu.*` i18n）；`useTextEditContextMenu()` document 级拦截——可编辑目标 `preventDefault` + 弹自定义菜单（右键时快照选区，点击项先恢复焦点+选区再 `document.execCommand`），非可编辑目标一律 `preventDefault`（取代旧 App.tsx effect）；App 根 + PopoutShell 各挂一次；组件级 `onContextMenu`（stopPropagation 的终端行/侧边栏/标签页）不受影响 |
| 配置持久化审计（全量保存不丢实体） | `utils/configMerge.ts` `mergeLiveRuleEntities` + `ConfigModal.tsx` / `DiagnosticLogDialog.tsx` | store.config 实体数组是启动快照、从不跟随 `useRuleStore`——全量 `set_config` 前必须 `mergeLiveRuleEntities(config, useRuleStore.getState())` 合并 5 个活实体（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs）；`portPresets` 无 store 镜像（仅 store.config + 设置页本地态）；`portGroups`/`portMeta` 已由 useAppInit 同步（#4-10 模式，issue #5-2） |

## CODE MAP

Frontend (manual review; TypeScript LSP unavailable in this environment):

| Symbol | File | Type | Role |
|--------|------|------|------|
| `useAppStore` | `src/stores/useAppStore.ts:266` | Zustand store | tabs / ports / `paneTree` / config / groups + `sortPortsByNumber`（一次性自然序排序动作，issue #6-4） |
| `useOperationStore` | `src/stores/useOperationStore.ts:29` | Zustand store | serial params + send (NO `op` prefix; NO display state); `cyclicLoops: Record<portId, boolean>` 每端口循环发送开关（issue #12，`setCyclicLoop` 逐端口启停，替代旧全局 `isLoopSending`） |
| `useTerminalStore` | `src/stores/useTerminalStore.ts:22` | Zustand store | 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt）；行缓冲移入 `TerminalViewportManager` 环形缓冲区（issue #14），store 无行数组、无 Immer、不随数据更新 |
| `useRuleStore` | `src/stores/useRuleStore.ts:32` | Zustand store | highlight + send-command rule sets + CRUD |
| `findLeafById` / `findLeafByTabId` / `findParentBranch` / `findBranchById` / `collectLeaves` / `countLeaves` | `src/stores/useAppStore.ts:25-85` | pure fns | recursive `PaneNode` tree traversal |
| 15 hooks: `useSerialPorts` / `useSerialConnection` / `useSerialReceive` / `useSerialSend` / `useConfigPersistence` / `useSystemStatus` / `useAppInit` / `useSimulation` / `useGitBashSim` / `useToolOutput` / `useAutoUpdate` / `usePopoutBridge` / `usePortToolActions` | `src/hooks/*.ts` + barrel `index.ts` | hooks | Tauri bridge — see `src/hooks/AGENTS.md`; RX → `RxPipeline` 批写（TTY 端口走 `ttyService.feed`），TX 回显前 `flushNow` 排空队列保时序；`useAppInit` 还负责分组/端口元数据（备注名/隐藏）恢复 + 防抖自动保存（issue #2-3 / #4-9/10）；`useGitBashSim` 是调试专用 GIT:BASH 模拟终端开关（issue #11，双层门控）；`useAutoUpdate` 是启动自动更新评估（issue #12，等 `ui.configReady` 信号 + 7 天周期/snooze/首启立即，失败静默）；`usePortToolActions` 是侧边栏/标签页外部工具菜单的共享动作源（issue #2-2），现还返回 `runToolForGroup`（分组整组执行，issue #5-7） |
| `RxLineAssembler` / `RxPipeline` / `getRxPipeline` | `src/utils/rxAssembler.ts`, `src/utils/rxPipeline.ts` | RX 管线 | 字节级行聚合 + rAF 批写（目标=viewportManager 环形缓冲区，issue #14）+ 静默/断线/编码切换 flush + `maxLinesPerTick` 写量限制 + visibility-aware 调度（页面隐藏时 rAF 停摆 → setTimeout 兜底，visibilitychange 重排）+ 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧，issue #6-10）；主窗与弹出窗各自模块单例（无内存裁剪 toast 接线——issue #16 改版后裁剪是常态滚动，不弹通知） |
| `ttyService` | `src/utils/ttyService.ts` | module singleton | TTY 模式 RX/TX 服务（issue #11）：流式 UTF-8 解码 + 每端口队列 + visibility-aware 批写 `term.write`；`attach`/`detach`/`feed`/`clear`/`disconnect`/`send`/`resize`；队列上限 `MAX_TTY_QUEUE`（10000 丢最旧）；TX 刻意不走 `sendToPort`（无本地回显） |
| `TtyView` | `src/components/MainDisplay/TtyView.tsx` | component | TTY 端口 xterm 宿主（issue #11）：Terminal + FitAddon fit（ResizeObserver + rAF 防抖）、onData→`ttyService.send`、onResize→`ttyService.resize`；`hidden` prop = 非活动标签（`.tty-view-hidden` display:none，恢复可见显式 re-fit，**会话跨标签保留**）；字体/字号经 `term.options` 活更新不重建；Ctrl+滚轮缩放（8–48px，镜像 TerminalView）；Terminal 实例由本组件拥有，卸载时 dispose（`ttyService.detach` 不清实例） |
| `ReassemblerSegment` | `src/utils/protocolParser.ts` | type | `ProtocolFrameReassembler.feed()` 返回有序段数组（frame/raw 按流顺序），不再是 `{frames, flushedBytes}` |
| Pop-out intent bridge | `src/hooks/usePopoutBridge.ts` + `popoutEventService` in `src/services/tauri.ts` | pop-outs are separate webviews: exchange intents (`popout:send-command` / `popout:open-config` / `popout:request-sync`) + refresh signals (`command-sets:changed` / `active-tab:changed`), never shared mutable state; sends route through module-level `sendToPort` so TX echo/traffic/history work |
| `evaluateTriggers` | `src/utils/triggerEngine.ts` | pure fn | conditional trigger matching engine (contains/exact/regex/hex) |
| `tauri` service modules | `src/services/tauri.ts` | service | wrapped `invoke` calls (6 modules) |

Backend:

| Symbol | File | Type | Role |
|--------|------|------|------|
| `CommandError` | `src-tauri/src/commands/mod.rs:20` | enum (thiserror) | Serial/Config/Log/System/Lock/Io/Other; manual `serde::Serialize` |
| All Tauri commands (11 domain files) | `src-tauri/src/commands/*.rs` | Tauri cmd | see `src-tauri/src/commands/AGENTS.md` |
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

**Note**: `sendOnEnter` and `quickSendInlineCount` do NOT live here. They are in `useAppStore.config` only. SendSection reads them via `useAppStore(s => s.config.sendOnEnter)` / `useAppStore(s => s.config.quickSendInlineCount)`. `quickSendInlineCount` 自 issue #5-4 起仅语义为 0=隐藏快捷条，>0 时可见条数宽度自适应（`computeFitCount`）。Display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) and `loopInterval` are also NOT here — they live per-tab in `useTerminalStore`. The cyclic-send repeat count (`loopRepeatCount`) is also NOT here — it moved to per-command-set `SendCommandSet.repeatCount` (config.json), read by `useCyclicSend` from the active set. **循环发送运行标志（issue #12）**：旧全局单例 `isLoopSending` 已删除，改为每端口 `cyclicLoops: Record<portId, boolean>`（`setCyclicLoop(portId, running)` 逐端口启停）——循环目标绑定启动它的端口、聚焦无关，多端口可并行。

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

**Hot-plug 语义（issue #12）**：
- fresh 枚举命中的端口保留 `connected`/`connecting`（真实会话），**但不保留 `error`**——重置为 `disconnected`，否则本次 open 失败的状态被每次轮询永久重建，刷新按钮（与轮询同一条 `refreshPorts`→`mergePorts` 链）永远救不回。
- 从枚举消失的 `connected`/`connecting` 端口经 union-back 保留**最多 `MAX_MISSING_POLLS=3` 轮**（模块级 `ghostMissingPolls`），超限放弃——拔出后读线程可能永不发 `disconnected`（空闲），无上限保留会产生幽灵端口。
- 后端 `open_real_port` stale 守卫交叉核对系统枚举：设备已消失 → 回收幽灵句柄（停线程 + join ≤100ms）允许重插后直开；设备仍存在 → 才报 `already open`。

## Hooks: useSerialReceive vs useSerialSend

The old `useSerialData` hook was split into two hooks with different lifecycles:

- **`useSerialReceive()`** — Owns the serial data event listener lifecycle. Called **once** in `App.tsx`. Listens to `serial:data` events and feeds them into the **RX pipeline** (`getRxPipeline()`: byte-level line aggregation + rAF-batched append → viewportManager 环形缓冲区); TTY 端口（`mode==='tty'`）字节**直喂 `ttyService.feed`**（跳过触发引擎/协议解析/行组装）；on `disconnected` it calls `pipeline.disconnect(portId)` (flush tail + drop per-port state) + `ttyService.disconnect(portId)` (flush queue but keep the xterm instance across reconnect). Holds NO store selector subscriptions. Never call this more than once.
- **`useSerialSend()`** — Returns a send action. Called in `OperationPanel`. Writes to the serial port and appends the sent line to the terminal via `appendTerminalLine` (viewportManager). The actual work lives in the **module-level exported `sendToPort(portId, data, isHex, lineEnding, silent?)`** (TX echo + traffic stats + in-memory history) so non-hook callers — the pop-out intent bridge — reuse the exact same pipeline instead of calling the backend directly. It drains the RX pipeline queue (`flushNow`) BEFORE the TX echo so batched RX can't overtake the send order. **TTY 分支**（`port.mode==='tty'`）跳过 TX 回显与 `flushNow`——无本地回显（对端 echo），仍走后端发送/流量统计/历史。

Both hooks write to the terminal store through `getState()` to avoid re-rendering the hook owner on every line.

The full hook set in `src/hooks/` (15 hooks, individual files):

| Hook | Purpose | Called in |
|------|---------|-----------|
| `useSerialPorts` | Polls port list every 3s | Sidebar |
| `useSerialConnection` | open/close port, routes through `closePort()` | Sidebar / TabBar |
| `useSerialReceive` | `serial:data` event listener → `RxPipeline` (byte-level line aggregation + rAF batch → viewportManager; TTY 端口字节直喂 `ttyService.feed`，跳过触发/协议/行组装) + status handler (`lostPortIds` for DisconnectBanner; 断线走 `pipeline.disconnect` + `ttyService.disconnect`) | App.tsx (once) |
| `useSerialSend` | Send action; `sendToPort` TTY 分支跳过 TX 回显 + `flushNow`（保留后端发送/流量统计/历史）；TX 回显经 viewportManager `appendTerminalLine` | OperationPanel |
| `useConfigPersistence` | Load/save config to backend | App.tsx |
| `useSystemStatus` | Polls CPU/memory every 5s | StatusBar |
| `useAppInit` | One-shot app bootstrap | App.tsx |
| `useSimulation` | Toggle SIM:Loopback virtual port | Sidebar toolbar |
| `useGitBashSim` | Debug-only GIT:BASH 模拟终端 toggle (issue #11; mirrors `useSimulation` dev gating) | Sidebar toolbar |
| `useToolOutput` | `tool:output` / `tool:exit` event listeners | App.tsx (once) |
| `useAutoUpdate` | 启动自动更新评估（issue #12）：等 `ui.configReady`（config 加载完成信号，复审替代旧 3s 启发式窗口）后 `shouldAutoCheck`（7 天周期/snooze/首启立即）→ `runAutoCheck`（检查+记账一体）→ 有更新开 UpdateDialog；成功记 lastCheckAt（完成时刻），失败静默不重置——下次启动重试。**二轮：会话内每 6h 重评估**（常驻挂机覆盖，未到期只读 localStorage）；clock rollback 经 shouldAutoCheck 放行。DEV 构建短路（`isUpdateCheckEnabled`） | App.tsx (once) |
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

Commands are split into 11 domain files under `src-tauri/src/commands/`:

| File | Domain |
|------|--------|
| `serial.rs` | open_port, close_port, send_data, set_serial_params, set_flow_control, send_file, cancel_file_send, attempt_reconnect, run_port_tool, kill_port_tool（GIT: 路由走 send_data/write_raw，issue #11） |
| `simulation.rs` | enable_simulation, disable_simulation |
| `tty_sim.rs` | enable_gitbash_sim, disable_gitbash_sim, resize_gitbash_sim（模拟终端 git bash pty，调试专用，issue #11） |
| `config.rs` | get_config, set_config, reset_config, update_session_snapshot, get_session_snapshot, get_config_path |
| `diag.rs` | get_diag_log_path, read_diag_log, clear_diag_log, append_diag_log（应用自身诊断日志） |
| `log.rs` | start_logging, stop_logging, save_log_as, export_terminal_log, get_log_files, set_log_split_size, set_log_split_enabled, set_log_filename_format, set_log_auto_save, set_log_encoding, open_path, open_log_directory, migrate_log_directory |
| `storage.rs` | settings entities CRUD (command sets / highlight sets / protocol templates / trigger rules / port presets / tool configs) + save_port_groups + save_port_meta — synchronous ConfigManager operations on config.json |
| `file.rs` | write_text_file, read_text_file（配置导入导出）, read_image_data_url（背景图 data URL，issue #13） |
| `popout.rs` | open_popout, close_popout, set_popout_always_on_top |
| `system_cmds.rs` | get_system_status, prevent_sleep, prevent_screen_off |
| `update.rs` | check_for_update, download_and_install_update（自动更新，issue #12；release 才执行，debug 返回 Ok(None)） |

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
scope: ui | backend | store | hooks | docs
```

## Key design reference

架构文档按**功能模块**划分，索引见 `docs/architecture/README.md`：
- `docs/architecture/serial.md` — 串口管理（枚举/热插拔/连接/读写句柄/虚拟端口/外部工具）
- `docs/architecture/terminal.md` — TRX 终端显示（方案B 引擎/滚动/搜索/编码/内存预算）
- `docs/architecture/transmission.md` — 数据收发（RX 管线/TX/循环/快捷/触发）
- `docs/architecture/tty.md` — TTY 终端（xterm/ttyService/模拟终端）
- `docs/architecture/logging.md` / `config.md` / `workspace.md` / `update.md` / `release.md` / `errors.md`

## Other gotchas

- `tauri.conf.json` has `"decorations": false` — custom TitleBar handles window controls via `@tauri-apps/api/window`
- `tsconfig.json` enforces `noUnusedLocals` and `noUnusedParameters` — unused vars are compile errors
- Serial data events carry `data: number[]` (bytes). Frontend decodes with `TextDecoder`. `TerminalLine.rawData` is a **`Uint8Array`** since issue #6-2 (8× memory cut + no temp copy on decode) — `TerminalRow`/`terminalSearch`/`protocolRenderer` must use `Array.from` instead of `.map` (Uint8Array has no `.map`); `setTerminalEncoding` decodes `rawData` directly without wrapping.
- **RX 管线（2026-08-04 重构）**：`serial:data` 事件不再「一事件一行」，而是进 `getRxPipeline()`（每 webview 一个模块单例）：`RxLineAssembler` 字节级切行（CR/LF/跨事件 CRLF/4KB 强制发射）→ 每端口队列 → rAF tick 每端口一次 append（目标=viewportManager 环形缓冲区，issue #14）→ 250ms 静默 flush 未终结尾部（时间戳取最后事件时间）。`sendToPort` 在 TX 回显前 `flushNow` 排空队列保收发时序；断线走 `pipeline.disconnect`；编码切换前必须 `flushAndReset`（旧编码冲刷尾部，`TerminalFilterBar` 已接线）。**不得**在 hook/弹窗 cleanup 里 `dispose()` 单例。`StreamingDecoderCache` 已删除。**visibility-aware 排空（issue #6-10）**：页面隐藏时 rAF 停摆——`defaultScheduleFlush` 在 rAF 可用且页面可见时走 rAF，否则（页面隐藏/无 rAF）走 setTimeout(cb, 16) 兜底；构造函数注册 `visibilitychange` 监听，变 hidden → 取消未触发的 rAF tick 并按当前调度器重排（自然落 setTimeout），变 visible → 同样重排回 rAF（更低延迟），dispose() 移除监听；`feedBytes`/`enqueueLines` 入队后 enforceQueueCap：队列超过 `maxQueuedLines`（默认 10000）splice 丢**最旧**，防隐藏窗口长时间积压无界。
- **滚动锁定（2026-08-04 重设计）**：`scrollLocked` 只由显式意图写入——图钉按钮、`.terminal-jump-btn` 跳转按钮（滚动条两端：到顶解锁、到底锁定并点亮）、手势 settle（滚轮/滚动键/滚动条拖拽/中键，120ms 静默后按 atBottom 50px 容差判定）。`TerminalRenderer` 的 scroll 监听只驱动可见窗口重算（不碰锁定状态）；搜索栏打开时抑制跟随，关闭时若锁定则滚回最新。
- ConfigModal's rule/command editors save to config.json via `storageService` (which wraps config-backed commands). Load on mount via `useEffect`. Rule state lives in `useRuleStore`.
- **config.json is the single source of truth for ALL settings entities** (2026-08 migration: the SQLite layer was removed entirely). The 8 entity types (`SendCommandSetEntry`, `HighlightRuleSetEntry`, `ProtocolTemplateEntry`, `TriggerRuleEntry`, `PortPresetEntry`, `PortToolConfigEntry`, `PortGroupEntry`, `PortMetaEntry`, all `#[serde(rename_all = "camelCase")]`) live as 8 `Vec` fields on `AppConfig` (`send_command_sets`, `highlight_rule_sets`, `protocol_templates`, `trigger_rules`, `port_presets`, `port_tool_configs`, `port_groups`, `port_meta`). `commands/storage.rs` CRUD is synchronous: lock `config_manager` → mutate the Vec via `get_config_mut()` → `save()` writes config.json atomically (tmp + rename + `.bak`). `port_groups` is a whole-list replace (`save_port_groups`, issue #2-3) — groups auto-save via a 500ms-debounced store subscription in `useAppInit`; there is no manual «save layout» button. `port_meta`（备注名/隐藏状态）同款整体替换（`save_port_meta`, issue #4-9）。The session snapshot was split out into a separate `session.json` (next to config.json) via `load_session_snapshot()`/`save_session_snapshot()`; `update_session_snapshot` writes session.json and does NOT trigger a config `.bak`. `LogManager` is initialized FROM `ConfigManager` in `AppState::new()`, and `set_config`/`reset_config` auto-sync log settings via `sync_log_manager_from_config()` — the frontend no longer syncs log settings (`syncLogSettingsToBackend` deleted). Log line prefix format is configurable (issue #3-4): `log_include_timestamp` / `log_include_direction` (`#[serde(default = "default_true")]` — old config.json without them reads back as `true`) control whether `PortLogWriter::write_line` emits `[timestamp] ` / `RX|TX ` prefixes; both off → bare data line. They lock at `create_writer` time (like encoding) and sync via `sync_log_manager_from_config`. 背景图四个字段（`background_image*`，issue #13）是普通标量字段，走 `...config` 展开随全量保存流过——**不需要**进 `mergeLiveRuleEntities`。历史：issue #3-5 曾删除死字段 `background_image`（旧实现裸 `url("C:\...")` 在硬化 webview 载不动），issue #13 以「路径存 config + `read_image_data_url` 读为 data URL + 毛玻璃 token」的完整形态回归。
- ConfigModal pages (GeneralSettings, LogSettings, DisplaySettings, BackupSettings) use **per-field selectors** instead of subscribing to the whole config — this prevents unnecessary re-renders when unrelated config fields change.
- SIM:Loopback virtual port is available when `enable_simulation` is called (flask icon in sidebar toolbar)。**周期输出频率命令（issue #14 高吞吐验证）**：向 SIM:Loopback 发送**文本模式纯数字**（trim 后为数字，如 `100`）即把周期输出（旧心跳）频率切到每秒 N 次（0 = 停止；上限 `MAX_SIM_RATE = 10000`，超限 clamp），命令本身不回显——输出为 `[SIM] Heartbeat #<seq>` 序号行，积分器补发保证平均频率精确（`sim_due_lines` 纯函数，100ms 循环节拍不限制高频）。HEX 模式/非数字 TX 保持原回显。默认 2/s（500ms，与旧心跳一致）。
- CSS is split across `src/styles/` (16 component CSS files + `base.css`; UpdateDialog styles live in `update-dialog.css` — 复审自 config-modal.css 迁回，对齐方案 M1.4). `src/styles.css` is just an `@import` entry point, not the main stylesheet.
- `src/utils/hexUtils.ts` provides `hexToString` and `stringToHex` for HEX send/parse.
- ConfigModal split into: `ConfigModal.tsx`, `RuleSetAccordion.tsx`, `pages/` (9 settings pages), `editors/` (HighlightRuleEditor, ProtocolTemplateEditor, SendCmdEditor).
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
- **日志空行不落盘（issue #12）**：`write_line` 顶部 `data.is_empty()` 直接返回 Ok；string 格式 decode 后 `trim_end_matches(['\r','\n'])` 为空（只含行结束符的 TX）同样跳过——`write_rx` 对连续分隔符/行首行尾分隔符产出的**空块**因此天然不落盘。`close_writer` 关闭时 `current_size==0` 且磁盘 0 字节 → 删除空文件。新增日志写入路径时不要绕过这两个守卫（组装器仍会产出空块，这是刻意的行边界语义）。
- **状态栏内存（issue #5-5 → #6-6）**：`get_system_status` 的内存自 issue #6-6 起为**应用进程树级**——本进程+全部后代进程（含 WebView2/Chromium 子进程）RSS 之和（`collect_app_pids` + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`）。历史：issue #5-5 曾从单进程 RSS 改**系统级**（`system.refresh_memory()`），但系统级看不到软件自身占用、内存预算软兜底也无法工作；#6-6 再改回进程树级，以当前为准。CPU 仍系统级；`load_status` 现只按 CPU>90 判 high_load（issue #16 改版已删内存总预算，状态栏显示「JS堆 XMB · 进程 YMB」，无总预算分母）。
- **rawData / 内存瘦身（issue #6-2）**：`TerminalLine.rawData` 由 number[] 改 `Uint8Array`（内存 8 倍削减 + 免解码临时拷贝）；`setTerminalEncoding` 直接 `decoder.decode(rawData)` 不再包一层 Uint8Array；`terminalSearch`/`protocolRenderer` 用 `Array.from` 逐字节（Uint8Array 无 `.map`）。TX 行 `txRawData` 同样存 Uint8Array。issue #14 起 RX 行不再存 content 字符串（`content?` 可选），渲染/搜索/过滤经 `getLineText(line, encoding)` 惰性解码。
- **内存上限（issue #6-2 → #16 改版）**：删除 `memoryLimitMb`/`memoryPerPortBudgetMb` 双内存预算，改为单一 `maxDisplayLines`（每端口终端最大显示行数，默认 100000，clamp [1000,1000000]）。Rust `AppConfig.max_display_lines`（`#[serde(default = "default_max_display_lines")]` 缺省 100000）+ `validate_and_clamp` [1000,1000000]；升级兼容：`ConfigManager::new` 加载时 `strip_legacy_memory_budget_keys` 显式剥离旧 config.json 里的 `memoryLimitMb`/`memoryPerPortBudgetMb`（下次 save 落盘即物理删除）。
- **裁剪触发（issue #6-2 → #14 环形缓冲区 → #16 改版逐行覆盖）**：`TerminalBuffer` 固定行容量（`maxLines = maxDisplayLines`），溢出时 head 前进 O(1) **逐行覆盖最旧一条**（滚动窗口，firstSeq 每 append +1）；`appendLines`/`appendTerminalLines` 返回 boolean（是否发生覆盖）；**无「因内存限制清屏」toast**（逐行覆盖是常态滚动，不是异常事件——issue #16 曾整夜误报的根因）。存活行 seq 稳定，渲染引擎不重画。
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
- **TTY 模式（issue #11）**：TTY 端口（`mode:'tty'`）由 xterm.js 渲染完整终端流——**无本地 TX 回显**（对端 shell 会 echo，本地再插一条 TX 行既重复又破坏终端流），`sendToPort` TTY 分支跳过 TX 回显 + `flushNow`（仍走后端发送/流量统计/历史，快捷发送/命令面板在 TTY 下可复用）；**TTY 写 pty 做过回车归一**（`SerialManager::send_data` GIT: 分支 `normalize_tty_line_ending`）：pty 行规程（ICRNL）把 `\r` 转成 `\n`，`\r\n` 会变成两个换行——快捷发送后多执行一行空命令，故 `\r\n` 统一归一为单个 `\r`（真实终端 Enter），`\r`/`\n`/`None` 原样保留；`useSerialReceive` 对 TTY 端口**跳过触发引擎/协议解析/RxPipeline 行组装**（字节流没有「行」语义，交给 xterm 的 ANSI/光标/备用屏幕）直喂 `ttyService.feed`；RX 解码**仅 UTF-8**（`TextDecoder('utf-8',{stream:true})`，无 GBK）——TRX 的多编码切换不适用于 TTY；**弹出窗不支持 TTY**（`Pane.handlePopOut` 阻止 detach 并提示 `tty.popoutUnsupported`，弹出窗是独立 webview 不共享 ttyService/xterm 实例）；**标签切换保留会话**（TTY 标签在 Pane 内常驻挂载、非活动 `display:none` 隐藏 `.tty-view-hidden`，恢复可见 re-fit——xterm 缓冲在实例内，切标签销毁实例即丢会话；仅模式切换/关闭标签/跨 Pane 拖拽销毁，见 §TTY 视图/渲染分流）；**切换模式清空缓冲区**（`ParamsSection.handleModeChange` 清 TerminalStore + `flushAndReset` + `ttyService.clear`，避免旧模式 buffered 数据混入新模式首屏）；`ttyService` 队列上限 `MAX_TTY_QUEUE`（10000）超限丢最旧；`ttyService`/`getRxPipeline` 的 `dispose()`/`reset()` 仅测试用，应用生命周期不得调用（同款模块单例纪律）。

## 方案B 终端显示引擎（issue #14 v0.6.0；issue #18 流式布局 + 选区钉住重构）

TRX 终端的行缓冲与渲染**脱离 React 调度**。数据路径：`serial:data` → `RxPipeline`（字节级行聚合 + rAF 批写）→ `viewportManager.appendTerminalLines` → `TerminalBuffer`（环形缓冲区）→ 同一 rAF 内 `TerminalRenderer.render`（直接 DOM）。

|模块|文件|职责|
|---|---|---|
|`TerminalBuffer`|`src/utils/terminal/TerminalBuffer.ts`|环形缓冲区：O(1) 追加/裁剪、稳定 seq（裁剪只移动 [firstSeq,lastSeq] 窗口，存活行 seq 不变）、`maxLines` 行容量（超限**逐行覆盖最旧**，滚动窗口，issue #16 改版；`append` 返回 `{seq, trimmed}`）、`snapshot`/`replaceAll`/`clear`/`setLimits`|
|`TerminalRenderer`|`src/utils/terminal/TerminalRenderer.ts`|直接 DOM 引擎（issue #18 流式布局重构）：contentLayer = `[headSpacer][行…][tailSpacer]`，行是**普通文档流**子元素（固定行高），spacer 承载屏外空间——**DOM 顺序 == 视觉顺序由结构保证**（旧 absolute+translateY 格子与 insertRowInOrder/每帧排序修复/脱链防御整套机制结构性删除）；新行经 `findFlowAnchor` 只相对 spacer 或更大 visIdx 的行插入（**停车行也是锚点候选**，只跳过已被裁出缓冲的行）；**选区钉住**：活选区触及的行永不回收/不重写/不换父——窗内=文档流行、窗外=**原地停车**（`display:none` 同父；Chromium 探针证实换父即丢 Range），`selectionchange` 清选区后自动回收，`MAX_PINNED_ROWS=600` 超限优雅放弃；同帧钉底、大 trim 锚点恢复（`LARGE_TRIM_ROWS`，`setLimits` 收缩触发）、`seqToVisIdx`/`visIdxToSeq` 支持过滤列表、frozen null 归一化（`Number.MAX_SAFE_INTEGER` 防 `seq > null` 误判）全部保留|
|`TerminalViewportManager`|`src/utils/terminal/viewportManager.ts`|每端口枢纽：`TerminalBuffer` + renderer 生命周期（attach/detach/dispose）+ **增量过滤/搜索**（新行 append 时匹配一次并入列，不整缓冲重扫）+ 暂停（frozenSeq）+ 选区/锁定/手势透传 + rAF 调度 + `subscribe`（渲染 pass 通知 React 壳刷新读数）+ matchSet 按 (offset,length,currentMatch) 缓存（免每帧 new Set）|
|适配面|`viewportManager.ts` 模块级函数|`appendTerminalLine(s)`/`clearTerminal`/`replaceTerminalLines`/`snapshotTerminalLines`/`releaseViewportManager`/`getViewportManager`——非 React 调用方（TX 回显/工具输出/回放/弹窗/热键）一律走这里，**不再碰 useTerminalStore 的行 API**。**issue #11**：`appendTerminalLine(s)`/`replaceTerminalLines` 是「manager 存在才写入」——标签关闭（releaseViewportManager）后端口仍连接、RX 继续到达时**静默丢弃**（不复活 manager、不积压），重开标签页从零开始|

关键不变式：
- **React 不渲染行**：contentLayer 是命令式 DOM，TerminalView 壳重渲染不会触碰它（React 不管理非 JSX 子节点）。
- **标签切换保留缓冲**：Pane 对 TRX 标签常驻挂载（hidden prop → display:none），viewportManager 模块注册表持有实例；关闭标签/TRX→TTY 切换才 `releaseViewportManager`。
- **关闭标签页 = 前端显示目标销毁、串口连接保留（issue #11）**：`Pane.cleanupClosedTab` 不再调 `closePort`（后端日志由 LogManager 独立落盘），改 `getRxPipeline().disconnect(tabId)`（清管线队列/组装器/解码器）+ `ttyService.detach(tabId)`（清 TTY 队列）+ `releaseViewportManager`——重开标签页从零开始新一轮输出；`ttyService.feed` 对「无标签页且未 attach」丢弃（挂载前首帧窗口仍入队等 attach replay）。
- **惰性解码**：RX 行只存 `rawData`，`getLineText(line, encoding)`（`src/utils/lineText.ts`，模块级 TextDecoder 缓存）按当前编码解码；编码切换 = 重渲染，无 store 遍历。
- **内存上限**：`computeBufferLimits()`（从 `config.maxDisplayLines` 派生 `{ maxLines }`，缺省 100000、下限 1000）在 manager 创建时读取；配置变更由 App.tsx effect 经 `applyLimits({maxLines})` 同步到现存实例。**裁剪语义（issue #16 改版）**：满 `maxLines` 后每 append **逐行覆盖最旧一条**（滚动窗口）——无字节预算、无 half-trim、无应用级软兜底、无内存裁剪 toast。
- **渲染正确性陷阱**：frozen 参数为 null 时必须归一化为 `Number.MAX_SAFE_INTEGER`（原始 `seq > null` 会把所有行判为隐藏）；`visibleSeqsOffset` 是过滤列表的惰性裁剪头（append O(1) 摊还）。
- **stale 判定用实时列表位置（issue #10）**：head trim 前进 firstSeq（及 filtered.offset）后，active 行缓存的 visIdx 字段整体过期——stale 检查若按字段判定，被裁行/幸存行永不回收 → DOM 行数无限增长、每帧 O(n) 渲染 → 输出区抖动。`seqToVisIdx`（identity O(1)、过滤模式二分）是每帧 stale 检查的唯一判定来源，越界即回收。
- **选区钉住替代全局冻结（issue #18）**：旧 `isSelecting` 全局冻结 + `setSelecting` API 已删。活选区触及的行（`captureSelectionSeqSpans` 映射 Range 端点到 seq 区间）永不回收/不重写/不换父；窗外停车 `display:none`（同父）；`selectionchange` 清选区后下一帧回收；**停车行占真实文档流槽位**——`findFlowAnchor` 必须把停车行当插入锚点候选（曾漏 → 可见 DOM 乱序 [30..35, 8..29, 36..44]），只跳过 `seqToVisIdx` 为 null（已被裁出缓冲）的行；**`Selection.toString()` 按布局可见性序列化**（Chromium）——停车行文本从中消失，复制路径用 `selectionText()`（`Range.cloneContents`，`terminalContextMenu.ts`）；soak 测试（`TerminalRenderer.soak.test.ts`）随机操作序列断言五条不变式。

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

- `src/i18n.ts` 已就位 — i18next + react-i18next，扁平 dotted key（`keySeparator: false`），550 keys × zh-CN/en-US

  > 2026-08-15 issue #12 自动更新新增 `update.*` 28 键，复审删除 8 个无消费者键（newVersion/publishDate/downloadFailed/upToDate 双语）→ 净 550；二轮新增 viewRelease/lastCheckLabel/lastCheckNever（双语 6 条）→ 556。2026-08-16 issue #13 背景图新增 `displaySettings.background.*` 7 键（双语 14 条）→ 570。2026-08-22 日志新增 `logSettings.newFilePerSession`（双语 2 条）→ 572。2026-08-26 前端整理删除 12 个零引用键（mainDisplay.emptyState / pane.toolbar.status.disconnected / sendSection.hexLabel / paramsSection.displayLabel / paramsSection.fontSizeLabel / sidebar.group.delete / trigger.name / popout.terminalPlaceholder / terminalPopout.poppedOutPlaceholder / statusBar.duration.label / terminal.direction.TOOL / toast.error.* 8 键）→ 550。
- `main.tsx` 第 5 行 `import './i18n'` 副作用初始化
- `useAppStore.subscribe((state) => ...)` 监听 `config.language` 变化 → `i18n.changeLanguage`
- 组件用：`import { useTranslation } from 'react-i18next'` + `const { t } = useTranslation()` + `{t('namespace.key')}` / `t('namespace.key', { var: value })`
- **类组件**（如 `App.tsx` 的 `AppErrorBoundary`）不能使用 hook，直接 `import i18n from './i18n'` 后 `i18n.t('key')` —— 但不会随语言切换重渲染（仅在错误边界这种边缘场景可接受）
- 不翻译的字符串：协议词汇 `None/Even/Odd/Mark/Space`、`Xon/Xoff`、`RTS/CTS`；编码名 `ASCII/UTF-8/GBK/ISO-8859-1`；单位 `ms/px/MB`；首字母缩写 `SIM/VCP/HEX/DTR/RTS` —— 这些在 i18n.ts 中也无对应 key
- ✅ 全部 30 个组件 `.tsx` 文件已接入 `t()`（2026-07-21 完成）— 新增组件文本必须先查 `src/i18n.ts` 现有 key，不够用则在 zh-CN 和 en-US 两侧同时新增 key
- issue #6 新增 key：`sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}`（串口右键分组）、`quickSend.runCurrentLineAdvance`（文本模式执行当前行并移至下一行）、`toast.memoryTrim`（内存裁剪提示，含 `{{port}}` 插值）
- 切换语言时全部界面实时切换，无硬编码中文残留
