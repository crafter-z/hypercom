# 数据收发模块

串口字节的接收管线（RX）、发送路径（TX）、循环发送、快捷发送/命令面板、文件发送、触发引擎。后端 `serial/mod.rs`（读写句柄 + `PortKind` 分派）+ `commands/serial.rs`；前端 `utils/rxAssembler.ts` + `utils/rxPipeline.ts` + `sendToPort`（`hooks/useSerialSend.ts`）+ `hooks/useSerialReceive.ts` + `utils/triggerEngine.ts`，顺序/循环调度在 `components/OperationPanel/hooks/useSequentialSend.ts`。

> **两条 HEX 口径**（详见 §「发送格式工具」）：`utils/hexFormat.ts` 是 bytes→HEX 的**唯一实现**；HEX 输入奇数位是**错误态**，前端与后端同一把尺子拒绝，绝不再补零。

## RX 管线（2026-08-04 重构）

`serial:data` 事件**不再「一事件一行」**，而是进 `getRxPipeline()`（每 webview 一个模块单例）：

```
读线程（阻塞 read，100ms 读超时）
  → port.read(&mut buffer) → Ok(n>0)
    → emit serial:data { port_id, timestamp, direction:"RX", data: buffer[..n].to_vec(), is_hex:false }
  → eventService.onSerialData → useSerialReceive 回调
    → RxLineAssembler.feedBytes：字节级切行（CR/LF/跨事件 CRLF/4KB 强制发射）
    → 每端口队列（上限 maxQueuedLines 默认 10000，超限丢最旧）
    → 批写 tick：每帧对每端口最多一次 appendLines（目标 = viewportManager 环形缓冲区）
    → 250ms 静默 flush 未终结尾部（时间戳取最后事件时间）
```

- **单例范围**：`getRxPipeline()` 主窗与弹出窗各持一个。弹窗是独立 webview（独立模块作用域与 store 实例），在那里的调用自然接线到本窗自己的 store——绝不跨窗共享。
- `RxLineAssembler`（`utils/rxAssembler.ts`）：0x0A/0x0D 在全部四种受支持编码（ASCII/UTF-8/GBK/ISO-8859-1）中都不可能出现在多字节序列内部，故按字节切行安全；跨两次 feed 的 CRLF 用 `pendingCR` 识别为**一个**分隔符；待定缓冲达 `maxPendingBytes`（默认 4096）时无分隔符强制发射，`justForced` 抑制「强制发射点紧跟的分隔符」产生的幻影空行。
- **解码**：行字节由 `utils/lineText.ts` 的共享 TextDecoder 缓存按端口当前编码解码（`ignoreBOM:false`，行首 BOM 是编码标记、被剥离，不进入行文本/搜索/复制）；字节级切行保证同一编码内多字节字符不跨行，故无需 `{stream:true}`。**行不再携带解码后的 `content`**——渲染/搜索/过滤按需惰性解码，行只带 `rawData`。
- **rAF 批写**：全管线只有一个批写 tick 句柄；tick 内对每个有排队的端口各做一次 `appendTerminalLines`。每端口每帧最多写 `maxLinesPerTick`（默认 2000）行，超出顺延下一帧；`flushNow(portId)` 同步排空（单次同样最多 `maxLinesPerTick` 行，其余交回 tick 续写，避免一次 append 数千行阻塞主线程）。
- **静默 flush**：feed 后组装器仍有未终结尾部时（重新）武装 250ms 定时器，超时取尾部成行并入队，行时间戳沿用该端口**最后一次事件时间**（从未 feed 过才退回 `Date.now()`）。
- **队列上限**：`maxQueuedLines`（默认 10000）超限丢弃**最旧**的行——排空跟不上入队时（隐藏窗口 rAF 停摆 / 主线程忙）最旧的行最无价值。
- **visibility-aware 排空（issue #6-10）**：默认调度器在页面可见且 rAF 可用时走 rAF，否则（页面隐藏 / 无 rAF）走 `setTimeout(cb, 16)` 兜底。构造函数注册 `visibilitychange`：变 hidden → 取消未触发的 tick 并按当前可见性重排（自然落到 setTimeout）；变 visible → 同样重排回 rAF（更低延迟）。`dispose()` 移除该监听。
- **断线 / 编码切换**：`disconnect(portId)` 冲刷尾部后丢弃该端口全部状态（组装器/定时器/队列）；`flushAndReset(portId)` 在编码切换前按**当前**编码冲刷尾部再重置组装器。
- **协议帧 / 日志回放**：已构造好的行（协议模板帧段、回放）经 `pipeline.enqueueLines` 直接入队，与 `feedBytes` 产出的行共享同一队列，天然保流顺序；帧文本用 `pipeline.decodeText`（帧自成单元、不跨行，非流式即可）。
- **行级触发器钩子**：`setOnLineAssembled` 由 `useSerialReceive` 注入，每条完整行入队前触发（见「触发引擎」）。
- **流量统计**：RX 字节在 `useSerialReceive` 的事件处理器顶部经 `trafficStats.addRx` 计入，**1s 聚合**后统一写 store（`utils/trafficStats.ts`，字段仍是 `rxTotal`/`txTotal`）——不再每事件 `setTrafficStats`，消除高频 RX 下的 Zustand 重渲染。
- **不得**在 hook/弹窗 cleanup 里 `dispose()` 单例（单例与应用同寿命）；`feedBytes` 不加 tab 存在性门控（弹窗 store 从不填充 tabs，门控会丢光弹窗实时流；对已 release 的 manager 喂数据本就是静默 no-op）。
- `sendToPort` 在 TX 回显前 `flushNow` 排空队列保收发时序。

