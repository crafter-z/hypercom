# 缺陷追踪

> 仅记录当前存在的未修复缺陷。已修复项移入变更历史。

## 未修复

当前无未修复缺陷。

## 已修复 (2026-08-24 issue #10/#11/#12：缓冲裁剪 DOM 泄漏抖动 · 关标签页不关串口 · 拖选滚动黑块)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 659/659 (37 files), `cargo check` 0 错, `npx playwright test` 19/19。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `TerminalRenderer.ts` | 高频输出下输出区**上下抖动约一行、一秒多后自行恢复**（issue #10）：缓冲 head trim（容量/内存预算裁剪）前进 firstSeq 后，active 行的 **visIdx 字段停留在旧窗口值**——stale 检查仅按字段判定，被裁行（seq<firstSeq）与幸存行（实际位置平移）的字段恰好落在新窗口内 → 永不回收 → 每帧 append+trim 都新建窗口行、旧行残留 → **DOM 行数无限增长**（e2e 实测 6669 行 vs 正常 27）→ 每帧 O(n) 渲染 → 帧率暴跌。数据突发填满缓冲 → trim 风暴 → 抖动 → 突发结束「自行恢复」 | stale 判定改用**实时列表位置**（`seqToVisIdx`：identity O(1)、过滤模式**二分**替代 indexOf——该函数现被每帧每个 active 行调用）：越界（被裁/冻结外）即回收。修复后 DOM 行数恒 ≤ 窗口+overscan（e2e 断言 ≤40） |
| HIGH | `Pane.tsx` `cleanupClosedTab` + `viewportManager.ts` + `ttyService.ts` | 关闭标签页**同时关闭串口**（issue #11）：① 旧 `cleanupClosedTab` 对 connected 端口调 `closePort`——标签页生命周期与串口连接耦合，误关端口、停日志；② `appendTerminalLines/appendTerminalLine` 用 `getViewportManager`（**创建**）——标签关闭（releaseViewportManager）后 RX 数据继续到达会**复活 manager** 积压进新缓冲，重开标签页 replay 旧数据；③ ttyService 无标签页期间入队积压，attach 时 replay | ① `cleanupClosedTab` **不再调 closePort**（端口/日志保持连接），改为 `getRxPipeline().disconnect(tabId)`（清管线队列+组装器/解码器）+ `ttyService.detach(tabId)`（清 TTY 队列）+ `releaseViewportManager`；② `appendTerminalLines/appendTerminalLine/replaceTerminalLines` 改 `managers.get`（无 manager **静默丢弃**，不创建）；③ `ttyService.feed`：`term===null && 无该端口标签页` → 丢弃（挂载前首帧窗口仍入队等 attach replay）。后端 RX 日志由 LogManager 独立落盘，关标签页不受影响 |
| HIGH | `TerminalRenderer.ts` | 输出区**拖选文字同时向上滚动，上方黑色未渲染、选不到**（issue #12）：拖选冻结（selecting）期间 `if (selecting) continue` **跳过新行创建**——滚动新进视口的行不物化 → 黑块；释放后依赖 dirty 检查补齐但拖选过程中不可见不可选 | 冻结期间**允许物化新行**（acquire + `insertRowInOrder` + 写内容）：新行不在任何活选区 Range 端点内，创建安全；仅**已有**行冻结（不回收/不重写 innerHTML，保 Range 锚点）。新增 `isNew` 判定：`isNew \|\| (!selecting && dirty)` 才写内容 |

架构变化：`appendTerminalLines/appendTerminalLine/replaceTerminalLines` 语义由「get-or-create」改「manager 存在才写入」——标签关闭（releaseViewportManager）后端口仍连接时 RX 数据静默丢弃；`seqToVisIdx` 过滤模式 indexOf→二分（每帧 stale 检查逐行调用）。

测试新增：TerminalRenderer 2（#12 拖选滚动物化新行+冻结行保留；#10 head trim 回收被裁行、DOM 有界）；viewportManager 1（#11 append 无 manager 丢弃 + manager 存在时写入）；ttyService 1（#11 无标签页丢弃、有标签页入队 replay）；e2e 3（#11 关标签 keep 连接+重开从零、#10 trim 期 DOM ≤40+scrollTop 单调、#12 拖选滚动视口行有内容）。

## 已修复 (2026-08-15 issue #12 自动更新复审：workflow NSIS 产物偏好 · 安装 TOCTOU · 下载中可关弹窗 · 清账副作用边界 · configReady 信号 · 死代码清理)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 587/587 (30 files), `cargo check` 0 错 0 警告, `cargo test --lib` 136/136。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `publish.yml` + `publish-preview.yml` | 两条发版流都未设 `updaterJsonPreferNsis`——tauri-action 默认 false，MSI+NSIS 并存时 `latest.json` Windows 块指向 **MSI**（源码核实优先级表），与方案 §5.5 决策「设 true 走 NSIS passive `/UPDATE` 流程」相反，Windows 在线更新走的是从未验收的路径（msiexec `/i /passive /promptrestart`） | 两流 tauri-action 均显式 `updaterJsonPreferNsis: true` |
| HIGH | `update.rs` + `services/tauri.ts` + `UpdateDialog.tsx` | check/install 两次独立往返（设计使然）：弹窗展示版本 X 后若发布了新版 Y，`download_and_install_update` 装的是 Y——「展示的 X、装的 Y」TOCTOU | 安装命令加 `expected_version` 参数：安装前重检查结果版本与候选不一致 → 报错拒绝安装（错误文案带 expected/found，前端重新检查即可）；`downloadAndInstall(channel, expectedVersion)` 传 `candidate.version` |
| MEDIUM | `UpdateDialog.tsx` | 下载中 X 与三个动作按钮都 `disabled`，唯独遮罩 `onClick={close}` 无守卫——点外面关弹窗后后端装完仍无预警 relaunch | 遮罩 onClick 加 `downloading` 守卫（下载中不可关闭） |
| MEDIUM | `GeneralSettings.tsx` + `ConfigModal.tsx` | 三态 radio 的 `updateTiming.clearSnooze()` 在 onChange 立即执行——用户改模式后点「取消」，配置经快照回滚但 snooze 已清，副作用泄漏出保存边界 | 挪到 `ConfigModal.handleSave` 保存边界：快照与当前 `updateCheckMode` 实际不同时才 `clearSnooze()+clearLastCheck()` |
| MEDIUM | `updateService.ts` + `useAutoUpdate.ts` | ① `lastCheckAt` 不分通道：stable 昨天查过，今天切 preview → 首次 preview 检查被旧周期推迟最多 6 天，注释「新意图立即生效」不成立；② `useAutoUpdate` 3s 启发式窗口：config 加载超过 3s 按默认 stable 评估，无视用户配置的 none/preview；③ `markCheckedAt(now)` 用 await 前的评估开始时刻 | ① 新 `updateTiming.clearLastCheck()`，与 snooze 一并在模式保存变更时清（回到「从未检查」→ 立即检查语义）；② 新 `ui.configReady` 信号（`useConfigPersistence.loadConfig` finally 置位，成功/失败同）——hook 订阅 false→true 跳变后评估，15s 兜底防信号失联；③ 改记完成时刻 |
| LOW | `update.rs` | ① `find_latest_preview_tag` 取 API 顺序第一个（GitHub `/releases` 创建时间序）——为旧核心补发 preview 会漏掉最新 preview；② `reqwest::Client::new()` 无超时——API 挂起时手动检查按钮永久「正在检查」；③ 未知 channel 静默回退 stable（`_ =>`）；④ `.find()` 后 `.filter(!is_empty)` 死逻辑（regex 通过者不可能为空）；⑤ 函数名 `regex_matches_preview_tag` 实际无 regex | ① 改 `parse_preview_tag` 数值四元组 `(major,minor,patch,n)` 取 `max_by_key`（+2 单测：乱序 API / 数值非词典序 0.10.0>0.9.9、preview.10>preview.9）；② `GITHUB_API_TIMEOUT` 15s；③ 报 `unknown update channel`；④ 删；⑤ 重命名 `is_preview_tag` |
| LOW | `channel.ts` / `i18n.ts` / `package.json` / `capabilities` | 死代码与死依赖：`detectChannel`/`isPreviewVersion` 零生产引用（仅测试）——通道最终是运行时用户选择 + payload 携带；`update.newVersion/publishDate/downloadFailed/upToDate` 4 键（双语 8 条）无消费者；`@tauri-apps/plugin-updater` npm 全项目零引用（更新链路全走 Rust 命令，JS 插件未用）；`updater:default` capability 冗余 | 删两函数仅留 `channelLabelKey`（测试重写 4→1）；删 8 条 i18n；卸载 npm 包；capability 移除（`process:default` 保留——relaunch 必需） |
| LOW | `config-modal.css` | UpdateDialog 样式误落 config-modal.css（方案 M1.4 原定 `styles/update-dialog.css`），AGENTS.md 样式表亦未记 | 迁 `src/styles/update-dialog.css` + `styles.css` @import |

架构变化：`UIState.configReady` 新信号（loadConfig 完成置位，不进会话快照）；`updateTiming.clearLastCheck()`；`downloadAndInstall` 签名 +`expectedVersion`；Rust `find_latest_preview_tag` 语义由「API 顺序第一个」改「semver 最大」。

测试新增：Rust 2（`picks_highest_version_not_first_in_api_order` / `version_comparison_is_numeric_not_lexical`）；前端 `updateTiming.clearLastCheck` 1（含清账后 shouldAutoCheck 立即放行断言）；`channel.test.ts` 重写为 `channelLabelKey` 单测。

## 已修复 (2026-08-14 issue #12 四项：循环发送焦点免疫 · 串口热插拔状态卡死 · 软兜底裁剪半页刷屏 · 日志空行落盘)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 567/567 (28 files), `cargo check` 0 错 0 警告, `cargo test --lib` 128/128。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useCyclicSend.ts` + `usePanelCyclicSend.ts` | 循环自动 TX 只会在**当前激活的窗口/webview** 发送；切换聚焦（弹窗置顶遮挡主窗 → WebView2 隐藏窗口节流 setTimeout 链；切换标签至未连接端口 → 守卫杀死循环）后自动发送失效：① effect 闭包捕获 `activeTabId`、依赖含 `activeTabId`/`isPortActive`/`isConnected`——切标签即 teardown 重启，目标端口未连接时 `ref.stopped=true` 且运行标志保持 true（按钮点亮但永不发）；② 全局单例 `isLoopSending`——循环只能作用于活动标签，无法**多端口并行**压测；③ 主窗 `useCyclicSend` 与弹窗 `usePanelCyclicSend` 都是裸 `setTimeout` 链，无 visibility 兜底 | **重构为每端口独立循环引擎**：store 运行标志改 `cyclicLoops: Record<portId, boolean>`（新 action `setCyclicLoop`），runtime 目标端口**启动时绑定、聚焦无关**——COM3 启动后切标签/窗口 COM3 继续发，切回 COM3 按钮变回「停止」可手动停；多端口各自独立 runtime 并行发（压测多端口灌数据）；引擎每 tick 实时读取端口状态（目标不可用 → 跳过 tick 500ms 重试，不推进索引）；新增 `visibilitychange` 监听——窗口恢复可见且 tick 已到期（被隐藏节流）时**立即补发**（与 rxPipeline 的 issue #6-10 模式对齐）；弹窗文本循环 `usePanelCyclicSend` 同步加 `nextFireAt` + 可见性补发 |
| HIGH | `useSerialPorts.ts` `mergePorts` + `serial/mod.rs` `open_real_port` | 串口热插拔导致侧边栏状态报错且「刷新按钮治不了，只能退出重进」：① `mergePorts` 第 45 行无条件保留 `prev.status`——一次失败的 open（如热插拔竞态下 open 报错）写的 `status:'error'` 被每次轮询**永久重建**，而刷新按钮与 3s 轮询走同一条 `refreshPorts`→`mergePorts` 链，永远救不回；② union-back（60-67 行）把已消失的 `connected` 端口**无限期**插回列表——拔出后读线程因空闲永不报错（无 disconnected 事件），幽灵端口常驻；③ 后端 `open_real_port` 陈旧句柄守卫：`running==true` 就报 `already open`，设备已拔出时读线程可能仍停在 timeout 循环，重插后永远开不了 | ① `mergePorts`：fresh 枚举命中且旧状态为 `error` 时**重置为 disconnected**（connected/connecting 仍保留）——刷新按钮从此能真正修复卡死状态；② union-back 加**连续缺失计数**（模块级 `ghostMissingPolls` Map，`MAX_MISSING_POLLS=3` 轮 ≈9s 宽限），超限即放弃保留——容忍瞬时 USB 抖动，不产生永久幽灵；③ `open_real_port` stale 守卫**交叉核对系统枚举**（`list_ports()`）：设备已消失 → 当作幽灵回收（置 `running=false` + join 读线程 ≤100ms 读超时上界）后重开，设备仍存在 → 才报 `already open` |
| HIGH | `useTerminalStore.ts` `trimIfOverBudget` | 多串口压测时日志只加载半页就被**前半页刷新掉**：总预算软兜底读 5s 轮询的**应用 RSS**（含 webview），一旦 ≥ memoryLimitMb（默认 2048MB）就**每个 append 批**都把该端口缓冲裁到 50%——RSS 不会因裁剪立即回落，条件持续满足 → 缓冲被反复对半切，用户视野里"刚加载的半页又被前半页顶掉" | 软兜底路径加双闸：① **只裁本端口缓冲已相当可观的端口**（`totalBytes > maxBytes/2`）——小缓冲不是 RSS 超限的元凶，裁它只制造"半页刷屏"；② **每端口 10s 冷却**（模块级 `lastSoftTrimAt` Map，与 toast 节流同量级）——不再每个 append 批都裁。硬约束（`totalBytes>maxBytes` / `lines>maxLines`）保持无条件立即裁（真正上限必须时刻生效）。store 纯状态原则不变（冷却表在 store 外，通知仍由 RxPipeline 接线层弹） |
| MEDIUM | `logger/mod.rs` | 落盘日志文件有大量**空日志**：① `LogLineAssembler` 对连续分隔符/行首行尾分隔符产出**空块**，`write_rx` 无条件逐块 `write_line` → 每块写一行 `[ts] RX \n` 空行；② 直写路径（TX）空 data / 只含行结束符的 data（decode 后 trim 为空）同样写成 `[ts] TX \n`；③ 连接即开文件（`create(true)`），无任何数据也会留下 0 字节空文件 | ① `write_line` 顶部空 data 直接返 `Ok`（覆盖 RX 空块 + TX 空发送）；string 格式 decode 后 `text.is_empty()`（`\r\n`-only 内容）同样跳过；② `write_rx` 空块经 `write_line` 守卫自然过滤；③ `close_writer` 时 `current_size==0` 且磁盘 0 字节 → **删除空文件**，不给磁盘留空日志 |

