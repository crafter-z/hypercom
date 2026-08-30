# 终端显示模块（TRX）

TRX 行级终端的行缓冲与渲染，**脱离 React 调度**（方案B 引擎，issue #14，v0.6.0）。数据路径：`serial:data` → `RxPipeline`（字节级行聚合 + rAF 批写）→ `viewportManager.appendTerminalLines` → `TerminalBuffer`（环形缓冲区）→ 同一 rAF 内 `TerminalRenderer.render`（直接 DOM）。TTY 模式见 [`tty.md`](tty.md)。

## 核心模块

| 模块 | 文件 | 职责 |
|---|---|---|
| `TerminalBuffer` | `src/utils/terminal/TerminalBuffer.ts` | 环形缓冲区：O(1) 追加/裁剪、稳定 seq（裁剪只移动 [firstSeq,lastSeq] 窗口，存活行 seq 不变）、`maxLines` 行容量（超限**逐行覆盖最旧**，滚动窗口，issue #16 改版）、`snapshot`/`replaceAll`/`clear`/`setLimits` |
| `TerminalRenderer` | `src/utils/terminal/TerminalRenderer.ts` | 直接 DOM 引擎：节点池复用（recycle 从 DOM 移除→acquire 重新挂载，插入统一走 **insertRowInOrder 按 visIdx 归位**——DOM 顺序 == 视觉顺序，否则跨行拖拽选择中间行被跳过）、固定行高零测量、`visibleSeqsOffset` 惰性压缩、同帧钉底（followEnabled && !gestureActive 时 scrollTop 在 render() 内设置）、`seqToVisIdx`/`visIdxToSeq` 支持过滤列表、frozen null 归一化（`Number.MAX_SAFE_INTEGER` 防 `seq > null` 误判） |
| `TerminalViewportManager` | `src/utils/terminal/viewportManager.ts` | 每端口枢纽：`TerminalBuffer` + renderer 生命周期（attach/detach/dispose）+ **增量过滤/搜索**（新行 append 时匹配一次并入列，不整缓冲重扫）+ 暂停（frozenSeq）+ 选区/锁定/手势透传 + rAF 调度 + `subscribe`（渲染 pass 通知 React 壳刷新读数） |
| 适配面 | `viewportManager.ts` 模块级函数 | `appendTerminalLine(s)`/`clearTerminal`/`replaceTerminalLines`/`snapshotTerminalLines`/`releaseViewportManager`/`getViewportManager`——非 React 调用方（TX 回显/工具输出/回放/弹窗/热键）一律走这里，**不再碰 useTerminalStore 的行 API** |

## 关键不变式

- **React 不渲染行**：contentLayer 是命令式 DOM，TerminalView 壳重渲染不会触碰它。
- **标签切换保留缓冲**：Pane 对 TRX 标签常驻挂载（hidden prop → display:none），viewportManager 模块注册表持有实例；关闭标签/TRX→TTY 切换才 `releaseViewportManager`。
- **关闭标签页 = 前端显示目标销毁、串口连接保留（issue #11）**：`Pane.cleanupClosedTab` 不再调 `closePort`（后端日志由 LogManager 独立落盘），改 `getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` + `releaseViewportManager`；`appendTerminalLines/appendTerminalLine/replaceTerminalLines` 是「manager 存在才写入」——标签关闭后 RX 继续到达时**静默丢弃**（不复活 manager、不积压），重开标签页从零开始。
- **惰性解码**：RX 行只存 `rawData`（`Uint8Array`），`getLineText(line, encoding)`（`src/utils/lineText.ts`，模块级 TextDecoder 缓存）按当前编码解码；编码切换 = 重渲染，无 store 遍历。
- **内存上限**：`computeBufferLimits()`（从 `config.maxDisplayLines` 派生 `{ maxLines }`，缺省 100000、下限 1000）在 manager 创建时读取；配置变更由 App.tsx effect 经 `applyLimits({maxLines})` 同步到现存实例。

## 渲染正确性陷阱（历史缺陷 → 现状约束）

- **frozen 归一化**：frozen 参数为 null 时必须归一化为 `Number.MAX_SAFE_INTEGER`（原始 `seq > null` 会把所有行判为隐藏）。
- **stale 判定用实时列表位置（issue #10）**：head trim 前进 firstSeq（及 filtered.offset）后，active 行缓存的 visIdx 字段整体过期——stale 检查若按字段判定，被裁行/幸存行永不回收 → **DOM 行数无限增长**（e2e 实测 6669 vs 正常 27）、每帧 O(n) 渲染 → 输出区上下抖动。`seqToVisIdx`（identity O(1)、过滤模式**二分**）是每帧 stale 检查的唯一判定来源，越界即回收。修复后 DOM 恒 ≤ 窗口+overscan（e2e 断言 ≤40）。
- **拖选冻结只保护已有行（issue #12）**：selecting 期间**新**行照常物化（acquire + `insertRowInOrder` + 写内容）——滚动新进视口的行必须可见可选；仅**已有**行冻结（不回收/不重写 innerHTML，保浏览器选区 Range 锚点）。

## 滚动锁定 / 快捷跳转

