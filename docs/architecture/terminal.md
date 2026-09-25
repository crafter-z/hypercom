# 终端显示模块（TRX）

TRX 行级终端的行缓冲与渲染，**脱离 React 调度**（方案B 引擎，issue #14，v0.6.0）。数据路径：`serial:data` → `RxPipeline`（字节级行聚合 + rAF 批写）→ `viewportManager.appendTerminalLines` → `TerminalBuffer`（环形缓冲区）→ 同一 rAF 内 `TerminalRenderer.render`（直接 DOM）。TTY 模式见 [`tty.md`](tty.md)。

## 核心模块

| 模块 | 文件 | 职责 |
|---|---|---|
| `TerminalBuffer` | `src/utils/terminal/TerminalBuffer.ts` | 环形缓冲区：O(1) 追加/裁剪、稳定 seq（裁剪只移动 [firstSeq,lastSeq] 窗口，存活行 seq 不变）、`maxLines` 行容量（超限**逐行覆盖最旧**，滚动窗口，issue #16 改版）、`snapshot`/`replaceAll`/`clear`/`setLimits` |
| `TerminalRenderer` | `src/utils/terminal/TerminalRenderer.ts` | 直接 DOM 引擎（issue #18 流式布局重构）：contentLayer = `[headSpacer][行…][tailSpacer]`，行是**普通文档流**子元素（固定行高），spacer 承载屏外空间——**DOM 顺序 == 视觉顺序由结构保证**（旧 absolute+translateY 格子与整套顺序维护机制——insertRowInOrder/每帧排序修复/脱链防御——结构性删除）；新行只相对 spacer 或更大 visIdx 的行插入（`findFlowAnchor`，含已停车行）；**选区钉住**：活选区触及的行永不回收/不重写——窗内=文档流行、窗外=**原地停车**（`display:none`，同父不换父，探针证实 Chromium 换父即丢选区），`selectionchange` 监听器在选区消失后下一帧回收停车行，`MAX_PINNED_ROWS=600` 超限优雅降级；同帧钉底、大 trim 锚点恢复（`setLimits` 收缩触发，`LARGE_TRIM_ROWS`）、`seqToVisIdx`/`visIdxToSeq` 支持过滤列表、frozen null 归一化全部保留 |
| `TerminalViewportManager` | `src/utils/terminal/viewportManager.ts` | 每端口枢纽：`TerminalBuffer` + renderer 生命周期（attach/detach/dispose）+ **增量过滤/搜索**（新行 append 时匹配一次并入列，不整缓冲重扫）+ 暂停（frozenSeq）+ 选区/锁定/手势透传 + rAF 调度 + `subscribe`（渲染 pass 通知 React 壳刷新读数）+ matchSet 按 (offset,length,currentMatch) 缓存（免每帧 new Set） |
| 适配面 | `viewportManager.ts` 模块级函数 | `appendTerminalLine(s)`/`clearTerminal`/`replaceTerminalLines`/`snapshotTerminalLines`/`releaseViewportManager`/`getViewportManager`——非 React 调用方（TX 回显/工具输出/回放/弹窗/热键）一律走这里，**不再碰 useTerminalStore 的行 API** |

## 关键不变式