架构变化：`useCyclicSend` 重构为**每端口独立循环引擎**——store 运行标志由单布尔 `isLoopSending` 改为每端口 `cyclicLoops: Record<portId, boolean>`（新 action `setCyclicLoop`），runtime 目标端口在启动时绑定、聚焦无关，多端口可并行；`SendSection.handleToggleLoop` 按聚焦端口查询/启停；`useCyclicSend` 的 options 简化为仅 `sendData`（链接 OperationPanel 同步删参）；`usePanelCyclicSend` ref 新增 `nextFireAt`；`mergePorts` 新增模块级幽灵计数；`open_real_port` 幽灵回收路径（join ≤100ms 仅在罕见热插拔路径）；`trimIfOverBudget` 新增 portId 参数。

测试新增：前端 useOperationStore setCyclicLoop 4（启用/停用/多端口独立/空 id no-op）、useAppStore setCyclicLoop 1、useSerialPorts 4（error 重置 / connecting 保留 / 幽灵 3 轮后消失 / 重出现清计数）、useTerminalStore 3（软兜底大缓冲裁 / 小缓冲不裁 / 冷却门控 + 硬约束立即裁）；后端 logger rx_log_tests 5（连续分隔符空块跳过 / 空 TX 全格式跳过 / hex 空跳过 / 0 字节文件关闭删除 / 有数据文件保留）+ `test_auto_save_off_short_circuits_write` 断言改为「空文件被删除」。

## 已修复 (2026-08-08 0.5.0 发布后反馈：GIT:BASH 快捷发送多执行一行空命令——TTY 写 pty 回车归一)

> 验证: `cargo check` 0 错 0 警告, `cargo test --lib` 123/123, `npx tsc --noEmit` 0 错。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `serial/mod.rs` | GIT:BASH（模拟 TTY）快捷发送后**多执行一行空命令**（0.5.0 发布后反馈）：快捷发送按命令集行结束符发送，默认 `\r\n`——pty 行规程（ICRNL）把 `\r` 转成 `\n`，bash 收到 `cmd\n\n`（**两个换行**）：执行完命令还多收到一个空行回车 | `SerialManager::send_data` GIT: 分支行结束符归一：新纯函数 `normalize_tty_line_ending`——`\r\n` → `\r`（真实终端 Enter，ICRNL 转回单个 `\n`），`\r`/`\n`/`None` 原样保留；覆盖快捷发送/循环发送/触发自动回复/弹出窗全部 TX 路径（均经 `send_data`）；`build_tx_bytes` 与日志字节同步归一 |

架构变化：无（后端发送路径内归一，前端零改动）。

测试新增：`normalize_tty_line_ending` 映射 1 例 + 归一后实际写入字节 1 例。

## 已修复 (2026-08-08 issue #11 复审修复 + 会话跨标签保留：TTY 模式持久化断路 · 字体切换清空缓冲 · disable 同步 join · 断线解码器残留 · resize 取整 · 会话跨标签保留)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 557/557 (28 files), `cargo check` 0 错 0 警告, `cargo test --lib` 121/121。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `config/mod.rs` | TTY 模式持久化断路（issue #11 复审）：前端 `PortMetaEntry.mode` 随 `save_port_meta` 发送，但 Rust `PortMetaEntry` 只有 `port_id`/`alias`/`is_hidden`——serde（未设 `deny_unknown_fields`）**静默丢弃未知字段**，config.json 永不落盘 → 重启后 TTY 端口全部回退 TRX（文档声称「经 port_meta 持久化」与实现不符；TS 测试不穿过 invoke 边界、Rust 测试只 roundtrip alias/isHidden，均未拦截） | Rust `PortMetaEntry` 补 `#[serde(default)] pub mode: Option<String>`（缺省 None = trx）+ `validate_and_clamp` 钳制非 `trx`/`tty` 值回 trx；roundtrip 测试覆盖 mode 往返 / 旧版缺省回退 / 前端 JSON 携 mode / 钳制三类回归 |
| HIGH | `MainDisplay/TtyView.tsx` | 字体/字号变更清空整个 TTY 终端缓冲（issue #11 复审）：挂载 effect 依赖含 `terminalFont`/`terminalFontSize`，改动即 cleanup `term.dispose()` 重建——注释声称「不随配置重建」与实现矛盾；TRX 侧经 CSS 变量无此问题 | 挂载 effect 依赖收窄为 `[portId]`；新增独立 effect 经 `term.options.fontFamily/fontSize` **活更新**（不重建、不丢缓冲）；补 Ctrl+滚轮缩放（8–48px，镜像 TerminalView，同步 config + `--font-size-terminal`） |
| MEDIUM | `commands/tty_sim.rs` | `disable_gitbash_sim` 同步命令内 `thread.join()` 阻塞主线程（issue #11 复审）：a3a5db3 已把 `close_serial_port` 改 async + `spawn_blocking` join 防「断开卡死」，此处未对齐 | `disable_gitbash_sim` 改 async + `tokio::task::spawn_blocking` join；一次持锁关闭全部 GIT: 端口取出 JoinHandle，锁外统一 join |
| MEDIUM | `utils/ttyService.ts` | 三处 P2（issue #11 复审）：① `lastTs` 死字段（注释「暂未消费」）；② `disconnect` 保留流式解码器——断线残留的半截多字节 UTF-8 字符会在重连后与下一连接首字节拼出错误字符（TRX 侧 `pipeline.disconnect` 全量丢弃 per-port 状态，语义不一致）；③ `resize` 先校验后取整——`Math.round(0.4)=0` 会被存进 state 并推给后端 ConPTY | ① 删 `lastTs` + `feed` 去掉无用的 `ts` 参数（同步调用点与 18 处测试调用）；② `disconnect` 重建 `decoder`；③ 先取整再校验（取整后的 0/负数同样拒绝）；附加：`detach` 保留 `lastCols/lastRows`（丢弃队列/decoder/term），切走标签再重开 GIT:BASH 不再回退 80×24 首帧错乱 |
| MEDIUM | `MainDisplay/Pane.tsx` + `TtyView.tsx` + `tty.css` | TTY 会话跨标签切换丢失（issue #11 遗留）：`key={displayTab.id}` 使切标签即卸载 `TtyView` → `term.dispose()` 清空 xterm 缓冲（TRX 缓冲在 store 天然保留）；重开 GIT:BASH 还因 `detach` 清尺寸回退 80×24 | Pane 终端区改「**TTY 常驻挂载 + TRX 按需挂载**」：当前 Pane 内所有 TTY 标签各渲染一个 `TtyView`（`key={tab.id}` 稳定），非活动标签传 `hidden` → `.tty-view-hidden`（display:none）；`TtyView` 恢复可见时显式 rAF `fit()` + ResizeObserver 兜底；`displayPort?.mode !== 'tty'` 才渲染 TerminalView。残留限制（文档化）：模式切换/关闭标签/跨 Pane 拖拽仍销毁实例（xterm `open()` 只能调用一次） |

架构变化：`PortMetaEntry` 新增 `mode` 字段（Rust serde 契约，前端类型早已对齐）；`TtyView` 新增 `hidden` prop + `fitRef`（恢复可见 re-fit 效果）；`ttyService.feed` 签名去掉 `ts` 参数；`Pane` 终端区渲染逻辑改为 TTY 常驻挂载。

测试新增：Rust config `test_port_meta_entry_roundtrip_and_defaults` 扩 mode 往返 + 新 `test_validate_and_clamp_port_meta_mode`；前端 ttyService 2 例（disconnect 重建解码器、detach 保留尺寸）。

## 已修复 (2026-08-06 issue #7 十项：通知中心串口上下文+时间戳 · 快捷面板按钮样式 · 发送前缀默认空 · 快捷面板 REAL 后缀/状态灯 · 发送区控件位置 · 设置移除参数预设 · 去「一键」文案 · 分组工具并行 · 自定义右键菜单)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 530/530 (27 files), `cargo check` 0 错 0 警告, `cargo test --lib` 112/112, `npx playwright test` 14/14。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| MEDIUM | `useToastStore.ts` + `NotificationCenter.tsx` + `useSerialReceive.ts`/`useSerialSend.ts`/`useSerialConnection.ts` | 通知中心消息无来源与时间上下文（issue #7-1）：条件触发告警/断线等串口消息不带串口号，通知无法分辨来自哪个串口、何时发生 | `ToastItem`/`ToastPushInput` 新增可选 `portId`；串口相关 push 全部携带 portId（触发告警、端口意外断开、发送目标端口关闭、自动重连失败）；通知中心每行渲染串口 chip（`.notify-row-port`）+ 时间戳（`.notify-row-time`，HH:MM:SS） |
| MEDIUM | `SendSection.tsx` + `operation-panel.css` | 快捷发送条「打开命令面板」按钮样式像带状态的图标按钮、太矮（issue #7-2）：与命令药丸两行高度不齐，可点击性弱 | 按钮改**按压按钮样式**：accent 填充（同 `.btn-primary` 视觉）+ 文字标签 `quickSend.openPanelShort`（命令面板），`min-height: 34px` 与两行药丸对齐 |
| LOW | `useAppStore.ts` / `config/mod.rs` + 测试 | 终端已有 TX/RX 方向标识，发送提示前缀 `>>>>>>SEND>>>>>>>>` 冗余（issue #7-3） | `sendPrefix` 默认值改空（功能保留，DisplaySettings 可配）；TS/Rust 默认值、config 单测、configMerge 测试同步 |
| LOW | `Popout/QuickSendPanel.tsx` | 快捷发送面板目标串口下拉显示 `COM3 · REAL` 类型后缀，无意义（issue #7-4） | option 只显示 `p.name` |
| MEDIUM | `Popout/QuickSendPanel.tsx` + `popout.css` + `usePopoutBridge.ts` + `tauri.ts` | 快捷发送面板「发送到」提示灯恒绿呼吸、不反映真实连接状态（issue #7-5）：端口断开仍显示绿色 | 弹窗订阅全局 `serial:status` 维护已连接集合（`connectedPortIds`）；新 `port-statuses:sync` 事件（主窗 request-sync 时回放全量端口状态）解决「已连接状态下打开弹窗」初始态；`.quicksend-dot` 默认灰色、`.is-connected` 绿色呼吸 |
| LOW | `operation-panel.css` | 发送区命令集选择/循环/编辑三控件被 `margin-left: auto` 推到行尾，与「发送命令」标题割裂（issue #7-6） | 移除 `margin-left: auto`，控件紧跟标题文字之后 |
| LOW | `GeneralSettings.tsx` + `i18n.ts` | 设置界面重复管理「串口参数预设」（issue #7-7）：操作面板参数区已有完整的预设管理（保存/应用/删除） | 移除 GeneralSettings 预设区块（state/handlers/JSX）与 `generalSettings.presets.*` 6 个 i18n key |
| LOW | `i18n.ts` | 「一键XXX」冗余描述（issue #7-8）：直接描述操作即可 | 去「一键」：打开全部/关闭全部/连接整组/断开整组/清空 |
| MEDIUM | `usePortToolActions.ts` | 分组整组执行外部工具串行 100ms 节流（issue #7-9）：多端口组等前一个跑完才轮到下一个 | `runConfiguredPorts` 改 `Promise.all` **并行**启动所有已配置端口（仍跳过运行中端口，单端口失败不中断整组） |
| MEDIUM | 新 `shared/TextEditContextMenu.tsx` + `App.tsx`/`PopoutShell.tsx` + `context-menu.css` + `i18n.ts` | 输入框/文本域/可编辑区域仍弹 webview 原生右键菜单（issue #7-10）：App 全局 contextmenu 屏蔽对 INPUT/TEXTAREA 放行，快捷发送面板等独立窗口更是完全未屏蔽 | 新 `useTextEditContextMenu()`：document 级监听——可编辑目标 → `preventDefault` + 显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`document.execCommand` 执行，右键时快照选区、点击项时先恢复焦点+选区再执行）；非可编辑目标一律 `preventDefault`（取代旧 effect）。App 根 + PopoutShell 各挂一次；菜单复用 `.context-menu` 样式；`contextMenu.*` 6 个 i18n key |

架构变化：`ToastItem` 新增可选 `portId`；新 popout 事件 `port-statuses:sync`（`PortStatusSyncItem[]`，request-sync 回放全量端口状态）；新共享组件 `TextEditContextMenu`/`useTextEditContextMenu`（App + PopoutShell 双 webview 根挂载，替代 App.tsx 旧 contextmenu effect）；`runConfiguredPorts` 改并行。移除 `generalSettings.presets.*` 6 个 key；新增 `contextMenu.*` 6 个 + `quickSend.openPanelShort` 1 个 key。

测试新增：前端 useToastStore portId/createdAt 3 例；config 默认 sendPrefix 断言更新；e2e 4 例（通知中心串口 chip+时间戳、无规则时通知空态、文本框自定义右键菜单、非可编辑区域无原生菜单）。

## 已修复 (2026-08-06 issue #6 遗留：TX 后长时间收不到响应根因——读写句柄拆分 + 无界 flush 摘除 + 前端隐藏排空)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 527/527 (27 files), `cargo check` 0 错 0 警告, `cargo test --lib` 112/112, `npx playwright test` 10/10。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `serial/mod.rs` + `commands/serial.rs` | TX 后长时间收不到响应（issue #6-10）：① TX 的 write_all+flush 与 RX 读线程共用同一把 per-port `Mutex<Box<dyn SerialPort>>`；② Windows `flush()` = `FlushFileBuffers` 无超时、受流控约束（CTS 拉低/XOFF 时无界阻塞）——阻塞期间端口锁被 TX 独占，RX 读线程被饿死，设备响应早已到达 OS 接收缓冲却直到 TX 释放锁才被读出；③ 附带：TX 阻塞期间还持有全局 serial_manager 锁，端口列表轮询/其它端口命令被卡 | 方案1：`SerialPortHandle` 经 `try_clone()`（Windows = DuplicateHandle，crate 以 dwShareMode=0 打开故不能二次 CreateFile）拆 read_port/write_port 双句柄——读线程只锁读、发送只锁写，TX 阻塞不再饿死 RX；方案2：热路径摘除 `flush()`（唯一无界阻塞点）+ 新 `write_all_with_deadline` 总写期限（`WRITE_TOTAL_DEADLINE` 2s，Ok(0) 立即报错、TimedOut 重试到期限、Interrupted 继续，防长 payload 无限循环）；发送改**两段式**——全局锁内 `get_write_handle` 只做 HashMap 查找 + Arc 克隆，锁外只持 per-port 写锁写（不再持全局锁执行写）；`set_params`/`set_flow_control` 同时锁读写句柄（DCB/COMMTIMEOUTS 设备级、两句柄共享，改参避开另一句柄 I/O） |
| MEDIUM | `rxPipeline.ts` | 前端管线排空依赖 rAF（issue #6-10 补漏）：document.hidden 时 rAF 停摆，队列里的行永远写不进 store；隐藏窗口长时间 RX 无界积压 | 方案3：默认调度器 visibility-aware（页面可见且 rAF 可用 → rAF；隐藏/无 rAF → setTimeout(16ms) 兜底排空）+ 构造时注册 `visibilitychange` 监听（隐藏 → 取消未触发 rAF tick 按当前可见性重排；可见 → 重排回 rAF）+ 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢弃**最旧**）；`defaultCancelFlush` 改同时调用 cancelAnimationFrame + clearTimeout（两种句柄命名空间不同、对错误 id 均静默 no-op，保证 visibility 切换后的 tick 总能真正取消） |