- `scrollLocked` 仅由图钉按钮/跳转按钮/手势 settle 写入，**无 onScroll 隐式解锁**。
- 跟随路径由 `TerminalRenderer` **同帧钉底**（render() 内 scrollTop = totalHeight - clientHeight，无 React effect、无双 rAF 链；搜索栏打开时 followEnabled=false 抑制）。
- settle/抑制/锁定迁移逻辑下沉纯函数 `isAtBottom`/`computePinTarget`/`becameLocked`/`shouldFollow`（`utils/followLogic.ts`）。
- 到顶/搜索跳转这类用户一次性滚动走 `scrollToIndex`（@tanstack 对未测量尾行走 10 次重试刷日志——跟随路径已改原始 scrollTop 测量钉底，`countRef` 已删除）；跳转按钮钉在滚动条两端（到顶解锁、到底锁定并点亮）。
- 手势 settle：滚轮/滚动键/滚动条拖拽/中键，120ms 静默后按 atBottom 50px 容差判定。
- 已知平台降级：Linux WebKitGTK 原生滚动条可能不派发 pointerdown——滚动条拖拽解锁在该平台静默失效，滚轮/键盘/图钉不受影响。

## 多编码

- RX 切行/解码/批写统一走 `RxPipeline`（每端口按 label 缓存 decoder，`ignoreBOM:true`）；GBK 后端 `encoding_rs::GBK`，前端 `TextDecoder` + `setTerminalEncoding`。
- 切换编码 live re-decode：`setTerminalEncoding` 更新 encoding + 从 `rawData` 重解码全部存量行。
- 编码切换前必须 `flushAndReset`（旧编码冲刷尾部落盘 + 重置组装器/解码器），否则尾字节被新 label 直接解码、缝合处乱码（GBK 尾字节被当 UTF-8 首字节）。

## 语法高亮与协议字段着色

- **高亮引擎**：`src/utils/highlightEngine.ts`（纯函数）+ `useRuleStore.highlightRuleSets`。按集 `isEnabled` 过滤，遍历规则（isRegex → RegExp exec / 关键词 → indexOf 循环），收集 HighlightMatch[] 按位置排序去重（优先最长匹配），构建 `<span style="color:...">` HTML——`escapeHtml` 防 XSS + `dangerouslySetInnerHTML` 注入。**从不读 `activeHighlightSetId`**（RulesSection 移除后该字段已删）。
- **协议解析**：`src/utils/protocolParser.ts`——`ProtocolFrameReassembler.feed()` 返回**有序段数组**（`ReassemblerSegment[]`，`{kind:'frame'|'raw'}`，相邻 raw 合并），不再是 `{frames, flushedBytes}`（帧前裸字节曾排在所有帧之后渲染，字节流顺序错乱）。帧解析：验证帧头/读取长度字段（totalFrameLength = lengthValue - adjust + fieldSize）/验证帧尾/计算校验和（sum8/xor8/crc8）→ 构建 ParsedField[]（Header/Length/Payload/Checksum/Footer + 颜色）。per-port reassembler 存 useRef Map，端口断开清理。
- 渲染：`line.parsedFields` 存在 → `renderProtocolLine`（hex 模式每字段字节 → 2 字符 hex；text 模式 TextDecoder 解码 + escapeHtml）；否则 `applyHighlightSets` 原路径。

## 终端搜索

- `terminalSearch.ts` `markSearchMatchesInHtml`：HTML tag/实体感知的 `<mark>` 叠加层，只在命中行（每屏 ~50 行）应用，兼容用户高亮 span 与协议着色（跨界匹配自动拆段），当前匹配行 current 加强样式。
- 匹配计算**仅搜索栏打开时进行**；`findMatchesIncremental` 前缀收窄（继续输入只重扫「旧匹配 ∪ 新增行」）。
- 已知边界：关闭搜索栏期间按 F3 重新打开时首次导航需再按一次（匹配在打开后才计算——「不后台全缓冲扫描」的代价）。

## 最大显示行数（issue #16 改版）

- `maxDisplayLines` = 每端口终端最大显示行数（默认 100000，clamp [1000,1000000]；Rust `max_display_lines` + `#[serde(default)]` 缺省回退）。**删除** `memoryLimitMb`/`memoryPerPortBudgetMb` 双内存预算——升级时 `ConfigManager::new` 的 `strip_legacy_memory_budget_keys` 显式剥离旧配置项。
- 缓冲超限**逐行覆盖最旧一条**（滚动窗口，firstSeq 每 append +1）；`appendLines`/`appendTerminalLines` 返回 boolean；**无「因内存限制清屏」toast**（逐行覆盖是常态滚动，不是异常事件——issue #16 曾整夜误报的根因）。
- 状态栏内存显示「JS堆 XMB · 进程 YMB」（无总预算分母）；`load_status` 只按 CPU>90 判 high_load。
## 显示态归属

- 每端口显示态（`scrollLocked`/`displayFormat`/`encoding`/`showTimestamp`）在 `useTerminalStore`，**不在** `useOperationStore`。显示控件（TerminalFilterBar、编码下拉）经 `useTerminalStore.getState().setTerminalConfig(portId, ...)` / `setTerminalEncoding` 写入。行缓冲在 `TerminalViewportManager` 环形缓冲区，store 无行数组、无 Immer、不随数据更新。