- **React 不渲染行**：contentLayer 是命令式 DOM，TerminalView 壳重渲染不会触碰它。
- **标签切换保留缓冲**：Pane 对 TRX 标签常驻挂载（hidden prop → display:none），viewportManager 模块注册表持有实例；关闭标签/TRX→TTY 切换才 `releaseViewportManager`。
- **关闭标签页 = 前端显示目标销毁、串口连接保留（issue #11）**：`Pane.cleanupClosedTab` 不再调 `closePort`（后端日志由 LogManager 独立落盘），改 `getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` + `releaseViewportManager(tabId)` + `releaseTerminalState(tabId)`（store 侧 terminals / trafficStats / TX 历史统一回收）；批量关闭（左/右/其它）先用 `getClosingTabIds(tabId, scope)` 取 store 关闭动作的同一集合，再跑同一套 cleanup——两处不会漂移。`appendTerminalLines/appendTerminalLine/replaceTerminalLines` 是「manager 存在才写入」——标签关闭后 RX 继续到达时**静默丢弃**（不复活 manager、不积压），重开标签页从零开始。
- **惰性解码**：RX 行只存 `rawData`（`Uint8Array`），`getLineText(line, encoding)`（`src/utils/lineText.ts`，全仓唯一的 TextDecoder 工厂 + 模块级缓存，`ignoreBOM:false`）按当前编码解码；编码切换 = 重渲染，无 store 遍历。
- **内存上限**：`computeBufferLimits()`（从 `config.maxDisplayLines` 派生 `{ maxLines }`，缺省 100000、下限 1000）在 manager 创建时读取；配置变更由 App.tsx effect 经 `applyLimits({maxLines})` 同步到现存实例。

## 渲染正确性陷阱（历史缺陷 → 现状约束）

- **frozen 归一化**：frozen 参数为 null 时必须归一化为 `Number.MAX_SAFE_INTEGER`（原始 `seq > null` 会把所有行判为隐藏）。
- **stale 判定用实时列表位置（issue #10）**：head trim 前进 firstSeq（及 filtered.offset）后，active 行缓存的 visIdx 字段整体过期——stale 检查若按字段判定，被裁行/幸存行永不回收 → **DOM 行数无限增长**（e2e 实测 6669 vs 正常 27）、每帧 O(n) 渲染 → 输出区上下抖动。`seqToVisIdx`（identity O(1)、过滤模式**二分**）是每帧 stale 检查的唯一判定来源，越界即回收。修复后 DOM 恒 ≤ 窗口+overscan（e2e 断言 ≤40）。
- **选区钉住替代全局冻结（issue #18）**：旧 `isSelecting` 全局冻结（拖选期间停一切回收/重写）+ `setSelecting` API 已删。新语义：活选区触及的行（`captureSelectionSeqSpans` 把 Range 端点映射到 seq 区间）**永不回收、永不重写、永不换父**——窗外停车 `display:none`（同父，Chromium 探针证实 remove+换父即丢 Range，删除非端点行只裁剪）；`document.selectionchange` 监听器在选区消失时清 pins 并调度渲染；**停车行占真实文档流槽位**——`findFlowAnchor` 必须把停车行当插入锚点候选（曾漏 → 复现乱序 [30..35, 8..29, 36..44]），只跳过 seqToVisIdx 为 null（已被裁出缓冲）的行；**`Selection.toString()` 按布局可见性序列化**（Chromium）——停车行文本会从中消失，右键菜单复制路径用 `selectionText()`（`Range.cloneContents` 纯树克隆，`terminalContextMenu.ts` 导出）；`MAX_PINNED_ROWS=600` 超限（拖选+滚轮延伸）优雅放弃 pins。soak 测试（`TerminalRenderer.soak.test.ts`）随机操作序列按编号断言结构化不变式（R1–R6：DOM 有界/可见行 seq 升序/seq 在窗内或停车/spacer 对齐/data-seq 唯一/过滤列表一致）。完整 R1–R15 渲染契约见下节清单（`TerminalRenderer.ts` 文件头注释逐条给出「为什么」与违反症状）。

### TerminalRenderer 渲染契约（R1–R15）

契约注释在 `src/utils/terminal/TerminalRenderer.ts` 文件头；`TerminalRenderer.soak.test.ts` 按编号引用并结构化断言 R1–R6，R7–R15 由对应操作路径覆盖。

