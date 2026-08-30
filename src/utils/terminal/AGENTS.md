# src/utils/terminal — 方案B 终端显示引擎（issue #14）

TRX 终端的行缓冲与渲染层。**React 不渲染行**——数据到达后由本目录的引擎在同一 rAF 内完成「入缓冲 → 画 DOM」。

## 模块职责

|文件|职责|测试|
|---|---|---|
|`TerminalBuffer.ts`|环形缓冲区：O(1) 追加/裁剪、稳定 seq、`maxLines` 行容量（超限**逐行覆盖最旧**，滚动窗口，issue #16 改版）、`snapshot`/`replaceAll`/`clear`/`setLimits`|`TerminalBuffer.test.ts`|
|`TerminalRenderer.ts`|直接 DOM 渲染：节点池复用、固定行高零测量、`visibleSeqsOffset`、同帧钉底、过滤/搜索/选区类名|`TerminalRenderer.test.ts`（jsdom）|
|`viewportManager.ts`|每端口枢纽：缓冲 + renderer 生命周期 + 增量过滤/搜索 + rAF 调度 + 模块级实例注册表 + 非 React 适配函数|`viewportManager.test.ts`|

依赖方向：`viewportManager → { TerminalBuffer, TerminalRenderer, lineFilter, lineText, terminalSearch }`。
**禁止** viewportManager 被 stores 反向依赖（useTerminalStore 不 import 本目录——manager 单向读 store 的显示态）。

## 数据流

```
serial:data → RxPipeline（字节切行 + 队列 + rAF tick）
  → viewportManager.appendTerminalLines(portId, lines)   ← RxPipeline 的 appendLines 目标
    → buffer.append × N（增量匹配 filter/search 列表）
    → requestRender → rAF → renderer.render(buffer, buildView())
```

TX 回显/工具输出/日志回放 → `appendTerminalLine(portId, line)`（同一入口）。
弹窗快照：主窗 `snapshotTerminalLines` 发送 / 弹窗 `replaceTerminalLines` 接收。

## 关键不变式与陷阱

1. **seq 是渲染键**：append 分配单调递增 seq；头部裁剪只移动 `[firstSeq, lastSeq]` 窗口，
   存活行 seq 不变 → renderer 不重画未变行。`clear()` 不重置 nextSeq（seq 永不复用）。
2. **frozen null 归一化**：`seqToVisIdx`/`visIdxToSeq` 收到 `frozen = null` 必须归一化为
   `Number.MAX_SAFE_INTEGER`——原生 `seq > null`（null→0）会把所有行判为隐藏。
3. **节点池必须重新挂载 + DOM 顺序 == 视觉顺序**：`recycle` 把节点从 DOM 移除入池；
   `acquire` 复用池节点时节点脱离文档，插入统一走 **`insertRowInOrder`（按 visIdx
   归位）**——仅 appendChild 会把补位行堆到 contentLayer 末尾，向上滚动补位时 DOM
   顺序颠倒，浏览器跨行拖拽选择按 DOM 顺序拼接选区 → 视觉中间的行被跳过（真实 bug，
   回归测试 `keeps DOM order == visual order` 覆盖）。
4. **`visibleSeqsOffset`**：过滤列表从头部被缓冲裁剪时只 bump offset（O(1)），
   超过 `COMPACT_THRESHOLD = 4096` 才 splice 压缩——append 摊还 O(1)。renderer 用
   offset 索引过滤列表，勿在 manager 外直接改 `filtered.seqs`。
5. **增量过滤/搜索**：新行在 `appendLines` 内匹配一次并入列；过滤条件变化才整缓冲重扫
   （`recomputeFilter`/`recomputeSearch`）。搜索只在 `searchOpen && query` 时维护。
6. **同帧钉底**：`followEnabled = locked && !searchOpen`；钉底在 `render()` 内设置
   scrollTop（0 帧延迟）。手势期间 `gestureActive=true` 抑制钉底；settle 由 TerminalView
   在 120ms 静默后评估 atBottom → 写 store scrollLocked。
7. **实例生命周期**：模块级 `managers` Map 持有每端口实例；TerminalView 挂载时
   `attachRenderer(container, config)`、卸载时 `detachRenderer()`（缓冲保留）；
   **只有**标签关闭 / TRX→TTY 模式切换调 `releaseViewportManager`（销毁缓冲）。
   弹窗是独立 webview → 独立模块作用域 → 独立注册表（与 RxPipeline 单例同款隔离）。
8. **订阅**：`manager.subscribe(fn)` 在每次渲染 pass 后通知；React 壳（TerminalView）
   用它刷新 FilterBar 计数/搜索读数——不要轮询 store。
9. **测试环境**：TerminalRenderer 测试需 jsdom（文件头 `@vitest-environment jsdom`）；
   Buffer/Manager 是纯逻辑，node 环境即可。

10. **裁剪语义（issue #16 改版）**：终端缓冲只由用户配置的**最大显示行数**
    （`maxDisplayLines` → `maxLines`）约束。`append` 返回 `{seq, trimmed}`——
    满 `maxLines` 后每 append **逐行覆盖最旧一条**（滚动窗口，`trimmed=true`）。
    无字节预算、无 half-trim、无应用级软兜底、无「因内存限制清屏」toast
    （逐行覆盖是常态滚动，不是异常事件）。`viewportManager.appendLines` /
    `appendTerminalLines` 返回 boolean（是否发生覆盖），RxPipeline 不再消费该
    返回值弹通知。`computeBufferLimits()` 从 `config.maxDisplayLines` 派生
    `{ maxLines }`（缺省 100000，下限 1000）。

## 编辑纪律

- 大块结构变更用整文件 `write`（edit 工具的多行块匹配在本目录多次损坏文件）。
- 改动后先跑 `npx vitest run src/utils/terminal/`（58 测试）再跑全量。
- 行为变化必须补测试：seq 稳定性、池复用、offset 压缩、frozen null、裁剪通知。
