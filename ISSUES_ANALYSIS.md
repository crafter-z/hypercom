# HyperCom Issue #10 / #15 诊断分析报告

**日期**：2026-08-26（基于本地仓库 `main` @ 5c06f89，工作区含未提交 TTY 性能改动，与本报告无关）
**范围**：只读分析，未修改任何 `src/` / `src-tauri/` 文件，未改动 git 状态。
**证据基准**：代码行号引用当前工作区文件；git 引用以提交哈希为准。

---

## 一、Issue #10 —— 串口输出区「鬼畜上下抖动」（OPEN，2026-08-24 创建，2026-08-26 仍更新）

### 1.1 症状

> 输出着输出着，有的时候会突然开始上下抖动，大概上下在一行范围内，抖一秒多之后就自行恢复了。

关键特征：
- **间歇性**（「偶尔」「突然」），持续约 1 秒多后自行恢复；
- **幅度约一行**（rowHeight ≈ 18px @ 14px 字号），不是大幅跳页；
- 已声称在 v0.6.3（`cf8188c`，2026-08-24）修复过（根因定为「head trim 后 DOM 行泄漏 → 每帧 O(n) → 帧率暴跌」），但 issue 仍 OPEN 且今天仍有更新——用户或维护者认为未修好/残留。

### 1.2 代码路径梳理

```
serial:data → useSerialReceive → RxPipeline.feedBytes（切行 + 入队）
  → scheduleTick（rAF）→ appendLines(portId, lines)
  → viewportManager.appendLines：
      for each line:
        beforeFirst = buffer.firstSeq
        buffer.append(line)          // 可能触发 maxLines 覆盖 / maxBytes drain（一次裁到 ≤50%）
        if (filterActive) filtered.seqs.push(seq)
        if (searchOpen) matches.seqs.push(seq)
        for (s = beforeFirst; s < buffer.firstSeq; s++) dropTrimmedSeq(s)   // 同步清理过滤/搜索列表 offset
      requestRender()                // rAF 一次
  → renderer.render(buffer, buildView())：见 TerminalRenderer.ts:230-380
      - seqToVisIdx 实时定位（cf8188c 修复）
      - stale 判定 + recycle
      - 1b DOM 排序（ae200ff 修复）
      - 2. 窗口行物化/定位/写内容
      - 3. follow 同帧钉底 scrollTop
```

渲染器关键机制（TerminalRenderer.ts）：
- 节点池复用，`active: Map<seq, ActiveRow>`，DOM 恒 ≈ 窗口 + overscan（`OVERSACAN_ROWS = 12`，行 84）；
- `seqToVisIdx`（行 453-472）：identity 模式 O(1) = `seq - firstSeq`；过滤模式对 `visibleSeqs` 二分（`visibleSeqsOffset` 起点）；
- follow 钉底（行 253-256、374-379）：`followEnabled = locked && !searchOpen`，`gestureActive` 抑制；
- 拖选冻结（`isSelecting`）：冻结期间不回收/不重写已有行、只物化新行（942f677，issue #12）；
- 缓冲区：`TerminalBuffer` 环形，`maxLines = budgetMb×500`（默认 200MB → 10 万行）、`maxBytes` 超限一次性 drain 到 ≤50%（append 内 while 循环）。

### 1.3 逐嫌疑分析（按置信度）

#### 嫌疑 A（高）：follow 钉底与内容高度突变的固有抖动 —— 结构性残留，非 #10 原 DOM 泄漏

**证据链**：

1. `TerminalBuffer.append`（TerminalBuffer.ts:74-79）——**字节预算 drain 是一次性裁到一半**：
   ```ts
   if (this.maxBytesValue > 0 && this.totalBytes > this.maxBytesValue) {
     while (this.count > 0 && this.totalBytes > this.maxBytesValue / 2) { this.dropHead(); trimmed = true; }
   }
   ```
   触发条件：**每端口 200MB 预算**。日志行典型 40~100B（`lineBytes` 计 rawData），10 万行容量（500×200）意味着 **100 万+ 行累计**（字节预算 2.1 亿 B）才触发一次 drain——单次 drain 裁掉约 50 万行，`firstSeq` 一次性前移 50 万。之后要再攒 100 万行才再裁。**这是低频大幅事件**。