| 编号 | 不变式（一句话摘要） |
|---|---|
| R1 | 流序：layer 子节点为 `[headSpacer][按 visIdx 排序的行][tailSpacer]`，DOM 顺序 == 视觉顺序（结构保证）。 |
| R2 | DOM 有界：至多 窗口行 + OVERSCAN + 停车钉住（+ POOL_CAP 池），逐帧不累积。 |
| R3 | 每行的 `data-seq` 在活缓冲窗口内，或该行已停车（`display:none`）。 |
| R4 | spacer 承载屏外空间：两者 ≥0、按行高对齐、空缓冲时为 0；layer 自身高度从不写 inline。 |
| R5 | `data-seq` 存在、数值、唯一；空缓冲 ⇒ 零行。 |
| R6 | 过滤列表激活时，每个**可见** seq 都是列表成员（停车钉住行豁免）。 |
| R7 | stale 判定只用**实时** `seqToVisIdx`，不信缓存 visIdx 字段（issue #10）。 |
| R8 | `frozenSeq === null` 归一化为 `Number.MAX_SAFE_INTEGER` 再比较。 |
| R9 | 阅读位置锚定：head 前进且非跟随/非手势/无选区时，按 `anchorSeq` 还原 scrollTop（锚点被裁则 clamp/就近）。 |
| R10 | 跟随钉底在 `render()` 内同帧完成（padding 感知、浏览器绘制前）。 |
| R11 | 暂停（`frozenSeq !== null`）抑制跟随钉底，`locked` 仍为 true。 |
| R12 | 选区钉住：活 Range 触及的行永不换父；`findFlowAnchor` 必须把停车行当锚点候选。 |
| R13 | 钉住行跳过内容重写；结构性变更清 pins；超 `MAX_PINNED_ROWS` 自弃（不钉住无界 DOM）。 |
| R14 | 固定行高、零测量：几何只来自 `config.rowHeight`，行内容不换行（宽行横向滚动）。 |
| R15 | 行 DOM 结构镜像 `TerminalRow`：`.terminal-line` + 可选 `.terminal-timestamp`、`.terminal-direction`、`.terminal-content`。 |

## 滚动锁定 / 快捷跳转

- `scrollLocked` 仅由图钉按钮/跳转按钮/手势 settle 写入，**无 onScroll 隐式解锁**。
- 跟随路径由 `TerminalRenderer` **同帧钉底**（render() 内 scrollTop = totalHeight - clientHeight，无 React effect、无双 rAF 链；搜索栏打开时 followEnabled=false 抑制）。
- settle/抑制/锁定迁移逻辑下沉纯函数 `isAtBottom`/`shouldFollow`（`utils/followLogic.ts`）；钉底目标值本身由 `TerminalRenderer.render` 内联计算（padding 感知、同帧写 scrollTop），不再有第二份纯函数拷贝。
- 到顶/搜索跳转走 manager 的 `scrollToSeq(seq, align)`（到顶 = `scrollToSeq(buffer.firstSeq, 'start')` 且解锁；到底 = `scrollToBottom()` 且锁定），renderer 内直接写 scrollTop——方案B 已没有第三方虚拟化（@tanstack 虚拟列表与 `countRef` 一并删除）；跳转按钮钉在滚动条两端（到顶解锁、到底点亮）。
- 手势 settle：滚轮/滚动键/滚动条拖拽/中键，120ms 静默后按 atBottom 50px 容差判定。
- 已知平台降级：Linux WebKitGTK 原生滚动条可能不派发 pointerdown——滚动条拖拽解锁在该平台静默失效，滚轮/键盘/图钉不受影响。

## 多编码

- RX 切行/解码/批写统一走 `RxPipeline`；解码器**单一来源** `src/utils/lineText.ts`（`decodeBytes` 模块级按 label 缓存 `ignoreBOM: false` —— 行首 BOM 是编码标记，被剥离，不进入行文本/搜索/复制；ttyService 的流式解码器由同一个 `createDecoder` 工厂构建，因持残字节而 per-port 独占）；GBK 后端 `encoding_rs::GBK`，前端 `TextDecoder` + `setTerminalEncoding`。
- 切换编码：`setTerminalEncoding` 只更新 label——RX 行只存 `rawData`，渲染/搜索/过滤/复制在下次读该行时按新 label 惰性解码（**无**存量行遍历）。
- 编码切换前必须 `flushAndReset`（旧编码冲刷尾部落盘 + 重置组装器），否则尾字节被新 label 直接解码、缝合处乱码（GBK 尾字节被当 UTF-8 首字节）。解码器是共享缓存且非流式、不留残字节，故无需清理。

