# 数据收发模块

串口字节的接收管线（RX）、发送路径（TX）、循环发送、快捷发送/命令面板、文件发送、触发引擎。后端 `serial/mod.rs`（读写句柄）+ `commands/serial.rs`；前端 `rxAssembler`/`rxPipeline`/`sendToPort`/`useCyclicSend`/`triggerEngine`。

## RX 管线（2026-08-04 重构）

`serial:data` 事件**不再「一事件一行」**，而是进 `getRxPipeline()`（每 webview 一个模块单例）：

```
读线程（50ms 轮询）
  → port.read(&mut buffer) → Ok(n>0)
    → emit serial:data { port_id, timestamp, direction:"RX", data: buffer[..n].to_vec(), is_hex:false }
  → eventService.onSerialData → useSerialReceive 回调
    → RxLineAssembler.feedBytes：字节级切行（CR/LF/跨事件 CRLF/4KB 强制发射）
    → 每端口队列（上限 maxQueuedLines 默认 10000，超限丢最旧）
    → rAF tick 每端口一次 append（目标 = viewportManager 环形缓冲区）
    → 250ms 静默 flush 未终结尾部（时间戳取最后事件时间）
```

- `RxLineAssembler`：0x0A/0x0D 在全部四种受支持编码（ASCII/UTF-8/GBK/ISO-8859-1）中都不可能出现在多字节序列内部，故按字节切行安全。
- **rAF 批写**：每帧每端口最多 1 次 `appendTerminalLines`；`maxLinesPerTick`（默认 2000）每端口每帧最多写 N 行，超出顺延下一帧；`flushNow` 同步最多排空 N 行，其余 rAF 续写。
- **visibility-aware 排空（issue #6-10）**：页面隐藏时 rAF 停摆——`defaultScheduleFlush` 在 rAF 可用且页面可见时走 rAF，否则（页面隐藏/无 rAF）走 setTimeout(cb, 16) 兜底；构造函数注册 `visibilitychange` 监听：变 hidden → 取消未触发的 rAF tick 并按当前调度器重排（自然落 setTimeout），变 visible → 同样重排回 rAF（更低延迟），dispose() 移除监听。
- **断线**：`pipeline.disconnect(portId)` 清管线队列/组装器/解码器（flush tail + drop per-port state）。
- `sendToPort` 在 TX 回显前 `flushNow` 排空队列保收发时序。
- **不得**在 hook/弹窗 cleanup 里 `dispose()` 单例；`feedBytes` 不加 tab 存在性门控（弹出窗 store 从不填充 tabs，门控会丢光弹窗实时流；对已 release 的 manager 喂数据本就是静默 no-op）。
- 流量统计在事件处理器顶部统一计一次（`setTrafficStats`：rxTotal/txTotal）。

## TX 发送

### `sendToPort`（模块级导出，唯一发送入口）

```
sendToPort(portId, data, isHex, lineEnding, silent?)
  → 守卫：isSendablePort（utils/sendGuard.ts）——端口缺失/断开/连接中/错误时
        非静默 → toast sendSection.portClosedWarning + 返回 0；silent → 静默返回 0
  → getRxPipeline().flushNow(portId)（TRX：排空 RX 队列，恢复「发送前 RX 先于 TX、
    TX 先于其响应」时序）
  → TX 行在调用后端**之前**同步追加（先算 displayText/txRawData 再 appendTerminalLine，
    保证发送行恒先于其响应——曾因 await 期间模拟端口已 emit 回显 RX 而 RX 抢先）
  → serialService.sendSerialData（invoke send_serial_data）
  → 成功后才记流量统计 / 发送历史
```

- **TTY 分支**（`port.mode==='tty'`）：跳过 TX 回显与 `flushNow`——无本地回显（对端 echo），仍走后端发送/流量统计/历史。
- 所有发送路径（快捷发送/循环/触发自动回复/弹出窗/批量）都必须经 `sendToPort`，绕过会失去守卫与 TX 回显/历史管线。

### 后端发送（issue #6-1 / #6-10）

- `send_serial_data` async + `spawn_blocking`；`build_tx_bytes` 是「实际写入字节」唯一事实来源。
- 两段式发送 + 读写句柄分离 + `write_all_with_deadline`（2s 总期限，去无界 flush）——详见 [`serial.md`](serial.md)「读写句柄分离与发送期限」。
- TX 行回显经 viewportManager `appendTerminalLine`（`direction:'TX'`，可配 `sendPrefix` 前缀，默认空——终端 TX 行已有方向标识）。

### 发送格式工具

- `src/utils/sendUtils.ts`：`textToHexPreview`/`hexToTextPreview`/`sanitizeHexInput`/`computeByteCount`/`parseHexBytes`/`getLineEndingBytes`/`LINE_ENDING_VALUES`/`lineEndingLabelKey`（纯函数，单测）。
- **JSX 属性字符串不转义（issue #5-6）**：`<option value="\r\n">` 运行时值是 6 字符字面量 `\\r\\n`，与域值 4 字符 `\r\n` 不等。行结束符选项必须用表达式字面量 `value={'\r\n'}`，label 走 `lineEndingLabelKey(v, ns)`。