2. `renderer.render` follow 路径（TerminalRenderer.ts:253-256）：
   ```ts
   const scrollTop = follow
     ? Math.max(0, totalHeight - container.clientHeight)
     : container.scrollTop;
   ```
   `totalHeight = baseCount × rowHeight`（行 246-248），`baseCount` 来自 `computeVisibleCount`（行 431-445）：identity 模式 = `frozen - firstSeq + 1`。

3. 大 trim 后同一帧：`firstSeq` 前移 50 万 → `baseCount` 骤降 → `totalHeight` 骤降 → follow 钉底 `scrollTop = totalHeight - clientHeight` **骤降约 50 万行高度**。随后数据继续到达（每帧最多 `maxLinesPerTick=2000` 行，rxPipeline.ts:360），`totalHeight` 以每帧 ≤2000×rowHeight 的速度回升，钉底 scrollTop 也随之单调回升。

4. 用户在「输出着输出着」——大概率处于 follow（locked）状态。事件序列：**正常输出（跟随，scrollTop 单调缓升）→ 字节预算越限 → 一次性裁半（scrollTop 暴跌数万 px）→ 此后 ~1 秒多持续回升**。这**精确匹配「上下抖动 + 抖一秒多自行恢复」**：突发期间视口被瞬间甩到内容顶部以下/或被内容底，随后以每帧 2000 行的速度回填，产生持续的「内容上移/滚动条跳动」观感。幅度约一行：真实溢出数据（非整行 `\n` 结尾的尾部 flush）每帧多写几行，行高抖动叠加在整体回填上。

5. **反证（为什么原 #10 修复没堵住）**：`cf8188c` 修的是「trim 后 active 行不回收 → DOM 无限增长 → 每帧 O(n) 拖垮帧率」。而本嫌疑 A 是**几何/视口数学层面**的抖动：DOM 行数有界（e2e 已验证 ≤40），但**内容总高度的大幅跳变**使 follow 钉底目标每帧移动。e2e 回归（30b6daf）只断言 `maxRows ≤ 40` 和 `scrollTop 单调不减`（`st < prevSt` 计数）——**单调性检查的是「钉底后不动」的假说，而大 trim 正好产生「单调回填」的滚动**，且单帧跳变是骤降再回升，若采样在回升段则 `st ≥ prevSt` 恒成立，测试**测不出**。`nonMonotonic` 只在用户手动滚动/搜索/拖选时才可能被置位。
   - 且 e2e 数据量：400 行 × 8ms 循环 × 10s ≈ 50 万行——恰好逼近字节预算触发线（200MB / ~70B ≈ 300 万行），10s 窗口大概率**未触发**大 drain；触发的是 `maxLines`（10 万）的**滚动覆盖**，每帧只裁 2000 行（2000×18px=3.6 万 px/帧）——**这正是逐帧小跳变**，幅度远大于 1 行，且同样不违反单调断言。

6. **另一条抖动残留路径——软兜底 `softTrim`**（viewportManager.ts:485-504 + TerminalBuffer.trimToHalf:167-176）：`evaluateSoftBackstop` 在 JS 堆 > 2048MB 时对候选端口 `softTrim()`（裁半 + `pruneTrimmed` + `requestRender`）。**这是 `softTrim` 的同步调用发生在 `appendLines` 的同一 rAF tick 内**（rxPipeline.ts:415 接线）——即一帧内 `firstSeq` 跳变，同样触发钉底目标跳变。双闸（bytes>maxBytes/2 + 10s 冷却）降低频率，但 10s 冷却期满、堆仍超限时**每 10s 抖一次**；用户报告「偶尔」「1 秒多恢复」与此可相容。