## 语法高亮与协议字段着色

- **高亮引擎**：`src/utils/highlightEngine.ts`（纯函数）+ `useRuleStore.highlightRuleSets`。按集 `isEnabled` 过滤，遍历规则（isRegex → RegExp exec / 关键词 → indexOf 循环），收集 HighlightMatch[] 按位置排序去重（优先最长匹配），构建 `<span style="color:...">` HTML——`escapeHtml` 防 XSS + `dangerouslySetInnerHTML` 注入。**从不读 `activeHighlightSetId`**（RulesSection 移除后该字段已删）。
- **协议解析**：`src/utils/protocolParser.ts`——`ProtocolFrameReassembler.feed()` 返回**有序段数组**（`ReassemblerSegment[]`，`{kind:'frame'|'raw'}`，相邻 raw 合并），不再是 `{frames, flushedBytes}`（帧前裸字节曾排在所有帧之后渲染，字节流顺序错乱）。帧解析：验证帧头/读取长度字段（totalFrameLength = lengthValue - adjust + fieldSize）/验证帧尾/计算校验和（sum8/xor8/crc8）→ 构建 ParsedField[]（Header/Length/Payload/Checksum/Footer + 颜色）。per-port reassembler 存 useRef Map，端口断开清理。
- 渲染：`line.parsedFields` 存在 → `renderProtocolLine`（hex 模式每字段字节 → 2 字符 hex；text 模式 TextDecoder 解码 + escapeHtml）；否则 `applyHighlightSets` 原路径。

## 终端搜索

- `terminalSearch.ts` `markSearchMatchesInHtml`：HTML tag/实体感知的 `<mark>` 叠加层，只在命中行（每屏 ~50 行）应用，兼容用户高亮 span 与协议着色（跨界匹配自动拆段），当前匹配行 current 加强样式。
- 匹配计算**仅搜索栏打开时进行**，且只有一份实现（`viewportManager.recomputeSearch`）：新行在 append 时匹配一次并入列，查询/编码变化才整缓冲重扫；缓冲头部裁剪只 bump 列表 offset——不需要「前缀收窄」缓存，也没有需要校验的 lineCount。
- `terminalSearch.ts` 只负责单行搜索文本（HEX 显示走 `hexFormat.bytesToSpacedHex`）与 `markSearchMatchesInHtml` 字符级叠加，不再提供第二套匹配扫描。
- 已知边界：关闭搜索栏期间按 F3 重新打开时首次导航需再按一次（匹配在打开后才计算——「不后台全缓冲扫描」的代价）。

## 最大显示行数（issue #16 改版）

- `maxDisplayLines` = 每端口终端最大显示行数（默认 100000，clamp [1000,1000000]；Rust `max_display_lines` + `#[serde(default)]` 缺省回退）。**删除** `memoryLimitMb`/`memoryPerPortBudgetMb` 双内存预算——升级时 `ConfigManager::new` 的 `strip_legacy_memory_budget_keys` 显式剥离旧配置项。
- 缓冲超限**逐行覆盖最旧一条**（滚动窗口，firstSeq 每 append +1）；`appendLines`/`appendTerminalLines` 返回 boolean；**无「因内存限制清屏」toast**（逐行覆盖是常态滚动，不是异常事件——issue #16 曾整夜误报的根因）。
- 状态栏内存显示「JS堆 XMB · 进程 YMB」（无总预算分母）；`load_status` 只按 CPU>90 判 high_load。

## 显示态归属

- 每端口显示态（`scrollLocked`/`displayFormat`/`encoding`/`showTimestamp`）在 `useTerminalStore`，**不在** `useOperationStore`。显示控件（TerminalFilterBar、编码下拉）经 `useTerminalStore.getState().setTerminalConfig(portId, ...)` / `setTerminalEncoding` 写入。行缓冲在 `TerminalViewportManager` 环形缓冲区，store 无行数组、无 Immer、不随数据更新。