架构变化：`SerialPortHandle.port` → `read_port`/`write_port` 双 `Arc<Mutex<..>>`；热路径不再调用 `flush()`；新模块级 `write_all_with_deadline` + `pub const WRITE_TOTAL_DEADLINE`；新 `SerialManager::get_write_handle`；`send_serial_data`/`send_file`（逐 chunk）改两段式发送（SIM 仍锁内 channel 发送）；`RxPipeline` 新增 `maxQueuedLines`/`isDocumentHidden` 注入 + visibilitychange 监听（dispose 移除）。

测试新增：后端 `write_all_with_deadline` 6 例（正常写/部分写/0 字节/恒 TimedOut 超时/Interrupted 重试/空 payload，纯 std mock 在 Windows 亦可运行）+ `get_write_handle` 错误路径 1 例（非 Windows）；前端 rxPipeline 8 例（队列上限 4 + visibility-aware 4）；e2e 2 例（RX 数据渲染 + 隐藏窗口排空，TAURI_MOCK 扩展事件分发）。

## 已修复 (2026-08-06 issue #6 九项：发送异步化 · 双层内存预算+rawData 瘦身+写量限制 · 文本模式新按钮 · 排序一次性 · 串口右键分组 · 进程级内存 · 通知框加大 · 框选不关闭 · 两行 pill)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 519/519 (27 files), `cargo check` 0 错 0 警告, `cargo test --lib` 106/106, `npx playwright test` 8/8。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `commands/serial.rs` + `lib.rs` | 每次 TX 无条件卡顿 + 白屏警告（issue #6-1）：`send_serial_data` 是**同步命令**，在事件循环主线程执行 write_all+flush+日志写——每次发送阻塞 UI，高频收发时刷 tao `NewEvents`/`RedrawEventsCleared` 警告乃至白屏 | `send_serial_data` 改 async fn + `tokio::task::spawn_blocking`（串口 IO 与日志写移出事件循环主线程）；`AppState.serial_manager`/`log_manager` 改 `Arc<Mutex<..>>`（Deref 使 `.lock()` 调用点零改动、闭包可持 'static 句柄）；`send_file` 本就是 async（tokio::fs::read + 分块 yield），无同类主线程阻塞 |
| HIGH | `useTerminalStore.ts` / `types/index.ts` / `rxPipeline.ts` / `rxAssembler.ts` / `config/mod.rs` | 终端缓冲与 RX 管线内存无上限（issue #6-2）：rawData 用 number[]（每字节 8× 开销 + 解码临时拷贝）；缓冲只按行数裁剪、无字节记账；RX 每帧批写无写量上限——高频长跑内存暴涨，与 TX 卡顿同源 | ① rawData 改 `Uint8Array`（内存 8 倍削减 + 免解码临时拷贝），`setTerminalEncoding` 直接 decode，`TerminalRow`/`terminalSearch`/`protocolRenderer` 用 `Array.from`（Uint8Array 无 `.map`）；② `TerminalState` 新增 `totalBytes`（字节记账）/`maxBytes`（每端口预算字节），`appendTerminalLine(s)` 返回 boolean（true=触发裁剪），超预算**一次性裁到 50%**（不再逐行 shift），`clearTerminal`/`setTerminalLines` 重算 totalBytes；③ 双层内存预算：`memoryLimitMb` 语义改「整个应用（含 webview）总预算」默认 2048MB（软兜底）+ 新 `memoryPerPortBudgetMb` 默认 200MB（每端口硬约束，`maxLines = 预算×500`），Rust `AppConfig.memory_per_port_budget_mb`（`#[serde(default=...)]` 兼容旧 config）+ `validate_and_clamp` [16,2048]、`memory_limit_mb` clamp [64,8192]；④ 裁剪触发优先级：每端口硬约束优先、总预算软兜底（`systemStatus.memoryUsedMb` 超限也裁），「因内存限制清屏」toast（`toast.memoryTrim`，每端口 10s 节流）由 **RxPipeline 接线层**在 store 返回 true 时弹出（store 保持纯净，避免 useToastStore→i18n→useAppStore 循环依赖）；⑤ 写量限制 `maxLinesPerTick`（默认 2000）：每帧每端口最多写 N 行、`flushNow` 同步最多排空 N 行其余 rAF 续写 |
| MEDIUM | `Popout/QuickSendPanel.tsx` | 文本模式逐行调试无「执行当前行并下移」能力（issue #6-3）：点执行当前行后光标停在原行，逐行核对命令需手动点选下一行 | 新增「执行当前行并移至下一行」按钮：`runCurrentLineAndAdvance`（执行当前行后 `moveCursorToNextLine` 经 textareaRef 把光标/选区移到下一行行首）；i18n `quickSend.runCurrentLineAdvance` |
| MEDIUM | `useAppStore.ts` + `Sidebar.tsx` + `utils/portSort.ts` | 排序依赖持久开关且禁用拖拽/分组（issue #6-4）：开启排序后拖拽与分组入口不可用，排序态随配置持久化、行为不直观 | 排序改**一次性动作** `sortPortsByNumber()`：直接重排 store 的 ports + 各分组 portIds（自然序，幂等、不重置 groupId）；Sidebar **移除 sortMode 持久开关**，拖拽/分组始终可用；组内顺序随 `save_port_groups` 持久化、未分组顺序不保存 |
| MEDIUM | `Sidebar.tsx` + `useAppStore.ts` | 串口右键菜单无分组控制入口（issue #6-5）：分组/移组只能拖拽，批量归类或移出繁琐 | 菜单项按端口分组态动态渲染：未分组且有组→逐组「移入分组『{{name}}』」；未分组无组→「新建分组并移入」；已在组里→「移出分组」；i18n keys `sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}` |
| MEDIUM | `commands/system_cmds.rs` | 内存显示再次失真（issue #6-6）：#5-5 改系统级后无法看出应用自身（含 webview 子进程）的内存占用，内存预算软兜底也无从判断 | 内存改**应用进程树级**：本进程+全部后代进程（含 WebView2/Chromium 子进程）RSS 之和——新纯函数 `collect_app_pids`（可注入进程表便于单测）+ `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`；CPU 仍系统级；`load_status` 阈值语义不变 |
| LOW | `notification-center.css` | 通知中心面板偏小（issue #6-7）：宽 320 / 高 340 容纳长告警文案与多条通知局促 | `.notify-panel` 320→360px 宽、340→400px 高 |
| LOW | `ConfigModal.tsx` | 设置弹窗内框选文字松手在遮罩上误关弹窗（issue #6-8）：overlay click 即关闭，复制参数/内容时松手出界丢失弹窗 | overlay pointerdown 记录起点是否在弹窗内；click 时起点在弹窗内则忽略关闭（只响应按下+松开都在遮罩上的点击） |
| LOW | `SendSection.tsx` + `operation-panel.css` | 快捷发送 pill 名称+内容挤一行，窄窗口下内容截断看不清（issue #6-9） | pill 改 flex column 两行：`.op-quick-cmd-name-row`（HEX 徽标+名称同行）在上、`.op-quick-cmd-content` 内容在下 |

架构变化：`TerminalLine.rawData` 由 number[] 改 `Uint8Array`（TX `txRawData` 同样）；`TerminalState` 新增 `totalBytes`/`maxBytes` 字节记账，两个 append 返回 boolean；`RxPipeline` 新增 `maxLinesPerTick` 写量限制 + 内存裁剪 toast 接线（`toast.memoryTrim` 每端口 10s 节流）；`AppConfig` 新增 `memory_per_port_budget_mb`（`memoryLimitMb` 语义改为应用含 webview 总预算软兜底）；`AppState` 字段改 `Arc<Mutex<..>>`；`send_serial_data` 改 async + `spawn_blocking`；`get_system_status` 内存改应用进程树级（新 `collect_app_pids`）；新 store action `sortPortsByNumber()`，Sidebar 移除 sortMode 持久开关；串口右键菜单新增 3 个分组控制项；QuickSendPanel 文本模式新增执行+下移按钮；ConfigModal overlay 关闭判定加按下起点检查；`.notify-panel`/`.op-quick-cmd` 样式调整。

测试新增：前端 useTerminalStore 字节记账/裁剪 4、useAppStore sortPortsByNumber 3、rxPipeline maxLinesPerTick 3；后端 config 内存预算缺省回退+clamp 4、system_cmds 进程级内存纯函数（collect_app_pids/memory_used_mb/load_status）扩展。

## 已修复 (2026-08-06 issue #5 十项：滚动锁定跟随重构 · 配置持久化审计 · 条件触发三缺陷+通知中心 · 发送区大改版 · 状态栏内存 · 行尾提示不跟随 · 分组整组执行工具 · 输出区点击切换面板目标 · 保存 log 首字符独占一行 · 日志子目录)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 506/506 (27 files), `cargo check` 0 错 0 警告, `cargo test --lib` 103/103, `npx playwright test` 6/6。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `TerminalView.tsx` + 新 `utils/followLogic.ts` | 滚动锁定跟随不稳 + 日志噪音（issue #5-1）：跟随路径 `scrollToIndex(count-1, align:'end')` 用未测量尾行的 estimateSize，@tanstack 进入 10 次重试循环，刷 "Failed to scroll to index" | `scrollToBottom` 重写：跟随路径**弃用 scrollToIndex**，改双 rAF 原始 `scrollTop = computePinTarget(scrollHeight, clientHeight)` 测量钉底（gestureActiveRef 守卫），`countRef` 删除；settle/抑制/锁定迁移逻辑下沉纯函数 `followLogic.ts`（`isAtBottom`/`computePinTarget`/`becameLocked`/`shouldFollow`）；用户主动的到顶/搜索跳转仍走 scrollToIndex；4 处 scrollLocked 写点 + 无 onScroll 隐式解锁不变量保持 |
| HIGH | `ConfigModal.tsx` / `DiagnosticLogDialog.tsx` + 新 `utils/configMerge.ts` | 配置持久化审计（issue #5-2）：ConfigModal 底部保存与诊断日志开关做 `saveConfig(store.config)` 全量 `set_config`，而 store.config 实体数组是**启动快照**、从不与 `useRuleStore` 同步 → 全量保存用陈旧数据整体替换 config.json（清掉命令集/高亮/协议/触发/工具编辑） | 新纯函数 `mergeLiveRuleEntities(config, ruleStore)`：把 useRuleStore 的 5 个活实体（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs）合并进快照后再保存；ConfigModal.handleSave 与 DiagnosticLogDialog diag 开关接入。同时移除 CommandSettings/HighlightSettings/ProtocolSettings/ToolSettings 的 `rows.length > 0` 加载守卫（无条件 set，删除的集不再复活）；线名对齐 `diagnosticLogEnabled` → `diagLogEnabled`（Rust 一直序列化后者，旧开关是死控件，现已生效）。已知边界：`portPresets` 无 store 镜像（仅 store.config + 设置页本地态）；`portGroups`/`portMeta` 已由 useAppInit 同步（#4-10 模式） |
| HIGH | `useToastStore.ts` + 新 `StatusBar/NotificationCenter.tsx` / `TriggerSettings.tsx` / `useSerialReceive.ts` | 条件触发三缺陷（issue #5-3）：① alert 只弹通用文案、不含规则内容；② 触发规则编辑后不落盘，重启丢失；③ toast 队列满（>5）直接丢弃告警 | ① alert toast 改显示 `rule.actionContent`（缺省回退 `trigger.alertMessage`），sticky（`durationMs: 0` 不自动关闭），标题带端口/规则上下文，1s 节流保留；② TriggerSettings 新增 300ms 防抖自动保存：`handleAdd` fire-and-forget `saveTriggerRule` + watcher 按 `savedSnapshotRef` diff 逐条落盘，关闭弹窗 flush 窗口内未保存编辑；③ 通知中心：`useToastStore` 扩展 `ToastItem.title?`、`durationMs===0` 粘滞（Toast.tsx 跳过自动关闭计时）、超 `MAX_VISIBLE=5` 进 `stashed` 溢出队列不丢弃、`clearAll()`、`setCenterOpen`/`centerOpen`；新 `NotificationCenter.tsx`（铃铛+badge+弹层，live+stashed 最新优先、逐条关闭、清空、空态、外点/Escape 关闭）挂载于 StatusBar `.statusbar-right`，样式 `notification-center.css` |
| HIGH | `SendSection.tsx` + `Popout/QuickSendPanel.tsx` 重写 + 新 `usePanelCyclicSend.ts` / `utils/sendStrip.ts` / `utils/textSend.ts` / `utils/sendGuard.ts` + `useSerialSend.ts` | 发送区旧缺陷 + 功能缺口（issue #5-4）：① 快捷条只显示命令名，内容要靠 tooltip；② 可见数量静态、与面板宽度无关；③ QuickSendPanel 只能点选发送、无编辑入口，编辑要跳设置页；④ 向未打开端口发送静默失败无提示 | ① 快捷条每 pill 显示名称+内容（`op-quick-cmd-name`/`op-quick-cmd-content`）；② 可见数改**宽度动态**（ResizeObserver + 隐藏测量行 + `computeFitCount`，`quickSendInlineCount` 配置语义收窄为 0=隐藏条）；③ 首槽固定「打开命令面板」按钮（PanelRightOpen，`quickSend.openPanel` → `popoutService.openPopout('quick-send')`），`⋯ +N` 溢出保留；④ QuickSendPanel 重写为双模式：列表模式（搜索/选中发送 + 行内编辑 名称/内容/行结束符/STR·HEX，走 `updateSendCommandSet`+`saveCommandSet` 落盘）+ 文本模式（大文本域逐行发送，4 种运行方式：当前行/全部顺序/从光标/循环至停止，新 `usePanelCyclicSend` 递归 setTimeout，`{running, currentLine, start, stop}`，卸载/内容编辑自动停，跳过空行与非法 HEX，新 `textSend.ts` `splitSendLines`/`isValidHexLine`/`clampInterval`）；共享参数栏（目标端口可选，弹窗经 `listAvailablePorts()` 默认活动标签、行结束符统一 `LINE_ENDING_VALUES`、STR/HEX 切换，文本模式加发送间隔/轮间隔，`TextSendConfig` 存 localStorage）；⑤ `sendToPort` 增加 `sendGuard.ts` 守卫（`isSendablePort`/`portClosedReason`）：非静默发送到缺失/断开/连接中/错误端口推 `sendSection.portClosedWarning` toast 并返回 0，静默发送（循环/触发自动回复）静默返回；路由缝 `usePopoutBridge` send-command 用 `payload.portId ?? activeTabId`（`PopoutSendCommandPayload` 新增 `portId?`） |
| MEDIUM | `commands/system_cmds.rs` | 状态栏内存显示恒平（issue #5-5）：`process(pid).memory()` 取**应用自身进程** RSS，webview 内存在独立进程未计入，读数单调不变 | 改用系统级 `system.refresh_memory()` + `system.used_memory()/1048576`（含全部进程）；新纯函数 `memory_used_mb(used_bytes)` / `load_status(cpu, used_mb, limit_mb)` + 10 个单测 |
| HIGH | `SendSection.tsx` / `DisplaySettings.tsx` / `SendCmdEditor.tsx` + `utils/sendUtils.ts` | 行尾提示不跟随、字节数/发送字节错（issue #5-6）：`<option value="\r\n">` 在 JSX 属性里不转义，运行时是 6 字符字面量 `\\r\\n`，与域值 4 字符 `\r\n` 不等 → `formatLineEndingHex`/`getLineEndingBytes` 落到默认分支，切换行结束符后提示/字节数/发送字节全错 | 三处改 `value={'\r\n'}` 表达式字面量；新共享 `LINE_ENDING_VALUES` + `lineEndingLabelKey(v, ns)`（sendUtils.ts）+ 回归测试 |
| MEDIUM | `Sidebar.tsx` + 新 `shared/GroupToolDialog.tsx` / `utils/groupTool.ts` + `usePortToolActions.ts` | 分组无整组执行外部工具入口（issue #5-7）：烧录类工具需逐端口右键，多端口组操作繁琐 | 分组右键菜单新增 `sidebar.group.contextMenu.runTool` → `GroupToolDialog`（模型同 DirChangeDialog，列配置/未配置端口，按钮：取消 / 配置缺失（跳外部工具设置页）/ 仅运行已配置）；严格配置判定 = 配置存在 + portId 匹配 + `command.trim() !== ''`；`usePortToolActions` 新增 `runToolForGroup(group)` 顺序 100ms 节流执行（跳过运行中端口） |
| MEDIUM | `Pane.tsx` / `useAppStore.ts` | 输出区点击不切换操作面板目标（issue #5-8）：多标签下点击任一终端内容，发送区仍指向旧活动标签 | `TerminalView` 挂载点外包 `.pane-terminal-wrap` div onClick → `setActiveTab(displayTabId)`（getState 比较守卫，防陈旧闭包），setActiveTab 同时写 focusedPaneId（焦点跟随）；不放容器 onClick（陈旧 displayTabId 闭包会吞标签点击）、不放 TerminalView 内部（与弹出窗共用）；样式入 main-display.css；store 测试补 setActiveTab（写两字段）/setFocusedPane（不动 activeTabId） |
| HIGH | `logger/mod.rs` + `serial/mod.rs` | 保存日志首字符独占一行（issue #5-9）：`emit_data_event` 按读取块（≤1024B）原始字节直写日志，一条日志一行，而终端显示的是 RxLineAssembler 组装行 | 新 Rust `LogLineAssembler`（字节级 CR/LF/跨事件 CRLF 合并/pendingCR/4096 强制 flush/take_tail，镜像前端 rxAssembler）；`PortLogWriter` 增加 assembler + `rx_pending_since`；`LogManager::write_rx(port_id, ts, data)` 组装完整行落盘（RX 方向），250ms 陈旧尾静默 flush，`close_writer` 冲刷尾部；串口读线程 RX 走 `write_rx`（TX 保持直写 `write`） |
| MEDIUM | `config/mod.rs` / `logger/mod.rs` / `commands/config.rs` / `lib.rs` / `LogSettings.tsx` | 日志无子目录选项（issue #5-10）：所有端口日志平铺同一目录，多端口+多日期难管理 | 新配置 `log_subdir_mode: 'none'|'date'|'port'`（默认 `date`，`#[serde(default = "default_log_subdir_mode")]`，非法值 clamp 回 date）；`LogManager.subdir_mode` + `set_subdir_mode` + `subdir_component()`，`create_writer_with_encoding` 路径 join（create_dir_all），`collect_log_files` 递归 list_files（MAX_LIST_DEPTH=16，深层读错 warn+skip）；同步接入 `sync_log_manager_from_config` + `AppState::new`；LogSettings 新增下拉行 |