## TX 发送

### `sendToPort`（模块级导出，唯一发送入口）

```
sendToPort(portId, data, isHex, lineEnding, silent?)
  → HEX 校验：isHex 时 hexInputError(data)（严格模式）——非法即 warn 并返回 0
        （非静默再 toast sendSection.hexInput.invalid），绝不发出后端必然拒绝的输入
  → 守卫：isSendablePort（utils/sendGuard.ts）——端口缺失/断开/连接中/错误时
        非静默 → toast sendSection.portClosedWarning + 返回 0；silent → 静默返回 0
  → TTY 分支（port.mode === 'tty'）：跳过 TX 回显与 flushNow
  → 非 TTY：getRxPipeline().flushNow(portId)（排空 RX 队列，恢复「发送前 RX 先于 TX、
        TX 先于其响应」时序）
        → TX 行在调用后端**之前**同步追加（先算 displayText/txRawData 再 appendTerminalLine）
  → serialService.sendSerialData（invoke send_serial_data）
  → 成功后才记流量统计（trafficStats.addTx）/ 发送历史
```

- **TTY 分支**（`port.mode === 'tty'`）：跳过 TX 回显与 `flushNow`——无本地回显（对端 shell 会把命令 echo 回来，本地再插一条 TX 行既重复又破坏终端流），仍走后端发送/流量统计/发送历史（快捷发送/命令面板在 TTY 下可复用）。
- **TX 行在 await 前追加**：模拟端口的读线程会在下面的 `await` 期间 emit 回显 RX；先追加 TX 行保证终端顺序恒为「TX 先于其响应」。
- **rawData 语义**：HEX 模式 = `parseHexBytes(data)` 得到的实际字节；字符串模式 = 不含 `sendPrefix` 的 UTF-8 字节。两者都存 `Uint8Array`（与 RX 行统一）。
- **发送历史**：模块级 `Map<portId, SendHistoryEntry[]>`（仅内存，应用关闭即失），上限 50 条、按「内容 + 格式」去重；`releaseSendHistory(portId)` 由 `releaseTerminalState` 调用。
- 所有发送路径（快捷发送/循环/触发自动回复/弹出窗/批量）都必须经 `sendToPort`，绕过会失去守卫与 TX 回显/历史管线。