## 循环发送（每端口独立引擎，issue #12）

- store 运行标志 `cyclicLoops: Record<portId, boolean>`（`setCyclicLoop(portId, running)` 逐端口启停，替代旧全局单例 `isLoopSending`）——循环目标绑定启动它的端口、聚焦无关，多端口可并行压测。
- `useCyclicSend` reconcile useEffect 检测到某端口开启且无 runtime → `startRuntime(portId)`：
  - 每 tick 从 `useRuleStore.getState()` 取 sendCommandSets（实时重读）与 activeSendCommandSetId；
  - 从 currentCmdIdx=0 开始逐条 `sendData(..., silent=true)`（循环/触发自动回复走静默发送不打扰）；
  - 轮次边界判定 = 「是否本轮最后一条」（currentCmdIdx === length-1）——曾用 `nextIdx >= length` 导致第二轮起每条都误用 loopDelay、completedRounds 按条累加；
  - 轮内用 per-command `delay`，仅轮间用 `loopDelay`；重复轮数 `repeatCount` 是命令集自有字段（config.json），按完整轮数精确停止；
  - 端口未连接 → 跳过 tick 不推进索引，500ms 重试（切聚焦/短暂断开不中断）；
  - `visibilitychange` 监听：窗口恢复可见且 tick 已到期（被隐藏节流）时**立即补发**。
- `usePanelCyclicSend`（快捷发送面板）与主窗 `useCyclicSend` 独立实现，4 种运行方式（列表循环/单条/文本逐行/执行当前行并移至下一行）。

## 快捷发送 / 命令面板

- 快捷发送条：pill 两行显示（`.op-quick-cmd-name-row`：HEX 徽标+名称在上、`.op-quick-cmd-content` 内容在下，issue #6-9）、宽度自适应（ResizeObserver + `utils/sendStrip.ts` `computeFitCount`）、首槽固定「打开命令面板」按钮（`.op-quick-panel-btn`：accent 填充按压按钮，issue #7-2）、`quickSendInlineCount` 仅 0=隐藏条。
- QuickSendPanel 双模式（列表+行内编辑 / 文本逐行发送，`usePanelCyclicSend`），文本模式含「执行当前行并移至下一行」`runCurrentLineAndAdvance`/`moveCursorToNextLine`（issue #6-3）。
- 目标串口下拉只显示串口号（去 `· REAL/VIRTUAL` 后缀，issue #7-4）；底栏「发送到」提示灯跟随真实连接状态（订阅 `serial:status` + `port-statuses:sync`：绿=连接呼吸/灰=断开，issue #7-5）。
- 弹出窗（popout）发送经 `popout:send-command` 意图 → 主窗 `sendToPort`（见 workspace.md）。

## 文件发送

- `send_file`（async：tokio::fs::read + 分块 yield）；`delay_ms==0` 时 `yield_now().await` 让出（曾饿死其它异步任务）。
- **可取消**：per-port 取消令牌（`AppState.file_send_cancel`）+ `cancel_file_send` 命令；循环每块前检查令牌。
- 循环后**无条件**清理令牌并发 `serial:file_progress{done:true}`（正常/取消/写错/空文件四路径都触发）——发送区文件按钮在传输中兼作**取消**按钮，成功 toast 由 `done` 事件驱动（sent>=total>0），取消/清空静默清进度条。

## 触发引擎（条件触发，issue #3-1）

- `src/utils/triggerEngine.ts` `evaluateTriggers`（纯函数）：pattern match（contains/exact/regex/hex）→ alert / auto-respond；per-port 经 `portId`（空=all）。
- **接线在 `useSerialReceive`**：RX 行到达时匹配触发规则；alert 是 sticky toast（`durationMs:0` 不自动关闭，标题带端口/规则上下文）；auto-respond 走 `sendToPort(..., silent=true)`；respond 失败补 debug 日志。
- 规则 300ms 防抖逐条自动落盘（`savedSnapshotRef` diff，issue #5-3）。
- 已知边界：触发匹配按**事件**粒度（跨事件拆行的 contains 匹配依赖 RX 管线成行后才有完整文本；字节级 HEX 匹配不受影响）；alert 节流为模块级 Map（规则 id → 最后时间戳），应用生命周期内有效。

## 数据流速查

| 流 | 路径 |
|---|---|
| 连接 | Sidebar.onToggleConnect → useSerialConnection.openPort → updatePort 乐观更新 → invoke open_serial_port → Rust 打开+读线程 → serial:status("connected") 事件双写回 store |
| RX | 读线程 50ms 轮询 → serial:data → RxPipeline（组装/队列/rAF）→ viewportManager.appendTerminalLines → TerminalRenderer（同帧 DOM） |
| TX | SendSection.handleSend → sendToPort（守卫+flushNow+TX 回显）→ invoke send_serial_data → 写句柄 write_all_with_deadline |
| 端口轮询 | useSerialPorts(3000) → list_available_ports → mapPortInfo → mergePorts（保序/保态/幽灵 3 轮） |
| 循环 | setCyclicLoop(portId,true) → useCyclicSend startRuntime → 每 tick 实时读 store 命令集 → sendToPort(silent) |