架构变化：前端新增纯函数工具 `followLogic`/`sendStrip`/`textSend`/`sendGuard`/`configMerge`/`groupTool`；`useToastStore` 扩展 sticky/stash/clearAll/centerOpen，新增 `StatusBar/NotificationCenter`；`QuickSendPanel` 改双模式 + 新 `usePanelCyclicSend`；`usePortToolActions` 新增 `runToolForGroup` + 新 `shared/GroupToolDialog`；`sendToPort` 增加 closed-port 守卫；`TextSendConfig` 新类型（types/index.ts）localStorage 持久化；`quickSendInlineCount` 语义收窄为 0=隐藏条；线名 `diagnosticLogEnabled`→`diagLogEnabled`。后端：`logger/mod.rs` 新增 `LogLineAssembler` + `LogManager::write_rx` + 子目录支持（`LogManager` 现含 `write_rx`/`maybe_split_writer`/`periodic_flush` 私有助手）；`AppConfig` 新增 `log_subdir_mode`；`system_cmds.rs` 内存改系统级采样。

测试新增：followLogic 20 / sendStrip 16 / sendGuard 9 / textSend 21 / configMerge 4 / groupTool 7 / useToastStore 11 / Rust `rx_log_tests` 47 / `subdir_tests` 7 / `system_cmds` 10。

## 已修复 (2026-08-05 日志审计完善：错误路径补日志 + 分级合理化 + 去噪音/刷屏)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 415/415 (20 files), `cargo check` 0 错 0 警告, `cargo test --lib` 48/48。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `commands/serial.rs` / `config/mod.rs` | 后端错误路径只抛 `CommandError`、不落后端日志：开/关/发/设参数/设流控/发文件/重连/存配置失败时，诊断日志文件（后端 `log::*`）缺失根因，只能依赖前端转发 | 各命令错误分支补 `log::warn!`（开/关/发/参数/流控/发文件/自动重连），`ConfigManager::save()` 失败补 `log::error!` |
| MEDIUM | `serial/mod.rs` | 读线程异常退出（意外断线）无后端日志，只有前端事件 | 异常退出时补 `log::warn!("...read thread exited abnormally")` |
| LOW | `usePopoutBridge.ts` | 两处正常控制流分支（无活动标签/无缓冲区）当错误打 debug，属噪音 | 删除（正常分支非错误） |
| LOW | `useSerialPorts.ts` / `highlightEngine.ts` / `useSerialReceive.ts` | 潜在刷屏：端口枚举失败每 3s 一条 warn；非法正则随每批 RX；触发引擎异常随每次 RX | 端口枚举连续失败仅首次 warn、后续降 debug；非法正则以 pattern 去重只告警一次；触发异常限流每 2s 一条 |
| MEDIUM | ConfigModal 各设置页 / OperationPanel | 设置实体加载失败仅 `console.debug` 且无用户提示，用户无感知 | 提升为 `console.warn`；命令集/高亮/协议模板加载失败补 `notifyError` toast（用户持久化数据）；顺带修正 `ToolSettings` 过时的 "SQLite" 注释与 `delete ... from DB` 文案 |

测试新增：`diagLog` 解析已在上一轮补充；本次主要改日志语句，无新增测试（`cargo test` 48、vitest 415 均保持）。

## 已修复 (2026-08-05 issue #4 十项：高频滚动钉底 · 参数实时生效 · 状态栏去 LED · 去「替代」文案 · 移除帮助 demo · About 链接/版本/许可证 · 备注名与分组持久化)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 410/410 (19 files), `cargo check` 0 错 0 警告, `cargo test --lib` 42/42。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `TerminalView.tsx` | 快速大量输出时滚动锁定跟踪不及时：`scrollToIndex(count-1, align:'end')` 用未测量尾行的 estimateSize，单帧 rAF 钉底在虚拟器测得新行、totalSize 增长后仍会偏上，持续高频输出下每帧漂移数像素（issue #4-1） | `scrollToBottom` 改为**双帧 rAF 钉底**：第一帧钉到当前底部，第二帧（虚拟器已重新测量新行并增长 totalSize）再钉到真实底部；只碰 scrollTop，不碰 scrollLocked/followRef |
| HIGH | `OperationPanel.tsx` / `useSerialConnection.ts` | 串口参数不实时生效、重连回退 115200、侧边栏/标题栏不跟随（issue #4-2）：① 参数同步 effect 依赖数组缺 `baudRate`，改波特率不触发后端重配；② openPort 用 `port?.baudRate ?? opStore.baudRate`，而端口存储的 baudRate 不随操作面板更新，重连读回旧值；③ 参数变更不回写端口字段，串口管理面板/标题栏显示旧参数 | ① 订阅 `baudRate`（自定义输入走 ParamsSection 本地 draft，仅失焦提交，逐键不重渲染）并加入同步 effect 依赖；② effect 改为按「端口+参数签名」区分切换标签与参数变更：切换标签把该端口已存参数载入操作面板，参数变更时 `updatePort` 回写端口字段（侧边栏/标题栏/重连同步）+ 后端防抖实时应用（已连接时 `setSerialParams`+`setFlowControl`） |
| HIGH | `StatusBar.tsx` / `usePinStatesSubscriber` / `usePinStatesStore` / `serial/mod.rs` | 状态栏每连接串口显示 6 个引脚状态灯，USB-TTL 两针串口无意义且多端口时底栏混乱（issue #4-3） | 移除状态栏引脚 LED 显示，并端到端清理引脚状态死代码：前端 `usePinStatesSubscriber`/`usePinStatesStore`/`eventService.onSerialPinStates`/`pin.*` i18n/`pin-led` CSS；后端 `SerialPinStatesEvent` + 读线程 200ms 引脚轮询 + `dtr_state`/`rts_state` 共享字段（DTR/RTS 控制仍保留在操作面板） |
| LOW | `i18n.ts` / `README.md` / `AGENTS.md` | 「为替代 SSCOM / SuperCom 而生」等对比文案散落各处（issue #4-4） | 全部改为中性描述（`about.description` 中/英、README 首段、AGENTS 概述）；release note 不再含此类对比信息 |
| MEDIUM | `TitleBar.tsx` / `FirstRunTour.tsx`(删除) / `useHotkeys.ts` / `config/mod.rs` | 「帮助」按钮只是 demo 引导（首次运行 Tour），无用（issue #4-5） | 删除帮助按钮 + `FirstRunTour` 组件 + `tour.css` + `tour.*` i18n + `config.hasSeenTour`（后端 `#[serde(default)]` 兼容旧 config.json）+ `ui.configLoaded` + useHotkeys 中 Escape 关闭引导分支；快捷键帮助弹窗（真实功能）保留 |
| MEDIUM | `AboutDialog.tsx` | 关于界面无 GitHub 链接（issue #4-6） | 新增「GitHub 仓库」按钮，`@tauri-apps/plugin-shell` `open()` 打开 `https://github.com/crafter-z/hypercom`（capabilities 已有 `shell:allow-open`） |
| MEDIUM | `AboutDialog.tsx` / `TitleBar.tsx` / `i18n.ts` | 关于界面版本号显示 `v0.1.0 (0.3.2)`（issue #4-7）：硬编码 `titleBar.version`('v0.1.0') 叠加真实版本 | 删除硬编码版本；About 只显示 `getVersion()` 真实版本（`v0.3.2`）；删除标题栏静态版本号与 `titleBar.version` key |
| MEDIUM | `THIRD_PARTY_LICENSES.md`(新增) / `AboutDialog.tsx` / `LicensesDialog.tsx`(新增) | 技术栈依赖许可证未成文，About 无浏览入口（issue #4-8） | 新建 `THIRD_PARTY_LICENSES.md` 列全部前后端依赖与 SPDX 许可证（含双许可说明）；About 新增「开源许可证」按钮打开 `LicensesDialog`（前端/后端依赖→许可证表格，含备注指向完整文档） |
| HIGH | `config/mod.rs` / `commands/storage.rs` / `useAppInit.ts` / `services/tauri.ts` | 串口「备注名」仅存内存，重启丢失，只显示串口号（issue #4-9） | 新增 `PortMetaEntry{portId, alias?, isHidden}` + `AppConfig.port_meta`（`#[serde(default)]`）+ `save_port_meta`（整体替换落盘）+ `storageService.savePortMeta`；`useAppInit` 启动回填 alias/isHidden 到端口列表，并新增按「alias/isHidden 签名」比较的 500ms 防抖自动保存（3s 轮询重建数组但值不变不会误触发） |
| HIGH | `useAppInit.ts` | 分组重启丢失（issue #4-10）：分组走 `save_port_groups` 单独落盘，但 ConfigModal/主题切换等**全量 `set_config`** 会用 store 中陈旧的 `config.portGroups` 覆盖掉已保存的分组 | 分组自动保存落盘前同步 `setConfig({ portGroups })`（元数据保存同理），确保任何全量保存都携带最新分组；启动恢复顺序不变 |

架构变化：`AppConfig` 新增第 8 类实体 `port_meta`（备注名/隐藏）；移除 `hasSeenTour` 配置字段与引脚状态全链路；`useOperationStore` 现订阅 `baudRate`（提交时，非逐键）；新增 `LicensesDialog`。测试新增：config `port_meta` 往返/缺省回退 1 例。

已知边界（记录而非缺陷）：① 端口参数（baudRate 等）仍走会话快照持久化（`restoreSession` 开启时）；仅备注名/隐藏状态随 `port_meta` 无条件持久化。② 参数「切换标签载入端口已存值」意味着操作面板随标签切换更新参数——这是 per-port 参数的预期行为，旧版「全局参数」不再适用。