### 后端发送（issue #6-1 / #6-10）

- `send_serial_data` async + `spawn_blocking`；`build_tx_bytes`（`serial/codec.rs`）是「实际写入字节」唯一事实来源。
- 两段式发送 + 读写句柄分离 + `write_all_with_deadline`（2s 总期限，去无界 flush）——详见 [`serial.md`](serial.md)「读写句柄分离与发送期限」。
- TX 行回显经 viewportManager `appendTerminalLine`（`direction:'TX'`，可配 `sendPrefix` 前缀，默认空——终端 TX 行已有方向标识）。

### 发送格式工具

- `src/utils/sendUtils.ts`（纯函数，单测）：`getLineEndingBytes` / `hexInputError` + `HEX_INPUT_ERROR_KEY` / `parseHexBytes` / `computeByteCount` / `formatLineEndingHex` / `textToHexPreview` / `hexToTextPreview` / `sanitizeHexInput` / `LINE_ENDING_VALUES` / `lineEndingLabelKey`。
- **bytes→HEX 唯一实现**：`src/utils/hexFormat.ts`（`hexByte` / `bytesToSpacedHex`）是全仓把字节格式化成空格分隔大写 HEX 的唯一实现，terminalSearch / protocolRenderer / sendUtils / triggerEngine / TerminalRenderer 共用——不要再各写一份 `toString(16).padStart(2,'0')`。
- **HEX 输入严格模式（错误态，不再补零）**：`hexInputError` 忽略空白后要求「半字节个数为偶数且全为 0-9a-fA-F」，与后端 `parse_hex_string` / `build_tx_bytes` 同尺子；`parseHexBytes` 对非法输入返回 `[]`（不补零、不跳过）。发送区经 `useHexCompose` → `computeByteCount` 把奇数位 nubble 输入渲染为错误态（给 `errorKey`、不给字节数），`sendToPort` 也在入口拦掉——旧实现给奇数位补零，于是 UI 为一个后端**必然拒绝**的输入显示「N B」，是假可用状态。
- **JSX 属性字符串不转义（issue #5-6）**：`<option value="\r\n">` 运行时值是 6 字符字面量 `\\r\\n`，与域值 4 字符 `\r\n` 不等。行结束符选项必须用表达式字面量 `value={'\r\n'}`，label 走 `lineEndingLabelKey(v, ns)`。

## 循环发送（每端口独立引擎，issue #12）