7. 附加：`acc40f0`（issue #14 内存裁剪重构）修正了记账，把软兜底恢复为「裁半」，**直接放大了单次 trim 的 firstSeq 前移幅度**（旧实现可能是别的小步裁剪）；`ae200ff` 只修排序/定位，不涉及几何跳变。这两个提交都在 #10 修复**之后**（8-25），是「修复后又复现/新抖动源」的候选引入者。

**验证方法**：
- 单测级：构造 `TerminalBuffer{maxBytes: 小值}`，fill 到越限，`render` follow 一帧，断言 `scrollTop` 单帧跳变 > 10×clientHeight（复现）；随后逐帧 append，观察 scrollTop 单调回填（持续抖动窗口）。
- e2e 级：30b6daf 的用例把 interval 数据量放大到 300 万+ 行（触发字节 drain），对 `scrollTop` 采样加一条「单帧跳变 > 2×clientHeight 即 fail」断言；再开 `memoryLimitMb` 小值 + 模拟堆超限，验证 10s 周期抖动。
- 现场：开 `console` 诊断日志（`diagLog`），抓抖动窗口内 `scrollTop / contentHeight` 突变时刻，与 trim toast（`toast.memoryTrim`）时间戳对齐。

#### 嫌疑 B（中）：`gestureActive` 状态漏复位导致的钉底竞争

**证据链**：`beginGesture`（TerminalView.tsx:154-159）`setTimeout(settle, 120ms)`，`settle` 里 `vm.endGesture()`。但 **scrollbar 拖拽/中键 autoscroll**（handlePointerDown:183-189）只 `beginGesture()`，**没有 pointerup 提前 end**——依赖 120ms settle；若 pointerup 在容器外/被 splitPane 重排打断，120ms 后照常 settle，问题不大。**真正缺口**：`beginGesture` 在 `handleWheel`（165）里对**每次滚轮事件**都调用，`settleTimer` 每次重置——持续滚动期间 `gestureActive` 恒 true（抑制钉底，符合预期）；**滚轮停止 120ms 后 settle 恢复钉底**。此路径与「抖 1 秒多」时长吻合（120ms 是 settle 延迟不是抖动时长），相关性弱于嫌疑 A，列为候选。
- 反证：此路径需要用户正在滚动/拖选，与「输出着输出着突然抖」不符；置信度中低。

#### 嫌疑 C（低）：过滤模式下的二分/offset 一致性

`seqToVisIdx`（453-472）二分起点 `lo = visibleSeqsOffset`，`hi = list.length - 1`；`dropTrimmedSeq` 同步推进 offset（viewportManager.ts:377-386），`pruneTrimmed` 在 setLimits/softTrim 后同步推进。**单线程 + 同步清理，无中间帧**，第一帧 view 里 offset 已一致。理论缺口：`recomputeFilter`/`recomputeSearch` 在 `appendLines` 的 rAF tick 之间被调用（用户改过滤条件），期间 buffer 已 trim、`filtered.seqs` 重建于新窗口——`seqToVisIdx` 二分在 `visibleSeqsOffset` 内找不到 `seq < firstSeq` 的旧行 → 返回 null → 回收，安全。**未发现会抖动的路径**，除非过滤模式 + 大 trim 同帧（嫌疑 A 的过滤版）。

#### 嫌疑 D（低）：行内容高度≠rowHeight 的视觉错位

`writeRowContent`（行 610）给 `.terminal-content` 设 `max-height: rowHeight; overflow: hidden` 防内嵌 `\n` 叠行；行高恒 `rowHeight`。CSS 无内容撑高，**无抖动**。issue #9 已修行重叠。

### 1.4 根因结论（置信度排序）