## 已修复 (2026-08-04 issue #3 六项：条件触发接线+指定串口 · 波特率自定义输入卡顿 · 滚动锁定脱节 · 日志格式设定 · 背景图删除 · 漏斗图标删除)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 410/410 (19 files), `cargo check` 0 错 0 警告, `cargo test --lib` 41/41。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useSerialReceive.ts` / `triggerEngine.ts` | 条件触发完全不生效（issue #3-1）：`evaluateTriggers` 规则链（定义/持久化/加载/CRUD）完整但**生产代码零调用**——没有任何代码把 RX 数据喂给引擎 | 在 `serial:data` 回调（流量统计后、protocol 分支前）接入 `evaluateTriggers`：用 `useRuleStore.getState().triggerRules` 实时读取（回调内禁订阅）、`pipeline.decodeText` 解码文本供 contains/exact/regex、原始字节供 hex；`alert` → `useToastStore.push`（i18n `trigger.alertMessage`，同规则 1s 节流防刷屏）、`respond` → `sendToPort(portId, content, isHex, 'None', silent=true)`（失败静默不打断 RX 循环）；try/catch 兜底 |
| HIGH | `types/index.ts` / `config/mod.rs` / `TriggerSettings.tsx` | 触发规则无法指定串口（issue #3-1）：`TriggerRule` 无 portId 字段，规则对所有端口生效 | `TriggerRule.portId?: string`（前端）+ `TriggerRuleEntry.port_id: Option<String>`（后端 `#[serde(default)]` 兼容旧配置）+ `evaluateTriggers` 第 4 参 `portId` 过滤（规则声明了 portId 且与当前端口不符时跳过，空=全部端口）；TriggerSettings 展开区新增「指定串口」下拉（`useAppStore.ports`，`trigger.portId`/`trigger.portId.all` i18n key） |
| HIGH | `types/index.ts` / `i18n.ts` / `TriggerSettings.tsx` / `useAppInit.ts` | 「添加书签」触发动作是死功能（issue #3-1）：项目无书签系统，`bookmark` 仅存在于类型联合/i18n key/UI 选项，零实现 | 从 `TriggerActionType` 联合、`trigger.actionType.bookmark` i18n key、TriggerSettings 动作下拉三处移除；`useAppInit` 启动加载时把旧 config.json 残留的 `actionType==='bookmark'` 规则归一为 `alert`（String 比较规避类型不重叠）；TriggerSettings 修复加载 bug（删除全部规则后重启残留旧规则——`rows.length>0` 才 set 改为无条件 set） |
| HIGH | `ParamsSection.tsx` / `OperationPanel.tsx` / `SendSection.tsx` | 波特率选「其他...」后 UI 特别卡且无法手动输入（issue #3-2）：① `isCustomBaud` 由 useEffect 从 `defaultBaudRates.includes(baudRate)` 派生，键入到预设值（如 9600/115200）瞬间翻转 → 输入框卸载、焦点丢失；② `Number(v) \|\| 9600` 清空/输 0 回弹；③ 每键 setOpState → OperationPanel 订阅 baudRate 全面板重渲染 + 连接时每键 2 次后端重配（setSerialParams+setFlowControl） | ① `isCustomBaud` 改**显式用户意图**：仅 select onChange 写入，删除自动派生 effect（挂载时按初始 store 值恢复一次）；② 自定义输入改**本地 draft state**：键入只改字符串、blur 才解析提交（有效 >0≤4000000 提交、无效还原），无回弹；③ OperationPanel 删除 baudRate 订阅（effect 内 `getState()` 读实时值），参数同步 effect 下沉 300ms 防抖（连续键入合并为一次后端调用）+ unmount 清理 timer；SendSection `React.memo`（props 全稳定） |
| HIGH | `TerminalView.tsx` | 大量数据输出时滚动锁定显示锁定但实际不在底部（issue #3-2→#3-3）：① maxLines 满后 `appendTerminalLines` 头部 splice → `lines.length` 恒定 → auto-follow effect（依赖 `renderedCount`）永不重触发，但 getItemKey 全量平移重挂载重测量导致 scrollTop 过期；② `scrollToIndex(count-1, align:'end')` 用未测量尾行的 estimateSize，ResizeObserver 实测后 totalSize 增长、tanstack retry 窗口（10 rAF）耗尽后无校正 | ① auto-follow effect 追加**首尾行 id 依赖**（`lastLineId`/`firstLineId`，O(1) 派生）：新行到达与头部裁剪都触发重钉底；② `scrollToBottom` 在 scrollToIndex 后追加一帧 rAF 的 DOM 钉底（`el.scrollTop = el.scrollHeight`，只碰 scrollTop 不碰 scrollLocked/followRef）兜底测量滞后 |
| MEDIUM | `config/mod.rs` / `logger/mod.rs` / `commands/config.rs` / `LogSettings.tsx` / `types/index.ts` / `useAppStore.ts` | 日志格式不可配置（issue #3-4）：`[timestamp] direction data` 硬编码在 `PortLogWriter::write_line`，无时间戳/RX·TX 前缀开关 | 新增 `AppConfig.log_include_timestamp` / `log_include_direction`（`#[serde(default = "default_true")]` 兼容旧 config.json）+ `LogManager` 同名字段与 setter + `PortLogWriter` 创建时锁定 + `write_line` 前缀按开关拼接（四组合：全开/仅时间戳/仅方向/全关）+ `sync_log_manager_from_config` 同步两行；LogSettings 新增两个 checkbox（`logSettings.includeTimestamp`/`includeDirection` i18n key） |
| MEDIUM | `GeneralSettings.tsx` / `ThemeProvider.tsx` / `base.css` / `types/index.ts` / `useAppStore.ts` / `config/mod.rs` / `i18n.ts` | 背景图片功能未实现，设置界面不应展示该选项（issue #3-5） | 从设置界面删除背景图 config-row（selector + 浏览按钮 + `open` import），删除 `AppConfig.backgroundImage`（TS + Rust）、`defaultConfig.backgroundImage`、ThemeProvider 的 `--bg-image` effect、base.css 的 `--bg-image` 变量与 body background-image 规则、4 个 i18n key |
| LOW | `TerminalFilterBar.tsx` / `terminal-view.css` | 「全部/仅TX/仅RX」前有无意义的漏斗图标（issue #3-6） | 删除 `<Filter>` 图标（lucide import + JSX 行，纯装饰 aria-hidden 无交互）与 `.terminal-filter-icon` CSS 规则 |

架构变化：`TriggerRule`/`TriggerRuleEntry` 新增可选 `portId`（空=全部端口）；`TriggerActionType` 移除死成员 `bookmark`；AppConfig 日志实体新增 2 个布尔格式开关；`background_image` 配置字段全链路删除。测试新增：triggerEngine portId 过滤 3 例、useRuleStore TriggerRule CRUD 7 例、logger 前缀开关 1 例、config 兼容性 2 例（日志字段缺省回退 + port_id 可选）。

已知边界（记录而非缺陷）：① 触发匹配按**事件**粒度（serial:data 每事件解码文本），跨事件拆行的 contains 匹配依赖 RX 管线成行后才有完整文本——字节级 HEX 匹配不受影响；② alert 节流为模块级 Map（规则 id → 最后时间戳），应用生命周期内有效。

## 已修复 (2026-08-04 issue #2 九项：标签菜单批量开关/外部工具 · 分组持久化 · 自然排序 · 面板尺寸 · 搜索高亮 · SIM 仅调试)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 400/400 (19 files), `cargo check` 0 错 0 警告, `cargo test --lib` 38/38。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `config/mod.rs` / `commands/storage.rs` / `useAppInit.ts` / `Sidebar.tsx` | 分组设置无法保存，关窗即丢失；「保存布局」手动按钮不直观（issue #2-3） | 新增实体 `PortGroupEntry` + `AppConfig.port_groups`（`#[serde(default)]` 兼容旧 config.json）+ 命令 `save_port_groups`（整体替换落盘）；前端启动经 `get_config` 恢复分组并按成员关系回填 `ports.groupId`，`useAppInit` 订阅 `groups` 变更 500ms 防抖自动保存；移除「保存布局」按钮与 `sidebar.toolbar.saveLayout` key |
| HIGH | `useSerialPorts.ts` / `portSort.ts` / `Sidebar.tsx` | ① 排序结果为字典序 COM1-COM12-COM2（issue #2-4）；② 点击排序后 3s 轮询用枚举顺序覆盖 store，排序瞬间丢失（issue #2-5） | ① 新纯函数 `naturalCompare`/`sortPortsByNatural`：数字段按数值比较（COM1<COM2<COM12），其余逐位不区分大小写；② 根因修复：`mergePorts` 改为按 **existing 顺序**合并（新端口追加），手动排序/拖拽顺序不再被轮询冲掉；侧边栏排序改为**持久开关**——激活时渲染派生自然序（新端口自动落位），排序中禁用拖拽，菜单项带 active 态 |
| HIGH | `TabBar.tsx` / `Pane.tsx` | 标签页右键菜单缺批量开关串口入口（issue #2-1） | 新增「打开所有标签页 / 断开所有标签页」：遍历**全局** tabs，逐个 openPort/closePort（100ms 节流，与侧边栏一键开/关同款），无可连/可断端口时禁用；复用 Pane 的 `useSerialConnection` |
| MEDIUM | `usePortToolActions.ts` / `TabBar.tsx` / `Sidebar.tsx` | 标签页右键菜单缺外部工具入口（issue #2-2） | 抽出共享 hook `usePortToolActions`（runTool 未配置→跳配置页 / killTool / configTool），侧边栏与标签页菜单同源复用，文案复用 `sidebar.port.contextMenu.*` key 保证两处完全一致；运行中显示「终止外部工具」（danger） |
| MEDIUM | `useAppStore.ts` | 操作面板默认高度 200px 无法完整显示发送区+参数区（issue #2-6） | `defaultUIState.operationPanelHeight` 200→280（可拖拽范围不变 [160, 600]）；会话快照本就不持久化 UI 态，新默认对全体用户生效 |
| MEDIUM | `operation-panel.css` | 宽窗口下参数栏 flex:1 拉到 350px+，挤占发送区（issue #2-7） | `.op-section-params` 加 `max-width: 300px` 封顶，多余宽度还给发送区 |
| MEDIUM | `terminalSearch.ts` / `useTerminalSearch.ts` / `TerminalRow.tsx` / `terminal-view.css` | Ctrl+F 搜索仅整行底色，无字符级高亮；且关闭搜索栏后残留 query 仍随每批 RX 全缓冲重扫（issue #2-8 性能隐患） | ① `markSearchMatchesInHtml`：HTML tag/实体感知的 `<mark>` 叠加层，只在命中行（每屏 ~50 行）上包 query 出现处，兼容用户高亮 span 与协议着色（跨界匹配自动拆段），当前匹配行用 current 加强样式；② 匹配计算**仅在搜索栏打开时**进行；③ `findMatchesIncremental` 前缀收窄——继续输入时只重扫「旧匹配 ∪ 新增行」 |
| LOW | `devMode.ts` / `vite-env.d.ts` / `Sidebar.tsx` / `GuideCard.tsx` / `useSimulation.ts` / `simulation.rs` | release 安装包不应含模拟串口（issue #2-9） | 双层门控：前端 `DEV_FEATURES_ENABLED = import.meta.env.DEV` 隐藏烧瓶按钮 / GuideCard SIM 按钮，`useSimulation` 兜底 no-op；后端 `enable/disable_simulation` 在 `cfg(not(debug_assertions))` 下返回错误。`tauri dev`（dev profile + Vite dev server）照常可用 |

架构变化：`ContextMenuEntry` 新增可选 `active` 布尔（开关态菜单项，accent 着色）；hooks 增至 12 个（`usePortToolActions`）；config.json 实体类型增至 7 个（`port_groups`）。

已知边界（记录而非缺陷）：搜索栏关闭期间按 F3 重新打开时，首次导航需再按一次（匹配在打开后才计算——这是「不后台全缓冲扫描」的代价，主路径 Ctrl+F/Enter 不受影响）。

## 已修复 (2026-08-04 RX 管线重构 + 滚动锁重设计 + 快捷跳转，关闭 GitHub issue #1)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 364/364 (17 files), `cargo check` 0 错 0 警告（后端未改动）。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useSerialReceive.ts` / 新 `utils/rxAssembler.ts` / `utils/rxPipeline.ts` / `useTerminalStore.ts` | RX 输出碎片化（issue #1-1）：「一事件一行」模型下，跨多个 serial:data 事件到达的设备响应被撕成碎片行，首字符经常独占一行 | 新 RX 管线：`RxLineAssembler` 字节级切行（CR/LF/跨事件 CRLF 对/空行/4KB 无分隔强制发射——0x0A/0x0D 在全部四种受支持编码中都不可能出现在多字节序列内部）+ `RxPipeline` rAF 批写（每帧每端口最多 1 次 `appendTerminalLines`）+ 250ms 静默 flush（尾行时间戳沿用最后事件时间而非 flush 时刻）+ 每端口缓存解码器（`ignoreBOM:true`，非流式 decode 默认剥行首 UTF-8 BOM）。`StreamingDecoderCache` 整体删除（被取代） |
| HIGH | `TerminalView.tsx` | 滚动锁几乎不可用（issue #1-2/3）：`onScroll` 按 atBottom 隐式写 `scrollLocked`——挂载时虚拟滚动器在顶部、测量滞后、80ms 守卫过期后的内容增长都会误解锁；点锁定按钮不滚底 | 显式意图状态机：`scrollLocked` 仅由图钉按钮 / 跳转按钮 / 手势 settle（滚轮、滚动键、滚动条拖拽 `target===currentTarget`、中键自动滚动 `button===1`，120ms 静默后按最终位置 50px 容差判定）写入；**彻底删除 onScroll 隐式解锁**；锁定（false→true 或挂载即锁定）立即滚底；搜索栏打开时抑制跟随、关闭时若锁定则回到最新 |
| MEDIUM | `useSerialSend.ts` | 批写引入的时序隐患：零延时循环发送会渲染成 TX1,TX2,RX1（RX1 响应还在队列等 rAF）；发送前到达的 RX 显示在 TX 行之后 | `sendToPort` TX 回显前 `getRxPipeline().flushNow(portId)` 同步排空该端口 RX 队列，双重恢复「发送前的 RX 先于 TX、TX 先于其响应」时序 |
| MEDIUM | `protocolParser.ts` | `feed()` 返回 `{frames, flushedBytes}`：帧**之前**的裸字节被排在所有帧之后渲染，字节流顺序错乱（既有缺陷，批写会放大紊乱窗口） | 改返回有序段数组 `ReassemblerSegment[]`（`{kind:'frame'|'raw'}`，相邻 raw 合并）；`useSerialReceive` 按段顺序入队（帧走 `enqueueLines`、raw 走 `feedBytes`，共享队列天然保序） |
| MEDIUM | `TerminalView.tsx` / `TerminalRow.tsx` / `useTerminalDisplay.ts` / `lineFilter.ts` / `timeFormat.ts` | 高频输出渲染热点：恒等过滤映射每帧分配全缓冲索引数组；`firstInRound` / `originalToFiltered` 每帧 O(n) 全缓冲重算；`TerminalRow` 每帧全量重渲染（`terminal`/`lines` prop 身份每帧变化） | `filterLines` 无过滤返回 `null` 哨兵 + `limit` 参数替代暂停前缀 slice；`originalToFiltered` 惰性构建；firstInRound 每可见行 O(1)；`TerminalRow` `React.memo` + 原语 props（`prevLine`/`displayFormat`/`showTimestamp`/`connectedAt`）+ `formatTerminalTimestampAdj`；`estimateSize` 读 store 字号（去掉逐次 getComputedStyle） |
| LOW | `TerminalFilterBar.tsx` | 编码切换时 RX 管线未终结尾部字节被新 label 直接解码，缝合处乱码（如 GBK 尾字节被当 UTF-8 首字节） | 切换前 `getRxPipeline().flushAndReset(portId)`：旧编码冲刷尾部落盘 + 重置组装器/解码器 |