- **共享调度引擎**：`components/OperationPanel/hooks/useSequentialSend.ts` 是「顺序 / 循环发送」的唯一调度实现（`createSendLoop` 纯调度 + `useSequentialSend` React 绑定）。计时器链、重入防护（任一次迭代最多在飞一个，防止可见性补发与到期定时器双触发）、可见性补发（`catchUpIfOverdue`，阈值 `SEND_LOOP_OVERDUE_MS`）、卸载自停、可选的变更自停都在引擎里；调用方只提供「一步做什么」的 `step`。**旧的循环发送状态机分叉已消除**：主窗命令集循环与弹窗文本逐行发送（`Popout/QuickSendText.tsx`）共用它——弹窗旧循环器 `Popout/usePanelCyclicSend.ts` 已删除。
- **每端口一个 runtime**：`useCyclicSend`（`components/OperationPanel/hooks/useCyclicSend.ts`）为每个端口创建一条 `SendLoop`（`startLoop(portId)`），目标端口**永远绑定启动它的端口**——不跟随活动标签、不受窗口/标签聚焦切换影响（COM3 启动循环后切到 COM4，COM3 继续发）。
- **运行开关**：`useOperationStore.cyclicLoops: Record<portId, boolean>` + `setCyclicLoop(portId, running)`（替代旧全局单例 `isLoopSending` 布尔）；SendSection 的按钮按**当前聚焦端口**查状态——切回 COM3 时按钮自然变回「停止」。reconcile effect 幂等：开启的端口没有 runtime → 启动；runtime 存在但开关被关/移除 → 停止。
- **每 tick 实时读命令集**：从 `useRuleStore.getState()` 取 `sendCommandSets` 与 `activeSendCommandSetId`，命令集编辑即时生效；命令集缺失/为空 → 清该端口开关并停止。
- **静默发送**：逐条 `sendData(..., silent=true)`（循环 / 触发自动回复不打扰用户）；失败由引擎的 `onStepError` 聚合为一条 toast（`notified` 去重）并返回 `RETRY_MS`（500ms）重试，不推进索引、不终止循环。
- **计时**：轮内用每命令 `delay`，仅轮间用集合级 `loopDelay`。轮次边界以「本条是否本轮最后一条」（`currentCmdIdx === commands.length - 1`）判定；曾用 `nextIdx >= length`，导致第二轮起每条都误用 `loopDelay`、`completedRounds` 按「条」而非「轮」累加而提前停发。重复轮数 `repeatCount` 是命令集自有字段（config.json），`>0` 时精确发满 N 轮停止，否则跟随集合的 `isLoop`。
- **端口未连接**：跳过本次 tick 并不推进索引，`TARGET_WAIT_MS`（500ms）后重试（切聚焦 / 短暂断开皆不中断）。
- **可见性补发**：`useCyclicSend` 注册 `visibilitychange`，恢复可见时对每个 loop 调 `catchUpIfOverdue()`。
- 弹窗文本模式的多种运行方式（当前行 / 当前行并下移 / 顺序 / 从光标 / 循环）由 `QuickSendText` 用 `useSequentialSend` 驱动，发送意图经 `popout:send-command` 回到主窗 `sendToPort`。

## 快捷发送 / 命令面板

- 快捷发送条：pill 两行显示（`.op-quick-cmd-name-row`：HEX 徽标+名称在上、`.op-quick-cmd-content` 内容在下，issue #6-9）、宽度自适应（`useQuickStripLayout` + ResizeObserver + 隐藏测量行，`utils/sendStrip.ts` 的 `computeFitCount` 算可见切片与溢出条数）、首槽固定「打开命令面板」按钮（`.op-quick-panel-btn`，issue #7-2）。
- `quickSendInlineCount`（`useAppStore.config`）**只决定内联条是否挂载：仅 0 = 隐藏**，任何 `>0` 都显示；条内实际显示几条由实测宽度决定，不由该值直接切片。
- QuickSendPanel 双模式：列表（整行可点即发、行内「修改」就地编辑）/ 文本逐行（`QuickSendText` + `useSequentialSend` 驱动，含「执行当前行并移至下一行」，issue #6-3）。
- **弹窗 → 主窗写回命令集（K6）**：弹窗本地那套 store 是另一个 webview 的**空实例**，`updateSendCommandSet` 在里面恒为 no-op；命令集编辑必须经 `popout:command-set-updated` **整集回传主窗**，由 `usePopoutBridge` 写回 `useRuleStore` 活实体（并叠加存储层的 `saveCommandSet` 落盘）。弹窗列表刷新仍走主窗回的 `command-sets:changed`（同一路径，不另存可写副本）——只写本地副本会被主窗后续任何一次 `save_config` 用活实体覆盖回滚。
- 目标串口下拉只显示串口号（去 `· REAL/VIRTUAL` 后缀，issue #7-4）；底栏「发送到」提示灯跟随真实连接状态——`usePopoutSync` 订阅 `serial:status` 广播 + `port-statuses:sync` 全量回放（绿=连接呼吸/灰=断开，issue #7-5）。
- 弹出窗（popout）发送经 `popout:send-command` 意图 → 主窗 `sendToPort`（见 workspace.md）。

## 文件发送