| # | 根因 | 置信度 | 关键证据 |
|---|------|--------|----------|
| A1 | **字节预算大 drain（`TerminalBuffer.append` 裁到 ≤50%）+ follow 钉底（`scrollTop = totalHeight - clientHeight` 同帧重算）→ 单帧 scrollTop 暴跌数万 px，随后以 ≤2000 行/帧回填 —— 表现为「抖一秒多自行恢复」** | **高（~0.65）** | TerminalBuffer.ts:74-79；TerminalRenderer.ts:253-256, 374-379；rxPipeline.ts:360 |
| A2 | 同上，但触发源为 **软兜底 `softTrim`**（`evaluateSoftBackstop`，10s 冷却）——周期更稀（10s），观感「偶尔」 | 中高（~0.45） | viewportManager.ts:485-504、166-174；rxPipeline.ts:415 |
| B | `gestureActive` settle 竞争（120ms）——用户滚动/拖选场景残留 | 低（~0.15） | TerminalView.tsx:154-159, 183-189 |
| C/D | 过滤 offset / 行高错位 | 低（<0.1） | 无活跃路径 |

**核心判断**：`cf8188c` 修复的「DOM 行泄漏 → O(n) 渲染」是真实且已修的（e2e 证明 DOM 有界）；**但用户报的「抖」很可能从来不是（或不只是）DOM 行数爆炸，而是缓冲裁半后总高度跳变 + follow 钉底追底的几何抖动**。修复后 `ae200ff`/`acc40f0`（issue #14）把 trim 语义改为「裁到 50%」并恢复软兜底，反而放大了单次 `firstSeq` 前移幅度，与「修复后仍复现」的时间线吻合。e2e 回归（30b6daf）只断言 DOM 有界 + scrollTop 单调，**恰好测不出「单调回填式抖动」**。

### 1.5 验证方法（不实施）

1. **单测**：`TerminalRenderer.test.ts` 新增「大 trim 单帧 scrollTop 跳变」用例（构造 maxBytes 越限，断言跳变幅度）。
2. **e2e**：30b6daf 用例加「scrollTop 单帧变化 < 阈值」断言 + 把数据量提到触发字节 drain 的量级（或改小 `memoryPerPortBudgetMb` 注入）。
3. **现场日志**：抖动时刻抓 `scrollTop`/`contentHeight` 突变 + `toast.memoryTrim` 时间戳对齐。
4. 二分排查：临时把 `maxBytes` 调极大（禁用字节 drain）对比是否不再抖——定位 A1；临时禁用 `evaluateSoftBackstop` 对比——定位 A2。

### 1.6 修复建议（仅建议）

| 建议 | 工作量 | 说明 |
|------|--------|------|
| 1. **trim 后滚动锚点稳定**：大 drain 时保持「视口底部相对内容底」或「视口顶部相对某存活 seq」的锚定，避免 follow 钉底目标瞬间移动 | 0.5~1d | 在 render 里记录 trim 前 `scrollTop` 对应 visIdx，trim 后按该 seq 恢复 scrollTop（若在 follow 中则直接按新 totalHeight 重算即可——重点是把**逐帧回填**变成**一次到位**） |
| 2. **drain 分帧化/限幅**：`append` 的字节 drain 从「一次裁到 ≤50%」改为「每帧最多裁 N 行」，或按内容高度限幅 | 0.5d | 消除单帧 50 万行跳变 |
| 3. **软兜底冷却内节流**：`evaluateSoftBackstop` 的 10s 冷却内不再重复裁同端口（已有），可加「裁后把堆占用作为下次评估基准」防周期抖动 | 0.5d | 与 1 互补 |
| 4. **e2e 补强**：scrollTop 单帧跳变断言 + 触发字节 drain 的用例 | 0.5d | 防回归 |
| 5. 若确认抖动来自「回填速度」（每帧 2000 行上限），可考虑 trim 后立即把队列清空/显示「缓冲已清空」提示而非回填 | 0.5d | 可选 UX 决策 |

---

## 二、Issue #15 —— 分屏时 `insertBefore` 渲染错误（OPEN，2026-08-26）

### 2.1 症状

> 初始：两个已打开串口，左右分屏。打开第三个串口，其标签页落在左半屏（与第一个串口同 Pane）。聚焦第三个标签，点击「左右分屏」按钮 → `Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.`

### 2.2 代码路径梳理

操作序列的状态流：