新功能：终端滚动条上下两端快捷跳转按钮（`ArrowUpToLine`/`ArrowDownToLine`）——到顶自动解除滚动锁定、到底锁定并跟随最新（按钮在锁定态点亮）；Ctrl+Home/Ctrl+End 等价键盘路径。i18n 新增 `terminal.jumpToTop` / `terminal.jumpToBottom`。

架构变化：弹出窗 RX 与主窗共用 `RxPipeline`（独立 webview 各自的模块单例）；`useSerialReceive` 不再持有任何 store 选择器订阅（effect deps `[]`）；流量统计在事件处理器顶部统一计一次。已知平台降级：Linux WebKitGTK 原生滚动条可能不派发 pointerdown——滚动条拖拽解锁在该平台静默失效，滚轮/键盘/图钉不受影响。

## 已修复 (2026-08-03 后端串口加固 + 串口测试 + 文件发送取消)

> 验证: `cargo check` 0 错 0 警告, `cargo test --lib` 37/37（Windows；非 Windows 另含参数映射 / 管理器错误路径 / 端口枚举测试）, `npx tsc --noEmit` 0 错, `npm run test:run` 290/290。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `commands/serial.rs` `send_file` | 文件发送无法取消；写错误 / 取消 / 空文件时不发终结事件 → 前端进度条永久卡住；`delay_ms==0` 时整循环无 `.await` 让出点，饿死其它异步任务；`std::fs::read` 在异步命令里阻塞运行时线程 | 注册 per-port 取消令牌（`AppState.file_send_cancel`）+ 新命令 `cancel_file_send`；循环每块前检查令牌、写错误捕获后 break；`delay_ms==0` 改 `yield_now().await`；读文件改 `tokio::fs::read`；循环后**无条件**清理令牌并发 `serial:file_progress{done:true}`（正常 / 取消 / 写错 / 空文件四路径都触发） |
| HIGH | `serial/mod.rs` | 异常断线后陈旧句柄留在 `ports`，`open_port` 无守卫 → 手动重开报 OS「access denied」，且 `insert` 可能丢弃存活句柄、泄漏游离读线程；SIM 端口读线程退出从不发 `disconnected`（与真实端口不一致） | `open_real_port` / `open_sim_port` 加陈旧句柄守卫（存活 → 干净报错「already open」；死线程 → 移除并释放 OS 端口）；SIM 读线程退出补发 `serial:status disconnected` |
| MEDIUM | `commands/serial.rs` `run_port_tool` | 在全局串口锁内 `thread.join()`（阻塞其它串口命令）；`BufReader::lines()` 遇非法 UTF-8 静默截断烧录器二进制输出；重开端口失败仅 `log::warn`，UI 不反映 | join 移到锁外；stdout/stderr 改 `read_until(b'\n')` + `from_utf8_lossy`；重开失败补发 `serial:status error` |
| MEDIUM | `serial/mod.rs` / `commands/serial.rs` | SIM / 文本带行结束符时，发送字节数、TX 日志字节数、回显三处不一致（SIM `send_data` 忽略行结束符；TX 日志另抄一份解析逻辑） | 抽出 `build_tx_bytes` 作为「实际写入字节」唯一事实来源，`send_data` 与 TX 日志共用；`emit_data_event` 只取一次 `now()`，格式化串与毫秒同源 |
| MEDIUM | `serial/mod.rs` 测试 | 整个串口模块零测试；且 `use super::*` 通配导入会把 `serialport` FFI 拉进 *测试* 二进制，Windows 上 `cargo test` harness 因缺应用清单而 `0xc0000139`（STATUS_ENTRYPOINT_NOT_FOUND）加载失败 | 新增 `#[cfg(test)] mod tests`，用**显式导入**（非通配）：纯函数测试（hex 解析含原始索引定位、`build_tx_bytes` 各分支）在 Windows 运行；引用 `serialport` 类型 / `SerialManager` 的测试 `#[cfg(not(target_os = "windows"))]`，在 Linux/macOS CI 运行 |
| LOW | `serial/mod.rs` | `parse_hex_string` 每字节分配 `String`、错误位置指向去空白串；`set_params` 的 `data_bits` 走 `&str` 往返解析 | hex 解析改字节切片、错误位置指向输入原文；`set_params` 的 `data_bits` 改 `u8` 直传（命令层同步去掉 `to_string()` 往返） |

## 已修复 (2026-08-03 操作面板缺陷 + 布局整合)

> 验证: `npx tsc --noEmit` 0 错误, `npm run test:run` 290/290 (16 files), `cargo check` 0 错误 0 警告。前端为主，另在 `config/mod.rs` 给 `SendCommandSetEntry` 加 `repeat_count`（`#[serde(default)]` 兼容旧 config.json）。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useCyclicSend.ts` | 循环发送第一轮按 per-command `delay`（如 100ms），第二轮起每条命令都变成 `loopDelay`（如 1000ms），且重复轮数>0 时半路提前停发：轮次边界用 `nextIdx >= commands.length` 判定，而 `currentCmdIdx` 持续自增从不归零 → 第一轮后该式恒真，每条命令都误用 `loopDelay`、`completedRounds` 按「条」而非「轮」累加 | 改用「是否本轮最后一条」（`currentCmdIdx === length-1`）判定轮次边界；末条触发 `completedRounds += 1`、`loopDelay` 作轮间间隔、索引归零进入下一轮；轮内命令始终用 per-command `delay`。重复轮数改读命令集自有字段 `repeatCount`（见下），按完整轮数精确停止 |
| HIGH | `usePopoutBridge.ts` / `QuickSendPanel.tsx` / `services/tauri.ts` | 配置弹窗里编辑命令集后若不点「✓ 保存」，主窗快捷发送区能显示新命令，但独立浮窗的发送区不显示：`command-sets:changed` 是不带载荷的信号，弹窗收到后回 config.json 重读，而未保存的编辑只在主窗 `useRuleStore` 内存态、尚未落盘 | 信号改为携带完整 `SendCommandSet[]` 载荷（主窗 store 是唯一真相）：`emitCommandSetsChanged(sets)` / `onCommandSetsChanged(cb:(sets)=>void)`；桥接订阅传 `state.sendCommandSets`，并在 `request-sync` 时回放当前命令集；弹窗抽出 `applySets()` 直接 `setSets(载荷)`，mount 仍读 config.json 取基线、随后载荷纠正为含未保存编辑的实时态 |
| MEDIUM | `useSerialSend.ts` | 发送时 RX 先于 TX 显示（模拟串口尤甚）：`sendToPort` 在 `await sendSerialData` 之后才追加 TX 行，而模拟端口读线程在 await 期间已 emit 回显 RX，RX 抢先入终端 | TX 行改为在调用后端**之前**同步追加（先算 `displayText`/`txRawData` 再 `appendTerminalLine`），保证发送行恒先于其响应；流量统计 / 发送历史仍在 await 成功后记录 |
| MEDIUM | `SendSection.tsx` | 快捷发送区按钮显示命令**内容**而非命令**名称**（独立浮窗早已是 `name \|\| content`，内联条不一致） | 按钮文本改为 `cmd.name \|\| cmd.content`，与浮窗一致；tooltip 保留「名称 — 内容」 |
| MEDIUM | `types/index.ts` / `config/mod.rs` / `CommandSettings.tsx` / `useOperationStore.ts`(+测试) / `useCyclicSend.ts` | 循环「重复轮数」放在全局操作态 `loopRepeatCount`，与命令集脱钩——同一轮数套用到所有命令集，且占操作面板空间 | 重复轮数下沉为命令集自有字段 `SendCommandSet.repeatCount`（Rust `SendCommandSetEntry.repeat_count`，`#[serde(default)]` 兼容旧配置）；从 `useOperationStore` 删除 `loopRepeatCount`；`useCyclicSend` 改读 `currentSet.repeatCount`；编辑入口在 CommandSettings 命令集头部（与"循环"开关、轮间间隔同行） |
| MEDIUM | `operation-panel.css` | 操作面板拖矮时发送区按键叠到上方快捷发送区：`.op-send-row` 是分区 flex 列的子项且 `min-height:0`，面板变矮时被压塌成 0 高，其内发送键/文件键/HEX 选项保持自身尺寸溢出叠压 | 新增 `.op-section > * { flex-shrink: 0 }`：分区子元素保持自然高度，超出由分区自身滚动，杜绝叠压 |
| LOW | `SendSection.tsx` / `OperationPanel.tsx` / `RulesSection.tsx`(删除) / `operation-panel.css` / `i18n.ts` | ① 命令集选择与快捷发送被拆在两个分区，不符合直觉；② 上一版把命令集选择 + 循环做成两条整宽行，喧宾夺主；③ 高亮规则下拉实为死控件（高亮引擎按各集 `isEnabled` 过滤，从不读 `activeHighlightSetId`） | 命令集选择 + 循环开关 + 编辑按钮收进发送区**标题同一行**的紧凑头部（`.op-send-header`：标题左、控件右），循环开关为图标按钮、运行时错误色呼吸脉动，不再各占整行；删除独立 `RulesSection`；高亮规则管理保留在设置弹窗 HighlightSettings（按集启用）；移除失效 i18n key 与 `.op-section-rules`/`.op-rule-row`/`.op-loop-row` 等死样式 |

## 已修复 (2026-08-01 命令集激活缺陷)

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useRuleStore.ts` | 配置了发送命令集后操作面板快捷区/循环发送无反应：`activeSendCommandSetId` 是会话态（每次启动归零），而 `setSendCommandSets`（启动加载 / 设置页加载）与 `addSendCommandSet`（新建集）都从不设置它，用户必须手动在 RulesSection 下拉里选中才生效 | 两个 action 建立不变量「有命令集时 `activeSendCommandSetId` 必指向有效集」：`setSendCommandSets` 保留仍有效的激活集、否则回退首个；`addSendCommandSet` 无激活时激活新集。与既有 `removeSendCommandSet` 回退逻辑对称。补 6 个单测 |

## 已修复 (2026-08-01 三处 Bug 修复)

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `lib.rs` | 托盘右键菜单瞬间消失：`on_tray_icon_event` 匹配所有 `TrayIconEvent::Click`（含右键），Windows 右键同时弹出原生菜单并触发 Click 事件，`set_focus()` 抢走焦点导致菜单关闭 | 模式匹配限定 `button: MouseButton::Left`，仅左键触发显示窗口 |
| HIGH | `TerminalView.tsx` | 高速输出时滚动锁定抖动后失效：`scrollToIndex` 触发的 scroll 事件中 virtualizer 布局滞后，`atBottom` 误判为 false 并永久关闭 autoScroll | 新增 `isAutoScrollingRef` 守卫（scrollToIndex 前置位、80ms 后清除），`handleScroll` 跳过程序化滚动；atBottom 容差从 2px 增至 30px；wheel 事件清除守卫以保留用户意图 |
| HIGH | `ParamsSection.tsx` | 参数预设下拉永远为空：预设仅在 ConfigModal→GeneralSettings 中管理，ParamsSection 挂载后不再刷新，用户无法发现/创建预设 | 下拉旁新增保存（💾 自动生成 "9600-8N1" 式名称）和删除（🗑）按钮，操作后立即刷新列表；新增 4 条 i18n key |

## 已修复 (2026-07-25 UI/UX 大修)

> UI/UX 大修轮。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 179/179 (11 files), `cargo test --lib` 33/33。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `DisconnectBanner.tsx` / `useTauri.ts` | 会话恢复的标签启动即触发"端口已断开"横幅误报 | `useTauri.ts` 模块级 `lostPortIds: Set<string>` 仅记录本次会话 connected→disconnected 的端口 + `isPortLost`；横幅改由新纯函数 `filterLostTabIds(tabs, isLost)` 驱动 (单测 5 cases) |
| HIGH | `OperationPanel.tsx` / `useOperationStore.ts` | `scrollLocked` / `showTimestamp` / `displayFormat` / `encoding` / `loopInterval` 5 字段全局态每次切标签覆盖 per-tab 终端状态（编码选择"不生效"根因） | 4 字段移出 opStore，显示控制下沉 `TerminalFilterBar` 直写 `useTerminalStore` |
| MEDIUM | `useTerminalStore.ts` | 切换编码只影响新数据，存量行不重解码，用户感知无效 | `setTerminalEncoding` 更新 encoding + 从 `rawData` 重解码全部存量行 |
| MEDIUM | `useHotkeys.ts` | 全局 Ctrl+Enter 发送与"Ctrl+Enter 永远换行"的交互决策冲突 | 移除全局热键及帮助弹窗对应行 |
| LOW | `RulesSection.tsx` / `useCyclicSend.ts` | `loopInterval` 与命令集 per-command delay 双数据源语义重叠 | 移除间隔字段，时机由命令集延时唯一决定（同时消除窄窗口下间隔控件被裁切） |
| LOW | `SendSection.tsx` | HEX/字符串切换无内容转换、HEX 模式不限制输入 | `sendUtils.ts` 新增 `textToHexPreview` / `hexToTextPreview` / `sanitizeHexInput` 提供双向转换 + 输入过滤 |

## 已修复 (2026-07 缺陷审计 + 架构迭代)

> Bug 修复（30+ 项）+ 4 阶段架构迭代。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告。

### 日志 & 配置契约

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `logger/mod.rs` | `close_writer` 仅 flush 不 `sync_all`，断电丢数据 | 关闭前调用 `sync_all()` 确保 OS 层落盘 |
| HIGH | `logger/mod.rs` | 分片开关缺失，始终按大小切片 | 新增 `split_enabled` 字段 + 守卫生成切片 |
| HIGH | `commands/log.rs` | `save_log_as` 作用域限制过严（`canonicalize().starts_with`），用户 save 对话框选择的路径被拒 | 移除子树限制，仅保留父目录 canonicalize 校验 |
| HIGH | `commands/log.rs` | `export_terminal_log` 同上作用域限制问题 | 同上移除限制 |
| HIGH | `services/tauri.ts` | 缺少 `setLogFilenameFormat`、`setLogSplitSize`、`setLogSplitEnabled` 包装 | 新增三个 service wrapper |
| MEDIUM | `hooks/useTauri.ts` | `syncLogSettingsToBackend` 只同步部分日志设置 | 同步全部 6 项日志设置（directory/filenameFormat/splitSize/splitEnabled/autoSave/encoding） |
| MEDIUM | `logger/mod.rs` | `LogFileInfo` 字段名 snake_case 与前端 camelCase 不匹配 | 增加 `#[serde(rename_all = "camelCase")]` |
| LOW | `services/tauri.ts` | `onSystemStatus` 事件监听废弃代码残留 | 移除死代码 |