- `send_file`（`commands/serial.rs`：async + `spawn_blocking`，`tokio::fs::read` 后按 `chunk_size` 分块写）；`delay_ms==0` 时 `tokio::task::yield_now().await` 让出（曾饿死其它异步任务）。
- **可取消**：per-port 取消令牌（`AppState.file_send_cancel`）+ `cancel_file_send` 命令；循环每块前检查令牌。
- 循环后**无条件**清理令牌并发 `serial:file_progress{done:true}`（正常/取消/写错/空文件四路径都触发）——发送区文件按钮在传输中兼作**取消**按钮。
- **前端 `useFileSend`（`components/OperationPanel/hooks/useFileSend.ts`）收口三个不变量**：
  1. **守卫在弹文件框之前**：`startFileSend` 先查 `isSendablePort`，不可发送直接 toast `sendSection.portClosedWarning` 返回——不该让用户先挑完文件再被告知端口没连（旧实现绕过守卫，未连接端口也能选文件、只在后端报错）。
  2. **按增量计入 TX 流量**：进度事件里 `sent_bytes` 是本次运行累计值，与 `countedBytesRef` 比出差量，正增量才 `trafficStats.addTx`；`done` 时归零，下一次运行重新计数（旧实现文件发几 MB 而 TX 计数器纹丝不动）。
  3. **成功 toast 只在真发完时弹**：`done && sent >= total > 0` 才 `notifySuccess('sendSection.file.sent')`；取消（`sent < total`）与空文件（`total == 0`）静默清进度条，否则取消时误报「已发送」、空文件残留 0/0 进度条。

## 触发引擎（条件触发，issue #3-1）

- `src/utils/triggerEngine.ts` 的 `evaluateTriggers`（纯函数）：pattern match（contains / exact / regex / hex）→ alert / auto-respond；per-port 经 `portId`（规则未声明 `portId` 或为空时对所有端口生效）。regex 仅对前 5000 字符 test（ReDoS 防护），模式长度上限 200；hex 匹配用 `hexFormat.bytesToSpacedHex` + `normalizeHexPattern`。
- **接线在 `useSerialReceive`**：触发器在 RxPipeline 的 `setOnLineAssembled` 钩子（**完整行边界**）上评估，而非旧的「按 `serial:data` 读事件块」匹配——读事件边界任意，跨块模式会失效、exact 因块内带 `\r\n` 几乎不命中。
- **alert = sticky toast**（`durationMs:0` 不自动关闭，展示规则的 `actionContent`，标题带端口/规则上下文）；同规则 1s 内不重复弹（模块级 Map：规则 id → 最后时间戳）。**auto-respond** 走 `sendToPort(..., silent=true)`，失败补 debug 日志；触发引擎异常限流到每 2s 至多一条日志。
- 规则编辑 **300ms 防抖逐条自动落盘**：`TriggerSettings` 经 `useEntityPage` 传 `autoSaveDebounceMs: 300`，`savedSnapshotRef`（最后已知持久化态）用于 diff 出改动项；关闭配置弹窗时有 unmount flush，不会丢最后一次按键。
- 已知边界：触发匹配按**行**粒度（HEX 匹配按该行的原始字节 `rawData`）；行首 BOM 已在解码时剥离，不参与匹配。

## 数据流速查

| 流 | 路径 |
|---|---|
| 连接 | Sidebar.onToggleConnect → useSerialConnection.openPort → updatePort 乐观更新 → invoke open_serial_port → Rust 打开+读线程 → serial:status("connected") 事件双写回 store |
| RX | 读线程（100ms 读超时轮询）→ serial:data → useSerialReceive → RxPipeline（组装/队列/批写 tick）→ viewportManager.appendTerminalLines → TerminalRenderer（同帧 DOM） |
| TX | SendSection.handleSend → sendToPort（HEX 校验 + 守卫 + flushNow + TX 回显）→ invoke send_serial_data → 写句柄 write_all_with_deadline |
| 端口轮询 | useSerialPorts(3000) → list_available_ports → mapPortInfo → mergePorts（保序/保态/幽灵 3 轮） |
| 循环 | setCyclicLoop(portId, true) → useCyclicSend startLoop → createSendLoop 每 tick 实时读 store 命令集 → sendToPort(silent) |