1. **初始树**：`branch[leafA(1,2), leafB(3)]`（`vertical`，A=左：tab1,tab2；B=右：tab3）；`activeTabId=1`（或 2）。
2. **打开第三个串口（tab3）**：`openTab(port3)`（useAppStore.ts:382-412）——`focusedPaneId` 命中 leafA → `tab3.splitPaneId = leafA`，`leafA.tabIds = [tab1, tab2, tab3]`，`activeTabId = tab3`，`focusedPaneId = leafA`。
3. **聚焦 tab3**（本来已 active）：Pane A 的 `displayTabId = tab3`。
4. **点击 split 按钮**（TabBar 右端 `.tab-bar-split-group`，Pane.tsx:233-234 → `onFocus()` + `splitPane('vertical')`）：
   - `splitPane`（useAppStore.ts:560-605）：`sourceLeaf = findLeafById(tree, activeTab.splitPaneId)` = leafA；**从 leafA.tabIds 移除 tab3**，`tab3.splitPaneId = newLeafId`；`sourceLeaf.size = 0.5`；`newLeaf = { tabIds: [tab3] }`；`newBranch = { children: [leafA, newLeaf] }` 替换原 branch 中 leafA 的位置。
   - `pruneTree` 后树：`branch'[ branch''[leafA(tab1,tab2), newLeaf(tab3)], leafB(tab4) ]`（嵌套分支）。

**React 渲染结果（MainDisplay.tsx renderNode）**：
- `leafB`（key=`leafB`）的 `.pane-node` **原地不动**；
- `leafA`（key=`leafA`）的 `.pane-node` **从 branch 的 children[0] 位移到新内层 branch'' 的 children[0]**——**key 不变，但它在 React 树中的父/兄弟位置变了**；
- 新增 `branch''`（key=`branch-<ts>`）与 `newLeaf`（key=`pane-<ts>`）两个新节点。

### 2.3 逐嫌疑分析（按置信度）

#### 嫌疑 A（高）：`renderNode` 的 `useCallback` 内联分支 key 稳定 + React 18 提交时序，`TerminalView` 双挂载窗口期的 `layer.insertBefore`（TerminalRenderer.ts:303）reference node 脱链

**证据链**：

1. **TerminalRenderer 是唯一在 React 之外直接操作 DOM 并调用 `insertBefore` 的代码**（全仓 grep 只有 TerminalRenderer.ts:133/303/543/545 四处，均在渲染器内部）：
   - 行 303：`layer.insertBefore(node, prev.nextSibling)`（1b DOM 排序）；
   - 行 545：`layer.insertBefore(node, target)`（insertRowInOrder 归位）。
   两个调用都可能抛 `"The node before which the new node is to be inserted is not a child of this node"`——**当 `prev.nextSibling` / `target` 已不在 `layer` 子列表内**。

2. **Pane 常驻挂载 TerminalView**（Pane.tsx:261-270）：`{visibleTabs.filter(mode!=='tty').map(tab => <TerminalView key={tab.id} ... />)}`——**`key={tab.id}`（端口 id），不是 pane/位置**。splitPane 后 leafA 仍持有 tab1、tab2（key 不变），React 会**复用**这两个 TerminalView 组件实例/子树，只移动 DOM 位置。

3. **TerminalView 的挂载 effect**（TerminalView.tsx:89-95）：
   ```ts
   useEffect(() => {
     const el = containerRef.current;
     if (!el) return;
     vm.attachRenderer(el, buildConfig());
     return () => vm.detachRenderer();
   }, [portId]);
   ```
   `vm` 是模块级 `getViewportManager(portId)`（viewportManager.ts:429-436）——**一个端口一个 manager，跨 Pane 移动时 manager 不变**，`attachRenderer`/`detachRenderer` 对同一 renderer 反复 attach/detach。