### 配置 & Store 架构

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `config/mod.rs` | 配置无版本号，加字段只能靠 `Option` 兜底 | 新增 `config_version: u32` + `migrate()` 迁移框架 |
| HIGH | `config/mod.rs` | 配置文件路径硬编码，无法自定义 | `ConfigManager::new(Option<PathBuf>)` 三级解析（CLI > env > portable > 默认） |
| HIGH | `config/mod.rs` | `set_config` 不校验字段边界，任意值透传 | 新增 `validate_and_clamp()` 在写入时校验裁剪 |
| HIGH | `config/mod.rs` | 会话快照通过全量 `set_config` 更新，竞态覆盖其余字段 | 新增 `update_session_snapshot()` 单字段方法 |
| HIGH | `useOperationStore.ts` | `sendOnEnter` / `quickSendSlots` 存在于两个 store（opStore + appStore.config），源不唯一 | 从 opStore 移除，仅在 `useAppStore.config` 中保留 |
| HIGH | `sessionSnapshot.ts` | `configSaveInProgress` 标志 + 超时轮询，逻辑复杂且仍有竞态窗口 | 改用 `configService.updateSessionSnapshot()` 专用命令，移除全部锁逻辑 |
| MEDIUM | `config/mod.rs` | 配置损坏时整个应用启动失败 | `save()` 写前生成 `.bak`；`new()` 读取失败时回退到 `.bak` |
| MEDIUM | `config/mod.rs` | 空 `log_directory` 不解析为默认路径，前端拿到空串 | 在 `migrate()` 中将空值解析为 `dirs::data_dir()/hypercom/logs` |
| MEDIUM | `config/mod.rs` | `auto_save_log` 默认 `false` 违背用户预期 | 改为 `true` |
| MEDIUM | `config/mod.rs` | `log_split_enabled` 默认 `false` 违背用户预期 | 改为 `true` |
| LOW | `hooks/useTauri.ts` | `resetAndReload` 漏同步 opStore | 补充 opStore 同步 |
| LOW | `hooks/useTauri.ts` | `useAppInit` 残留 sendOnEnter/quickSendSlots 同步代码 | 移除，同步逻辑已无意义 |

### 后端存储 & 数据

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `storage/mod.rs` | 未开启 WAL 和 FK，并发写可能锁库 + FK 约束不生效 | 新增 `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON` |
| HIGH | `storage/mod.rs` | `save_command_set_to_db` / `save_highlight_set_to_db` 非事务，子行残留 | 改为事务包裹（DELETE old + INSERT new 原子化） |
| MEDIUM | `storage/mod.rs` | `save_port_preset_to_db` 覆盖时丢失 `created_at` | 使用 `ON CONFLICT` 保留 `created_at` |
| MEDIUM | `storage/mod.rs` | `port_groups` + `port_group_members` 表废弃但仍在 schema 中 | 删除两张表 + `PortGroupRow` 结构体 + 相关死代码 |
| LOW | `storage/mod.rs` | `set_baud_rate` 函数从未被调用 | 移除死代码 |

### 前端 UI & 类型

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| MEDIUM | `types/index.ts` | `SystemStatus.memoryUsedMB` 大小写与 serde camelCase 输出不匹配 | 改为 `memoryUsedMb` |
| MEDIUM | `StatusBar.tsx` / `ViewStrip.tsx` | 同上字段名不对齐 | 全面对齐 camelCase |
| MEDIUM | `hooks/useTauri.ts` | `useSystemStatus` 字段名与后端 snake/camelCase 不一致 | 对齐至 camelCase |
| MEDIUM | `hooks/useTauri.ts` | `mapProtocolTemplateInfo` 未转换可选字段 | 增加 `Boolean()` 转换确保布尔类型 |
| MEDIUM | ConfigModal 页面 | 四个设置页订阅整 config，无关字段变更触发重渲染 | 改为逐字段选择器 |
| LOW | `stores/useAppStore.ts` | `defaultConfig.backgroundImage: ''` 空串被 CSS 当路径处理 | 改为 `undefined` |
| LOW | `system_cmds.rs` | `SystemStatus` 字段名与前端 camelCase 不一致 | 增加 `#[serde(rename_all = "camelCase")]` |
| LOW | CSS | AboutDialog / HotkeyHelpDialog / AliasDialog 弹窗样式未复用 | 新增 `.modal-dialog-compact` 公共类 |
| LOW | `commands/serial.rs` | `send_file` 不记录 TX 元数据日志 | 新增 TX metadata 日志记录 |
| LOW | `commands/file.rs` | 配置导入不校验路径，可读取任意位置 | 新增 `validate_config_path()` 限制在配置目录 |

### 架构改进补充

- `lib.rs` 新增 CLI `--config` 参数解析
- `commands/config.rs` 新增 `update_session_snapshot`、`get_config_path` 命令；`save_config` 改名为 `set_config`
- `GeneralSettings.tsx` 通过 `getConfigPath()` 显示配置文件路径
- `i18n.ts` 新增 `general.configPath` key
- `SendSection.tsx` 从 `useAppStore(s => s.config.sendOnEnter)` 读取

## 已修复 (2026-07-21 缺陷审计轮)

> 5 路并行探索 agent 审计（Zustand 选择器 / 内存泄漏 / 错误处理 / 类型安全 / Rust 后端），发现并修复 26 项缺陷。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 158/158, `cargo test --lib` 31/31。Zustand 选择器审计 0 违规。

### Rust 后端

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| CRITICAL | `lib.rs` | panic hook 在持有 `log_manager` 锁时 panic 会死锁（Mutex 非可重入），`abort()` 永不执行 | `.lock()` 改 `.try_lock()`，拿不到锁则跳过 flush |
| HIGH | `storage/mod.rs` | send_history 50 行上限查询按 `created_at` 排序非确定性，时间戳重复时可能删掉刚插入的行 | 改用 `rowid` 作 tiebreaker + 新增 `(port_id, created_at)` 索引 |
| HIGH | `commands/storage.rs` | `save_command_set`/`save_highlight_set` 更新路径 `let _ =` 吞掉删除失败 → 子行重复 | 改为 `?` 传播错误 |
| HIGH | `serial/mod.rs` | 引脚事件上报 DTR/RTS 用连接时的快照，`set_flow_control` 后过期 | 新增 `dtr_state`/`rts_state` `Arc<AtomicBool>`，读线程实时读取 |
| MEDIUM | `storage/mod.rs` | send_history `created_at` 用 UTC，其余代码用 Local | 改 `chrono::Local::now()` |
| MEDIUM | `serial/mod.rs` | `close_port` 持 `serial_manager` 锁期间 `thread.join()` 阻塞所有命令 ~100ms | `close_port` 返回 `JoinHandle`，调用方 drop 锁后再 join |

### 前端生命周期 & 竞态

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| CRITICAL | `App.tsx` | `beforeunload` 异步保存会话快照，WebView 可能提前终止 → 快照丢失 | 改为订阅 store 增量防抖保存（1s），beforeunload 降为兜底 |
| HIGH | `useTauri.ts` | 重连提示监听器注册是异步，快速挂载/卸载时 cleanup 跑在 promise resolve 前 → 监听器永久泄漏 | 保存 pending promise，cleanup 时若未 resolve 则 `.then(u => u())` |
| HIGH | `TitleBar.tsx` | `onResized` 异步注册同类竞态泄漏 | 加 `cancelled` 标志，resolve 后检查 |
| MEDIUM | `useTauri.ts` | 协议重组器仅按 port_id 缓存，切换模板后仍用旧模板解析 | 缓存 key 改 `portId:templateId` |
| LOW | `useTauri.ts` | 重连循环首次尝试前也 sleep 500ms | 仅 `attempt > 0` 时 sleep |
| LOW | `useTauri.ts` | 发送历史去重只看 content，hex "AA" 与 string "AA" 互相覆盖 | 去重 key 加 format |
| LOW | `GeneralSettings.tsx` | maxRetries 允许 0 → 自动重连空转 | 下限改 1 |

### 前端逻辑 & 健壮性

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| MEDIUM | `useAppStore.ts` | `reorderPorts`/`reorderTabs` 无边界检查，越界 splice 插入 undefined 损坏数组 | 加边界守卫提前返回 |
| MEDIUM | `useAppStore.ts` | 会话恢复不校验 tree 叶子 tabIds 与有效 tab 对应，可能渲染幽灵标签 | 恢复时按有效 tab 过滤 tabIds + pruneTree + focusedPaneId 兜底 |
| LOW | `TerminalView.tsx` | 过滤器隐藏全部匹配时 jumpToMatch 指向不可见行 | 无可见匹配时不更新 currentMatch |
| LOW | `timeFormat.ts` | 相对时间戳负 delta 输出 "+-5ms" | `Math.max(0, delta)` |
| LOW | `sendUtils.ts` | HEX 奇数长度静默丢弃末字符 | 末字符补前导 0 |

### 错误处理（24 处用户可见操作静默失败 → 补 Toast）

| 文件 | 修复 |
|------|------|
| `useTauri.ts` | closePort / resetConfig / useSimulation / startLogging 失败补 `notifyError`；pinStates setup 补 catch |
| `App.tsx` | preventScreenOff / preventSleep 失败补 `notifyError` |
| `ViewStrip.tsx` | 日志另存/打开文件/打开目录 3 处补 `notifyError` |
| `HighlightSettings/CommandSettings/ProtocolSettings` | 各 2 处（删除+保存）补 `notifyError` |
| `OperationPanel.tsx` | setSerialParams / setFlowControl 补 `notifyError` |
| `Pane.tsx` | closePort 补 `notifyError` |
| `useCyclicSend.ts` | 循环发送失败补 `notifyError`（用 ref 防重复 toast） |
| `TerminalView.tsx` | 导出 TXT/CSV 失败补 `notifyError` |

## 已修复 (2026-06 重构批次)

> 12 个重构提交, 修复 20 项缺陷。所有验证通过: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 71/71, `cargo test --lib` 24/24。

### 后端

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 58 | `ccfd867` | `serial/mod.rs` | GBK 解码返回 U+FFFD 占位符, 非 ASCII 字节丢失 | 引入 `encoding_rs::GBK`, 后端输出正确 UTF-8, 前端 `TextDecoder` 处理其他编码 |
| 59 | `6d805b3` | `serial/mod.rs` | serial 模块存在死代码 (未使用的函数和字段) | 移除死代码, 抽取 `emit_data_event` helper 统一事件推送 |
| 60 | `6d805b3` | `serial/mod.rs` | `get_traffic_stats` 返回 (0,0) TODO 占位 | 移除 TODO stub, 实现真实 TX/RX 字节累加 |
| 61 | `8bf661d` | `storage/mod.rs` | 6 处 `.lock().unwrap()` 存在 panic 风险 | 全部改为 `.lock().map_err(\|e\| ...)` 返回 `CommandError` |
| 62 | `8bf661d` | `storage/mod.rs` | 双重 CRUD 实现 (dead code 与活跃实现并存) | 移除死 CRUD, 保留单一实现 |
| 63 | `8bf661d` | `storage/mod.rs` | 重复 schema SQL (两份建表语句) | 合并为单一 schema 定义 |
| 64 | `8bf661d` | `storage/mod.rs` + `commands/` | 4 对重复类型定义 | 合并为单一类型, 消除冗余 |
| 65 | `686b7be` | `commands/mod.rs` | commands 单体文件 400+ 行, 所有命令挤在一起 | 拆分为 6 个领域文件: `serial.rs`, `storage.rs`, `config.rs`, `log.rs`, `system_cmds.rs`, `simulation.rs` |
| 66 | `686b7be` | `commands/mod.rs` | 所有命令返回 `Result<T, String>`, 无类型安全 | 新增 `CommandError` 枚举 (thiserror), 9 个变体覆盖所有错误域 |
| 67 | `686b7be` | `commands/mod.rs` | Win32 电源管理代码内嵌在 commands 中 | 抽取为独立 `system.rs` 模块 (`win32_power`) |
| 68 | `686b7be` | `commands/log.rs` | `export_terminal_log` 无路径校验 | 添加 `canonicalize().starts_with()` 作用域校验 |

### 前端工具

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 69 | `5224457` | `utils/hexUtils.ts` | HEX 解析逻辑分散, 3 个死导出 | 抽取 `hexUtils.ts` (`hexToString` / `stringToHex`), 移除死导出 |

### 前端 Store

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 70 | `cec426c` | `stores/useAppStore.ts` | god store 608 行, 55+ Actions 混在一起 | 拆分为 4 个 store: `useAppStore` (437 行), `useOperationStore` (55 行), `useTerminalStore` (49 行), `useRuleStore` (47 行) |
| 71 | `cec426c` | `stores/useAppStore.ts` | `removeEmptyPanes` 逻辑内联, 难以复用 | 抽取为独立 helper 函数 |

### 前端 Hooks

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 72 | `8944418` | `hooks/useTauri.ts` | `useSerialData` 同时管理收发, 生命周期混乱 | 拆分为 `useSerialReceive` (事件监听, App.tsx 调用一次) + `useSerialSend` (发送动作, OperationPanel 调用) |
| 73 | `8944418` | `hooks/useTauri.ts` | 13 处 `.catch(() => {})` 静默吞错 | 改为 `.catch(e => console.debug(...))` 保留可观测性 |

### 前端 UI

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 74 | `a724c05` | `components/ConfigModal/` | ConfigModal god component 450 行 | 拆分为 10 个文件: `ConfigModal.tsx` (109 行) + `RuleSetAccordion.tsx` (78 行) + 6 个 pages + 2 个 editors |
| 75 | `3ed0bab` | `components/OperationPanel/` | OperationPanel god component 410 行 | 拆分为 4 个文件: `OperationPanel.tsx` (138 行) + `SendSection.tsx` (136 行) + `ParamsSection.tsx` (137 行) + `RulesSection.tsx` (108 行) + `useCyclicSend` hook (119 行) |
| 76 | `e33bd30` | `components/Sidebar/` | Sidebar 435 行, 拖拽逻辑和别名对话框内联 | 抽取 `usePortDragEnd` hook (80 行) + `AliasDialog` 组件 (37 行) |
| 77 | `bbd4540` | `components/MainDisplay/` | MainDisplay 226 行, closeTab 绕过连接生命周期 | 拆分为 `MainDisplay.tsx` (132 行) + `Pane.tsx` (160 行) + `ResizeHandle.tsx` (34 行) + `useTabDragEnd` hook (73 行); closeTab 路由通过 `useSerialConnection.closePort()` |
| 78 | `bbd4540` | `components/MainDisplay/` | `setTimeout(0)` hack 绕过 Zustand 同步更新 | 移除, Zustand 是同步的, 直接更新即可 |
| 79 | `ef32ce0` | `styles.css` | styles.css 单体 1427 行, 20 个死 CSS class | 拆分为 11 个文件 (base/titlebar/sidebar/main-display/tabbar/terminal-view/operation-panel/status-bar/config-modal/context-menu), 移除 20 个死 class |

### 早期未修复项 (本次清零)

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 29 | `cec426c` | `StatusBar.tsx:38` | memoryLimitMb=0 防御已添加但极端值未测 | store 拆分后操作字段隔离, 三元保护已验证 |
| 40 | `e33bd30` | `Sidebar.tsx:237` | `useSensors` 在 JSX 表达式中调用 | 抽取 `usePortDragEnd` hook 时移至组件顶层 |
| 44 | `a724c05` | `OperationPanel.tsx` | 缺少编码选择 UI 控件 | 编码选择已移至 TerminalView 工具栏, OperationPanel 拆分后不再需要 |

### 验证

- `npx tsc --noEmit`：0 errors
- `cargo check --manifest-path src-tauri/Cargo.toml`：0 errors, 0 warnings
- `npm run test:run`：71/71 passing (2 test files, 210ms)
- `cargo test --lib`：24/24 passing

## 已修复 (2026-05-24 批次二：虚拟滚动 / 导出 / 测试基线)

### 功能落地

| Commit | 范围 | 说明 |
|--------|------|------|
| `e0ec7ce` | `feat(ui)` | 终端虚拟滚动：`@tanstack/react-virtual@^3.13.15` 替换 naive `{lines.map}` 渲染。DOM 节点从 O(N) 降到 ~30–50（视口 + overscan 12）。保留智能跟随、scrollLocked 同步、HEX 模式、语法高亮、Ctrl+滚轮缩放、右键导出（直接读 store）。已注释说明：全选/复制仅覆盖视口可见行，完整导出走右键菜单。 |
| `4f1693e` | `feat(export)` | 终端导出从剪贴板改为真实文件保存对话框：新增 Rust 命令 `export_terminal_log(path, content)`（`std::fs::write`），前端 `logService.exportTerminalLog` + `@tauri-apps/plugin-dialog` `save()`。默认文件名 `<portId>-YYYYMMDD-HHMMSS.{txt,csv}`，取消静默返回，写入失败 `console.error`。复制/复制为 HEX/HEX 转文本仍走剪贴板。 |
| `35169aa` | `test(store)` | 前端测试基线：vitest 4.x（`environment: 'node'`，无 jsdom 依赖）。`src/stores/useAppStore.test.ts` 共 15 个测试覆盖 Port & Group（2）、Tabs & Panes（7）、Terminal lines（3）、Misc（3）。`npm run test:run` 156ms 通过。 |

### 顺手修的隐藏缺陷

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 57 | `src-tauri/capabilities/default.json` | OperationPanel.tsx:217 已经调用 `save()`，但 capabilities 仅声明 `dialog:allow-open`，缺 `dialog:allow-save`。dev 模式可能通过（开发权限放宽），production build 必被 ACL 拦截。 | 新增 `dialog:allow-save` 权限项。Tauri 自动 regen `src-tauri/gen/schemas/capabilities.json`。 |

### 验证

- `npm run test:run`：15/15 passing（156ms）
- `npx tsc --noEmit`：0 errors
- `npm run build`：✅ ~1.36s, 323KB（gzip 98.4KB）
- `cargo check`：0 errors, 0 warnings
- `ast-grep "$X as any"` in `src/`：0 matches
- `ast-grep "useAppStore()"` (无选择器调用)：0 matches

## 已修复 (2026-05-24 批量)

### P1

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 48 | `OperationPanel.tsx:222` | 打开日志文件匹配错误（COM1 命中 COM10-*.log） | 改为 `files.filter(f => f.port_id === activeTabId)` 精确匹配后用 `reduce` 按 `created_at` 取最新一条 |
| 49 | `logger/mod.rs:41-60` + `useTauri.ts:157` | 日志写入硬编码 UTF-8 lossy，忽略终端编码 | `PortLogWriter` 新增 `encoding` 字段；`LogManager` 新增 `set_default_encoding` + Tauri 命令 `set_log_encoding`；`decode_bytes` 支持 GBK/ISO-8859-1/UTF-8/ASCII；前端 `useSerialData` 用 `terminal.encoding` 创建 `TextDecoder`，失败回退 UTF-8 |
| 50 | `commands/mod.rs:262-285` | 首次 `get_system_status` CPU=0 | `lib.rs::setup` 中预热：两次 `refresh_cpu_all` + 250ms sleep 建立 CPU 采样基线 |

### P2

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 33 | `OperationPanel.tsx:472-474` | 波特率下拉只能选预设值 | 新增 "其他..." 选项 + 联动数字输入框；`isCustomBaud` 状态根据 `opBaudRate` 是否在 `defaultBaudRates` 中自动切换 |
| 34 | `Sidebar.tsx:387-388` | 一键连接/断开并行触发无速率限制 | `forEach` 改为 `for...of` + 100ms `setTimeout` 节流 |
| 51 | `Sidebar.tsx:389-411` | 跨组拖入"未分组"区域不调整全局顺序 | `handleDragEnd` 中 `overGroupId === undefined` 分支补调 `reorderPorts(oldGlobalIdx, newGlobalIdx)` |
| 52 | `logger/mod.rs:191-217` | `list_files` port_id 解析依赖固定分隔符 | 优先用活跃 writer 的 `file_path → port_id` 反向索引；文件名 split('-') 仅作 fallback |
| 53 | `logger/mod.rs:68-76` | `LogManager.auto_save` 字段僵尸状态 | 删除 `#[allow(dead_code)]`；`write()` 首行检查 `if !self.auto_save { return Ok(()) }`；新增 `set_auto_save` 方法与 Tauri 命令 `set_log_auto_save`；前端 `saveConfig` + `useAppInit` 自动同步 |
| 54 | `commands/mod.rs:211-238` | `open_path` 无路径作用域校验 | 接受 `State<AppState>`；用 `canonicalize().starts_with(log_root)` 校验目标必须在 `LogManager.get_directory()` 子树下 |

### P3

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 41 | `serial/mod.rs:163` | Unknown 端口类型映射为 virtual | 改为映射为 `real`，避免把真实 USB-CDC/PCI 标成虚拟 |
| 42 | `Sidebar.tsx:157` + `styles.css` | CSS 变量 `--accent-color` 未定义 | 在 `:root`（暗色 #4fc3f7）与 `:root[data-theme="light"]`（亮色 #0288d1）补充定义 |
| 43 | `useTauri.ts:219-220` | TX 统计两次 `getState()` | `sendData` 内一次 `useAppStore.getState()` 缓存到 `state`，所有 mutation 共用同一快照 |
| 47 | `OperationPanel.tsx:106-160` | 循环发送切换命令集时索引不重置 | 顶层派生 `activeCmdCount`，加入 effect 依赖数组；命令集长度变化触发 effect 重跑并把 `ref.currentCmdIdx` 复位为 0 |
| 55 | `commands/mod.rs:218-222` | Windows `explorer` 路径含逗号被截断 | Windows 分支改用 `std::os::windows::process::CommandExt::raw_arg` + 手动 `"…"` 引号包裹，规避 explorer 把 `,` 当多参数分隔 |
| 56 | `logger/mod.rs:159-164` | 分片后旧 BufWriter 仅 flush 不主动 drop | 分片时 `writers.remove()` 取出 writer，再 `into_inner()` 拿回 `File`，显式 `sync_all()` 后丢弃，确保 OS 落盘 |

### Misc

| 文件 | 问题 | 修复 |
|------|------|------|
| `logger/mod.rs:40,48` | 陈旧 TODO 注释 | 删除（功能已实现） |
| `commands/mod.rs:66-70` | `send_serial_data` HEX 模式日志写入未解析字节 | 抽取 `serial::parse_hex_string` 公共函数；TX 日志按实际写入串口的字节序列记录（HEX 解析 / 文本+line ending） |
| `MainDisplay.tsx:110` | `as any` 类型逃逸 | 改为 `as Encoding` 并补充类型 import |

### 测试

| 文件 | 新增测试 |
|------|----------|
| `logger/mod.rs` | `test_auto_save_off_short_circuits_write` — 验证 #53 短路 |
| `logger/mod.rs` | `test_list_files_uses_writer_registry_for_port_id` — 验证 #52 反向索引 |
| `logger/mod.rs` | `test_iso_8859_1_encoding_decodes_high_bytes` — 验证 #49 编码解码 |

### 验证

- `cargo check --manifest-path src-tauri/Cargo.toml`：0 errors, 0 warnings
- `npx tsc --noEmit`：0 errors
- `cargo test --lib logger::`：11/11 passing
- `ast-grep "$X as any"` in `src/`：0 matches

## 已修复 (2026-05-23 批量)

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 16 | P2 | Sidebar 嵌套 DndContext，跨组拖拽不工作 | 重构为 Sidebar 顶层单一 `DndContext`，每个分组及未分组各持 `SortableContext`；`handleDragEnd` 统一处理同组重排与跨组移动（含调用 `movePortToGroup` + 调整 `portIds` 顺序） |
| 20 | P2 | `get_system_status` 每次 `System::new_all()` + `refresh_all()` | `AppState` 新增缓存的 `system_info: Mutex<sysinfo::System>`；命令改为增量刷新（仅本进程 + `refresh_cpu_all`） |
| 24 | P2 | Pane 订阅整个 `terminals` 对象 | 计算 `displayTabId` 后改用按需选择器 `useAppStore(s => s.terminals[displayTabId])`，单 Pane 只在自己的终端数据变化时重渲染 |
| -- | -- | 日志"打开文件 / 打开目录"命令未暴露 | 新增 `open_path`、`open_log_directory` 两个 Tauri 命令；`LogManager` 增加 `get_directory()`；前端 `logService` 改用新命令，绕开 shell 插件作用域限制 |

## 已修复 (2026-05-21 批量)

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 01 | P0 | Config serde camelCase `memoryLimitMb` vs TS `memoryLimitMB` 不同步 | TS 改为 `memoryLimitMb` / `logSplitSizeMb` 匹配 serde 输出 |
| 02 | P0 | 日志写入断路 — LogManager.write() 从未被调用 | serial read thread 和 sim thread 中通过 app_handle.state 写入 LogManager |
| 03 | P1 | movePortToGroup 不更新 group.portIds | 同时更新旧组移除、新组添加 |
| 04 | P1 | useSerialData 清理竞争 — setup() 异步 | 使用 cancelled flag + cleanups 数组，setup 完成后若已取消则立即清理 |
| 05 | P1 | openPort 乐观更新 — 连接前设 connected | 改为先设 connecting，成功后设 connected，失败设 error |
| 06 | P1 | save 高亮/命令集每次新 UUID 产生重复 | 支持前端传入 id，更新时先删旧再插新 |
| 07 | P1 | ConfigModal 取消不回滚 | 添加 configSnapshotRef，打开时快照，取消时恢复 |
| 08 | P1 | splitPane 方向反转 | 移除 `direction === 'horizontal' ? 'vertical' : 'horizontal'` 反转 |
| 09 | P1 | set_params 忽略 data_bits/parity/stop_bits/handshake | 实现完整参数设置 |
| 10 | P1 | prevent_screen_off/sleep 空壳 | 实现 Win32 SetThreadExecutionState FFI |
| 11 | P1 | MainDisplay useAppStore() 无选择器 | 拆分为独立选择器 |
| 12 | P1 | TerminalView 空数据时显示 mock | 移除 mock 数据，显示空终端 |
| 13 | P2 | handleContextMenu 引用过期 lines | 使用 useAppStore.getState() 获取最新数据 |
| 14 | P2 | 编码选择 <select> 无 value/onChange | 绑定 terminal.encoding + setTerminalConfig |
| 15 | P2 | TextDecoder 硬编码 UTF-8 | 编码选择器已连接，待 useSerialData 中使用 encoding 参数 |
| 17 | P2 | closeTab 不关闭串口 | closeTab 包装器先断开串口再关闭标签 |
| 18 | P2 | 新标签 maxLines 硬编码 10000 | 改为 memoryLimitMb * 500 |
| 19 | P2 | 标签标题不跟别名更新 | updatePort 检测 alias/name 变化时更新 tab.title |
| 21 | P2 | .config-page-title display:none | 移除 display:none，保留字体样式规则 |
| 22 | P2 | CSS quoted padding '2px 12px' | 移除无效引号 |
| 25 | P2 | highlightEngine color 注入未校验 | 添加 hex/rgb/named color 正则校验 |
| 26 | P2 | ReDoS 正则攻击 | 限制 pattern 长度 <= 200 |
| 28 | P2 | `get_traffic_stats` 返回 (0,0) 占位 | 仍未处理 — 见 P2 列表 |
| 30 | P2 | 串口超时错误导致读线程退出 | 添加 TimedOut 错误处理 continue |
| 31 | P2 | close_port 持锁 thread.join() | 此项暂不修复（影响较小，100ms 超时） |
| 36 | P2 | system status 硬编码中文 | 改为 "normal"/"high_load" 状态码，前端本地化 |
| 37 | P2 | closeTabsToRight/Left/Others 不跳过 pinned | 过滤 isPinned 标签 |
| 39 | P3 | formatTimestamp 组件内重建 | 移至模块级函数 |