4. **双挂载窗口**：splitPane 一次 set() 同时改变 `paneTree` + `activeTabId`（`tab3.splitPaneId = newLeafId` 时 activeTab 仍是 tab3，且 `state.focusedPaneId = newLeafId`）。React 需要：旧 leafA 子树**卸载**（若 React 判定 leafA 位置变化需要重建，则先跑 TerminalView cleanup → `vm.detachRenderer()` → `contentLayer.remove()`）→ 新 branch'' 子树**挂载**（leafA 的 TerminalView 重新 attach 到**新容器** → 新建 contentLayer）。**React 18 的提交顺序（unmount → mount，或交错）不保证「detach 完成后才 attach」**——若 `attachRenderer`（新容器）与 `detachRenderer`（旧容器）交错执行，且**下一次 rAF render 在中间发生**：
   - `render()` 持旧 `contentLayer` 引用（已被 `detach()` remove 或已被新 attach 覆盖）；
   - 行 303 排序循环里 `node.previousSibling` 指向 detached 节点 → `layer.insertBefore(node, prev.nextSibling)` 抛 DOMException。
   - 即使 render 不在这中间跑，`detach()`（行 152-155）`contentLayer.remove()` 后**新 attach 创建新 layer**，旧 renderer 的 `active` Map 未清（detach 不清 active！），新 attach 后 `fullRedraw=true`，下一帧 render 排序循环对**旧 active 节点**调用 `layer.insertBefore(node, prev.nextSibling)`——`prev.nextSibling` 是旧 layer 的兄弟关系，新 layer 中 prev 的 nextSibling 是 null 或别的节点 → **reference node 不是子节点**。

5. **时间线吻合**：splitPane 点击（用户操作）→ 树突变 → React 提交 → 下一次 rAF render 撞上双挂载窗口 → 异常。**「点击分屏按钮瞬间崩溃」**精确匹配。

6. **为什么三个串口（tab3 在新 leaf）才触发**：单 Pane 内 split（只有一个 leaf）时，split 把**唯一** leaf 替换为新 branch（useAppStore.ts:598-602 根分支路径），旧 leaf 的 Pane/TerminalView **整体卸载重建**（无 key 复用同一 subtree 的位移），React 的卸载在挂载前完成，窗口不存在；而「左 Pane 在**嵌套分支内**被位移」时，leafA 的子树被复用/移动，双挂载窗口出现。用户序列（先左右分屏、再打开第三串口到左 Pane、再 split）**恰好构造了嵌套分支**。

7. **反证与排除**：
   - React 自身（react-dom.development.js:11066-11094 的 `insertBefore`）只对 **React 管理的容器**调用 `insertBefore`——错误消息里 `on 'Node'` 的接收者如果是 React 管理的 DOM，需要 React vDOM 与真实 DOM 脱节（key 冲突/未卸载残留）才会发生。**全仓无 React 外 appendChild 到 React 容器**（除渲染器 contentLayer 与 xterm）；渲染器 contentLayer 是 attach 时新建、detach 时 remove 的**非 React 子树**，React 不管理它——所以**错误最可能来自渲染器自己的 insertBefore（行 303/545）**，而非 React 内核。
   - `ContextMenu`（TabBar 的右键菜单、TerminalView 的右键菜单）用 portal？需确认——若用 `createPortal`，portal 容器是 `document.body`，不会插入 Pane 子树，排除。
   - **xterm（TtyView）**：`term.open(container)`（TtyView.tsx:94）向 React 管理的 `.tty-container` 塞入大量 xterm 子节点——**若 React 后续在该容器上做 insertBefore（例如 Pane 位移时复用 TtyView 子树），reference 是 xterm 节点 → React 认为它是子节点（它确实在），不会报错**；但若 React **移动**了容器（key 复用位移），xterm 节点跟随容器一起移动，**不脱链**。且用户场景是 TRX（三个串口 + 分屏按钮，未提 TTY 模式），TtyView 嫌疑低于渲染器。但**注意**：`visibleTabs.filter(mode!=='tty')` 与 `.filter(mode==='tty')` 两个数组**分开 map**——如果某个端口 mode 字段在 splitPane 瞬间从 `trx` 变为 `tty`（不可能，无此操作），同一 key 会从 TerminalView 换成 TtyView。排除。
   - **结论**：错误源大概率是 `TerminalRenderer` 行 303（排序循环），小概率行 545；触发窗口是 TerminalView 跨 Pane 位移时的 attach/detach 交错 + rAF render 竞态。

#### 嫌疑 B（中）：`splitPane` 嵌套分支时 React key 复用与 `focusedPaneId` 跳变导致 `displayTabId` 变化 → TerminalView `hidden` prop 翻转 → 但容器仍在

- `hidden` 只影响 `display:none`（TerminalView.tsx:365），不影响 DOM 树存在；containerRef 始终挂载。hidden 翻转不触发 attach/detach（effect deps 只有 portId）。**排除为主要路径**。

#### 嫌疑 C（中）：TtyView 常驻挂载 + xterm 非 React 子树

- 若用户当时有 TTY 模式端口（未在 issue 正文说明模式，但三个串口可能是 TRX），TtyView 常驻挂载（Pane.tsx:262-265）——**xterm 节点在 React 管理容器内，React 位移容器时 xterm 节点随容器走，不脱链**。但若 React 判定 TtyView 需要**重建**（key 变化才重建；key=tab.id 不变，不重建）。低风险。**若未来出现 TTY + 分屏崩溃，优先查 xterm 与 React 的节点归属**（xterm 内部用 canvas + 大量 div，其 `open()` 只允许一次——组件重建时 `term.dispose()` 后新实例 `open`，OK）。

#### 嫌疑 D（低）：`Pane` 空态 `useDroppable` / dnd-kit DragOverlay portal

- DragOverlay 用 portal 到 body，不插入 Pane。排除。

### 2.4 根因结论（置信度排序）

| # | 根因 | 置信度 | 关键证据 |
|---|------|--------|----------|
| A | **TerminalView 跨 Pane 位移（splitPane 嵌套分支）时，`vm` 的 renderer 在同一 rAF 窗口内 attach（新容器）/detach（旧容器）交错，`detach()` 只 remove contentLayer 不清 active Map；下一帧 `render()` 的 1b 排序循环（TerminalRenderer.ts:303）对已脱链的 `prev.nextSibling` 调 `layer.insertBefore` → `insertBefore` DOMException** | **高（~0.6）** | TerminalRenderer.ts:145-157（detach 不清 active）、303；TerminalView.tsx:89-95（effect deps 仅 portId，跨 Pane 复用同一 vm）；useAppStore.ts:560-605（splitPane 嵌套分支位移 leafA）；MainDisplay.tsx:81/102/129（key=node.id 稳定 → 子树被位移复用） |
| A' | 同一窗口，`insertRowInOrder`（行 545）`target` 脱链 | 中（~0.35） | 同上 |
| B | React vDOM/真实 DOM 脱节（key 冲突/未卸载残留）→ React 内核 insertBefore 抛错 | 低（~0.1） | 全仓 React 外 DOM 操作仅渲染器与 xterm；无 key 冲突证据 |
| C | xterm 节点归属（TTY 模式场景） | 低（~0.05） | 用户场景为 TRX，且 xterm 节点随容器移动不脱链 |

**核心判断**：报错点不在 React 内核（React 只管理它创建的容器，渲染器 contentLayer 是非 React 子树），而在 **TerminalRenderer 自己的 `layer.insertBefore`**——`detach` 后 `active` Map 不清空 + 跨 Pane 位移的双挂载窗口，让排序循环拿到脱链 reference。触发条件是「被位移的 Pane 内 TerminalView 正在被 React 移动」，而 splitPane 在嵌套分支中的 leafA 位移恰好满足。

### 2.5 验证方法（不实施）

1. **复现**：手动按 issue 步骤（两串口左右分屏 → 打开第三串口落左 Pane → 聚焦第三个标签 → 点分屏）→ 观察 console 报错栈指向 `TerminalRenderer.ts:303` 或 545（WebView2 devtools）。
2. **单测**：TerminalRenderer 新增用例——`attach(container1)` → render → `detach()` → **不 render** → `attach(container2)` → `render()` → 断言不抛异常（当前实现**应该会抛**，证明 A）。
3. **防御性断言**：在 303/545 前检查 `layer.contains(prev.nextSibling)`（或 try/catch + 跳过该行排序），复现时验证错误消失且无功能回归。
4. **结构验证**：`react-dom` 的 insertBefore 调用点（react-dom.development.js:11087-11094）——如果错误栈指向 react-dom 内部，则是嫌疑 B；指向渲染器则是 A。WebView2 的报错栈可直接区分。

### 2.6 修复建议（仅建议）

| 建议 | 工作量 | 说明 |
|------|--------|------|
| 1. **`detach()` 清空 active 池**（TerminalRenderer.ts:145-157 内加 `this.active.clear()` + `pool.length=0` 或保留池但标记失效） | 0.5h | 根治：detach 后旧 active 不再参与下一容器 render 的排序/定位 |
| 2. **排序循环防御**：`layer.insertBefore(node, prev.nextSibling)` 前加 `if (prev.nextSibling && layer.contains(prev.nextSibling))`，不满足则 `layer.appendChild(node)` | 0.5h | 防同类窗口再次抛错（视觉降级而非崩溃） |
| 3. **TerminalView effect 改为「容器变化才 attach」+ 显式双阶段**（先 detach 旧容器再 attach 新容器，同帧内完成） | 1h | 消除竞态窗口；可用 `useLayoutEffect` 保证提交前完成 |
| 4. **splitPane 保持子树 key 稳定**：嵌套分支位移时给 leafA 的 `.pane-node` 换 key（如 `key={parentBranch.id + ':' + node.id}`），强制 React 重建子树而非复用位移——牺牲局部状态（TerminalView 重建→vm 重 attach，仍安全） | 1h | 备选；改变 React 位移行为，需回归拖拽/选中 |
| 5. **e2e 补测**：splitPane 在嵌套分支场景（左 Pane 两标签 + 右 Pane 一标签 → 聚焦左 Pane 标签 → split）断言无 console error | 1d | 防回归 |

---

## 三、共性问题小结

1. **两个 issue 都指向「渲染器/终端视图的生命周期与 React 树的位移不同步」**：#10 是缓冲几何突变与 follow 钉底的同步缺口，抖动可见但 DOM 有界（e2e 断言盲区）；#15 是 renderer attach/detach 与 React 子树位移的竞态窗口，直接崩溃。共同教训：**TerminalRenderer 的状态（active Map、contentLayer、lastRenderedSeq）与挂载容器强耦合，但生命周期由 React 副作用驱动，缺少「容器归属」的权威校验**。
2. **e2e 覆盖盲区**：30b6daf 只断言 DOM 有界 + scrollTop 单调，测不出「单调回填式抖动」；没有覆盖「嵌套分支内 Pane 位移 + 双挂载窗口」的渲染竞态。建议在 e2e 增加：① scrollTop 单帧跳变阈值断言；② splitPane 嵌套分支场景 + console error 监听；③ 高频 RX + 字节预算小值注入下的稳定性。
3. **修复优先级**：#15 是崩溃（高优，0.5d 内可修）；#10 是体验问题（中优，根因 A1/A2 已定位，修复建议 1~2 工作量小）。
4. **后续改动方向**：给 TerminalRenderer 增加「attach 归属」状态（记录当前 container id，render 前校验 layer 仍挂载、active 节点都在 layer 内，否则安全重初始化）——同时覆盖 #10 的几何抖动与 #15 的脱链崩溃。

---

## 更新（2026-08-26，提交 5803552 / 89cd2cc 之后）

本报告的 #10/#15 OPEN 结论已被后续提交修复（5803552 fix(ui): 输出区上下抖动 + 分屏 insertBefore 渲染崩溃；89cd2cc 记录分析结论）。本文档作为历史诊断记录保留，**结论部分已过时**——当前实现以 `src/utils/terminal/` 方案B 渲染引擎与 AGENTS.md 版本章节为准。
