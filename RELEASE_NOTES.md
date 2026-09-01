# HyperCom v0.6.6

## 新特性
- 终端引擎改流式布局（issue #18）：`contentLayer` 改为 `[headSpacer][行][tailSpacer]` 文档流，**DOM 顺序 == 视觉顺序**由结构保证；`insertRowInOrder` / 每帧排序修复 / 脱链防御整体删除，渲染路径大幅简化
- 选区钉住替代 isSelecting 全局冻结（issue #18）：活选区触及的行**永不回收/重写/换父**，滚出视口原地停车 `display:none`，`selectionchange` 自动回收，`MAX_PINNED_ROWS` 上限自限——删除 `setSelecting` API 链（renderer/manager/TerminalView 三层）
- 复制路径改 `selectionText()`（Range.cloneContents 纯树克隆）：`Selection.toString()` 按布局可见性序列化、停车行文本会消失，新路径不受影响

## Bugfix
- 修复拖选期间滚动后选区起点丢失（issue #17）：release 后渲染正常回收滚出视口的行，若该行是浏览器原生选区 Range 的锚定节点（拖选起点行），`node.remove()` 会让 Chromium 清空/漂移选区。修复：回收分支跳过被活选区 Range 命中的行（`captureLiveSelectionRanges` + `intersectsNode`），用户点击清选区后下一帧自然回收；全选（Range 端点=容器）除外避免钉住整个 DOM

## 其他
- 搜索匹配缓存：`matchSet` 按 `(offset,length,currentMatch)` 缓存免每帧 `new Set`，`recomputeSearch`/`clear` 显式失效（同命中数换查询不再复用旧 Set）
- 测试：vitest **680** 例（渲染器测试迁移到流式布局+钉住语义，新增 soak 不变量测试 360 行）、cargo test **155** 例全绿、tsc 0 诊断
- e2e：**22** 例——选区用例改钉住语义（真实浏览器拖选+滚轮+断言选区存活与行号），issue #16 用例适配流式布局，顺带修正 issue #16 改版遗留的过时断言与测试边界容差

# HyperCom v0.6.5

## 新特性
- 内存预算改版（issue #16 改版）：去除 `memoryLimitMb`/`memoryPerPortBudgetMb` 双内存预算，改为单一 `maxDisplayLines` 最大显示行数（默认 100000，clamp [1000,1000000]）；终端缓冲超限**逐行覆盖最旧**（滚动窗口）；升级自动剥离旧配置项（`strip_legacy_memory_budget_keys`）；删除「因内存限制清屏」toast 与软兜底机制；状态栏内存显示改「JS堆 + 进程 RSS」
- 行级触发器引擎（P1-1）：`useSerialReceive` 接入 RxPipeline `onLineAssembled` 钩子，条件触发评估粒度从批量降到行级
- ReDoS 防护：triggerEngine / highlightEngine 正则匹配前 5000 字符截断
- protocolParser（P1-3）：无完整 header 时保留尾部字节不冲 buffer；rxAssembler（P2-4）：强制发射后紧跟分隔符不产幻影空行
- terminalSearch 从 MainDisplay/ 迁移到 utils/（引用同步），ConfigModal 回滚保留新分组/元数据

## 其他
- 统一换行符策略为强制 CRLF（eol=crlf + 自引用豁免）
- 测试：vitest **673** 例（逐行覆盖语义 + maxDisplayLines 派生重写）、cargo test **155** 例全绿、tsc 0 诊断
- e2e：大 trim 锚点测试改为「小 maxDisplayLines 下逐行覆盖视口稳定 + DOM 有界」（原场景在逐行覆盖下不存在）

# HyperCom v0.6.4

## Bugfix
- 修复「满内存后清半屏逻辑实际未生效」（issue #16）：容量（行数）溢出现在 **half-trim 一次性裁掉最旧一半**再落新行（恢复 issue #6-2「超预算一次性裁到 50%」语义）——修复前满容后逐行覆盖最旧行（firstSeq 每 append 只前进 1），「清半屏」永不生效，用户只看到「最早的消息一直在被顶掉」而 toast 却在报「已清除最早一半」。字节预算 drain（大行场景 avg >2KB/行先于行容量触发）保留。toast 语义修正：`appendLines` 返回值区分 `trimmed` / `memoryTrimmed`，「因内存限制清屏」通知只对真实清半屏事件（容量 half-trim 或字节 drain）弹出。软兜底候选闸改行数闸（`count > maxLines/2`，任何行大小可达）——修复前字节闸对典型小行永不触发，应用级 `memoryLimitMb` 层形同虚设
- 内存预算改版（issue #16 改版）：去除 `memoryLimitMb`/`memoryPerPortBudgetMb` 双内存预算，改为单一 `maxDisplayLines` 最大显示行数（默认 100000，clamp [1000,1000000]）；终端缓冲超限**逐行覆盖最旧**（滚动窗口）；升级自动剥离旧配置项（`strip_legacy_memory_budget_keys`）；删除「因内存限制清屏」toast 与软兜底机制；状态栏内存显示改「JS堆 + 进程 RSS」

## 性能

- TTY 模式交互卡顿修复（探查报告定位的三根因，P0/P1 四项）：
  - `get_system_status` / `list_available_ports` 改 async + `spawn_blocking`——消除每 5s/3s 全系统进程表刷新与串口枚举对事件循环主线程的周期阻塞（根因 #1）
  - TTY TX 逐键 invoke 改 ~10ms 合批（首字节启动定时器，64KB 上限，字节顺序严格保持，detach 收尾 flush / 断线丢弃缓冲）
  - 流量统计降频：新增 `trafficStats` 1s 聚合器，RX/TX 三写点共用——消除每事件 Zustand 更新与 StatusBar 重渲染（根因 #3）
  - `write_all_with_deadline` 新增耗时打点（单次 >100ms / 整批 >500ms `log::warn!`）
- 操作面板/参数区/发送区选择器拆为原语选择器：3s 端口轮询与状态更新不再无条件重渲染（`ports.find(...)` / 整包 config 新引用替换）

## Bugfix
- 修复分屏嵌套渲染崩溃（issue #15）：`TerminalRenderer.detach` 清空 active/pool/锚点状态（跨 Pane 位移时旧 active 不再参与新容器 render 排序）；排序循环 insertBefore 加归属校验，脱链时降级 appendChild（崩溃变视觉降级）；TerminalView 双阶段 attach 消除竞态窗口
- 修复输出区 trim 抖动（issue #10 残余）：大 drain（≥2500 行）非 follow 时按上一帧视口顶部 seq 恢复阅读位置、follow 同帧钉底——消除字节预算裁半导致的视口暴跌+逐帧回填；字节预算 drain 限幅（append 50000 行/批，50% 滞回渐进到达，硬上限语义不变）；软兜底回升闸（以裁后堆占用为基线，堆未回升不重复裁，消灭 10s 冷却周期抖动）
- 异步时序与竞态修复：重连循环每轮退避前检查 `userClosingPortIds`（用户主动关闭后不再悄悄重开）；`runAutoCheck` in-flight 锁（改通道首检与 6h 周期并发不再双弹窗/双记账）；`usePopoutBridge` fire-and-forget emit 补 `.catch`；TerminalPopout 快照「历史 + 现有行」合并不丢新行；openPort/closePort per-port in-flight 守卫；ThemeProvider 背景图 effect 拆分（opacity/blur 只改 CSS 变量不再反复读盘）；触发 respond 失败补 debug 日志

## 其他
- 死代码与重复实现清理：删除零消费的 `activeHighlightSetId`/`activeProtocolTemplateId` 及 setter、`resetAndReload`、`logService.setLogDirectory`（后端命令保留）、`setupPromiseRef`、`hasViewportManager`、i18n 12 个零引用 key；`clampNumber` 5 份页内拷贝 → `utils/clampNumber.ts` 单一实现；`performance.memory` 两份读取 → `utils/jsHeap.ts`；`usePanelCyclicSend` 死参数 onProgress 删除
- 文档重构：`plans/` 更名 `docs/`，架构文档按功能模块重排（串口管理/终端显示/数据收发/TTY/日志/配置/工作区/自动更新/发版/错误处理，见 `docs/architecture/README.md` 索引）；删除废弃的 code-signing / hardware-matrix / test-checklist；新增 `docs/userwiki/`（面向普通用户，暂空）
- 测试：vitest **689** 例（新增 TTY 合批 4 / trafficStats 聚合 6 / 大 drain 锚点 2 / detach 重 attach / 回升闸 / 并发锁等）、playwright **21** 例（嵌套分屏位移无 console error、40MB 高频 RX 字节 drain 视口位移 <50 行）、cargo test 157 例全绿、tsc 0 诊断

# HyperCom v0.6.3

## 新特性
- 发送后保留输入框内容（issue #13）：新增 `clearSendInputAfterSend` 设置（默认关闭 = 保留），发送区 options 行可勾选清空行为，便于重复发送/连续调试

## Bugfix
- 修复缓冲 head trim 后 DOM 行泄漏导致的高频输出抖动（issue #10）：行头裁剪前进 `firstSeq` 后，active 行 `visIdx` 字段停留在旧窗口值，stale 检查按字段判定永不回收 → DOM 行数无限增长（实测 6669 vs 正常 27）→ 每帧 O(n) 渲染 → 帧率暴跌。修复：stale 判定改用**实时列表位置** `seqToVisIdx`（identity O(1)、过滤模式二分），越界即回收，DOM 恒 ≤ 窗口+overscan
- 关闭标签页不再关闭串口（issue #11）：关标签只清前端管线（`disconnect` + `detach`），端口/日志保持连接；重开标签页从零开始新一轮输出，后端 RX 日志独立落盘不受影响
- 修复拖选滚动黑块（issue #12）：拖选冻结期间允许物化**新**行（新行不在活选区 Range 内安全），仅冻结已有行保护选区锚点
- 终端内存裁剪机制重构（issue #14）：`lineBytes` 改 V8 真实占用估算（对象头 + Uint8Array 包装 + parsedFields），byte-budget trim 真实生效；恢复方案B重构时丢失的应用级软兜底（`performance.memory` JS 堆超预算时对候选端口裁半）；渲染器统一实时 `seqToVisIdx` 定位，消除 trim 后乱序/堆叠隐患；恢复前序提交误删的 5 个 i18n key

## 其他
- 测试：vitest 652 → **669** 例（37 文件，新增 trim 风暴回归：head 大前移 + 向上滚动断言 translateY 唯一 + DOM order == seq 升序、trim 期 DOM ≤ 窗口+overscan + scrollTop 单调、关标签 keep 连接 + 重开从零、拖选滚动视口行有内容等）、cargo test 157 例全绿、tsc 0 诊断
- 修复集中在渲染引擎（方案B 几何不变式保持：固定行高、零测量）与管线生命周期，未触碰引擎核心

# HyperCom v0.6.2

## Bugfix
- 修复 0.6.1 超宽行横向滚动失效（issue #15）：行内容 span 是 `.terminal-line`（flex）的 flex item，其内联 `overflow:hidden`（垂直裁剪内嵌 \n 的第二视觉行）触发 flexbox §4.5「overflow ≠ visible 时自动最小尺寸（min-width:auto）归零」——默认 `flex-shrink:1` 会把 span 压到行宽，超宽内容在 span 内部被裁掉、溢出到不了 `.terminal-view`，横向滚动条不出现、shift+滚轮无物可滚。修复：`.terminal-content` 加 `flex: none`（0 0 auto）把 span 钉在内容实际宽度（max-content），超宽部分以盒子溢出形式传播到 `.terminal-view { overflow-x: auto }`；垂直方向仍由内联 `max-height + overflow:hidden` 裁剪，固定行高格子不变

## 其他
- 测试：vitest 652 → **656** 例（37 文件，新增「flex 不收缩契约」「`.terminal-line` overflow visible 传播链」与超宽行结构测试 4 例）、cargo test 157 例全绿、tsc 0 诊断
- 修复仅一行 CSS（`.terminal-content` 加 `flex: none`），渲染引擎几何不变式（固定行高、零测量）不变，未触碰引擎核心

# HyperCom v0.6.1

## 新特性
- 超宽行改为横向滚动查看（不再自动换行）：单行内容完整保留，横滚动条仅在存在超宽行时出现；整行文本的选择 / 复制 / 搜索不受影响
- 打开（连接）串口成功后自动打开并激活该端口的标签页：已有标签页则仅激活、不重复创建；关闭串口不再影响标签页（历史数据保留，可手动关闭或重连）

## Bugfix
- 修复超宽行文本重叠（issue #9）：v0.6.0 方案B 引擎按固定行高定位（`translateY(visIdx × rowHeight)`、零 DOM 测量），而 `.terminal-content` 的 CSS 换行（`white-space: pre-wrap` + `word-break: break-all`）会让超宽行在固定行盒之外画出第二视觉行，叠在下一行文本上。修复：终端内容禁止自动换行（`white-space: pre`，数据原样保留），`.terminal-view` 改 `overflow-x: auto`——行与行之间任何情况下不再重叠

## 其他
- 测试：vitest 648 → **652** 例（37 文件，新增「连接成功自动打开/激活标签页」「已有标签页仅激活」「多 Pane 落点」「关闭串口保留标签页」4 例）、cargo test 157 例全绿、tsc 0 错误
- 渲染引擎几何不变式（固定行高、零测量）未改动——修复全部落在 CSS 层 + 行内容裁剪，未触碰引擎核心

# HyperCom v0.6.0

## 新特性
- 自动更新（issue #12）：正式版 / preview 双通道自动检查与安装（7 天周期、手动检查、弹窗三动作），preview 用户在新稳定版发布后自动晋升
- 自定义背景图 · 全应用毛玻璃（issue #13）：可选背景图片，不透明度 / 模糊度可调，各面板表面半透明化
- 日志设置新增「每次打开串口时新建日志文件」：开启后每次连接写入独立文件（同名自动追加 -1、-2 后缀），不再续写

## Bugfix
- 修复日志按大小分片后反复触发分片的死循环：分片续片始终创建新文件，不再复用旧文件名

## 其他
- macOS 暂不支持自动更新（未签名 / 公证），请手动安装
- 测试：vitest 644 例（35 文件）、cargo test 157 例全绿

# HyperCom v0.6.0-preview.2

0.6.0 核心的第二个 **preview**（首个 `preview.1` 因 Windows MSI/WiX 只接受数字版本、`0.6.0-preview.1` 打包直接报错而作废重建；自本版起 preview 流 Windows 只发布 NSIS 安装包，stable 流保持 MSI+NSIS）。prerelease——不进入「最新正式版」解析，stable 通道用户不受影响；preview 通道用户可经自动更新或手动安装获取。汇聚自 v0.5.2 以来 main 上的新功能：**自动更新（issue #12）** 与 **自定义背景图 · 全应用毛玻璃（issue #13）**。

## 新功能

**自动更新（issue #12）**：

- **通道运行时用户选择**：通用设置「自动更新」三态——不检查 / 定期检查到正式版（默认）/ 定期检查到 preview；7 天周期（首启立即、上次成功检查后满 7 天、snooze 暂停、会话内 6h 重评估覆盖常驻挂机），记账存 localStorage
- **发现更新 → 弹窗三动作**：立即更新（下载进度条 → 安装 → 重启）/ 7 天后提醒 / 永不提醒（同步设置项）；About 手动检查可选正式版 / preview
- **preview 通道语义 = max(preview, stable)**：本版 tag 为 `v0.6.0-preview.2`（唯一 tag），0.6.0 stable 落地后 preview 用户自动晋升；stable 通道永不泄漏 preview
- **发版 CI 三重护栏**：tsc + vitest + cargo test 质量门、RELEASE_NOTES 章节↔版本校验、verify-release 对 latest.json 四平台键完整性门禁
- **macOS 暂不支持自动更新**（未签名/公证，macOS 用户手动安装即可）

**自定义背景图（issue #13）**：

- 「设置 → 显示与交互」新增「背景图」区段：启用勾选 → 浏览选择图片（原生对话框，png/jpg/jpeg/bmp/webp/gif）→ 不透明度 0–100% → 模糊度 0–64px
- 路径存 config.json，经后端 `read_image_data_url` 读为 base64 data URL（20MB 上限 + 扩展名白名单 + 静默降级），dev/prod 一致、不依赖 asset protocol（issue #3-5 旧实现曾因硬化 webview 载不动裸路径而删除，本次以 data URL 形态回归）
- **全应用毛玻璃**：启用后所有 `--bg-*` 表面 token 换半透明 rgba（亮/暗主题两套 alpha，终端区最深 0.72、浮层 0.90 保可读），背景图垫全窗口底层（`z-index:-1`）；TTY xterm 背景实时重绘

## 其他

- 测试：vitest **600** 例 / 31 文件、cargo test **145** 例全绿；tsc + cargo check 0 错误
- 文档：AGENTS.md / README / RELEASE_NOTES / 子目录 AGENTS.md 已同步至 issue #13
- 已知边界：弹出窗（独立 webview）不共享背景层；macOS 自动更新需手动安装

# HyperCom v0.5.4

0.5.3 之后的新功能：**自定义背景图**（issue #13）——可选背景图片 + 不透明度/模糊度调节，启用后**全应用毛玻璃**。

## 新功能

**自定义背景图（issue #13）**：

- **设置入口**：「设置 → 显示与交互」新增「背景图」区段——启用勾选、只读路径 + 浏览按钮（原生对话框，png/jpg/jpeg/bmp/webp/gif 过滤器）、不透明度 0–100%、模糊度 0–64px；四项配置存 config.json
- **全应用毛玻璃**：启用后所有 `--bg-*` 表面 token 换半透明 rgba（亮/暗主题各一套 alpha，终端区最深 0.72、浮层 0.90 保可读），背景图垫全窗口底层（`.app-background` fixed + `z-index:-1`）；TTY xterm 背景实时重绘（创建时快照，切换时按 config 活更新）
- **图片加载**：路径经后端 `read_image_data_url` 读为 base64 data URL（20MB 上限 + 扩展名白名单 + 静默降级），dev/prod 一致，不依赖 asset protocol（历史：issue #3-5 曾因硬化 webview 载不动裸路径而删除过背景图功能，本次以 data URL 形态回归）

## 其他

- 测试扩充：vitest 589 → **600**（31 文件），cargo test 134 → **145**（`image_mime_from_ext` 映射 + `read_image_data_url` data URL 往返等 7 例）
- 文档：README 功能列表与测试计数、根 AGENTS.md（overview 条目 / WHERE TO LOOK / 命令表 / i18n 计数 / 死字段说明）、commands/ConfigModal/MainDisplay 子目录 AGENTS.md、THIRD_PARTY_LICENSES 补充 base64

# HyperCom v0.5.3

0.5.2 之后的新功能：**自动更新**（issue #12）——通道（正式版/preview）运行时用户选择、7 天周期检查、更新弹窗三动作决策流、About 手动检查；同步配套 preview 双 release 流。

## 新功能

**自动更新（issue #12）** — 完整自动更新链路：

- **通道用户可选的运行时设置**：通用设置新增「自动更新」三态——不自动检查 / 定期检查到正式版（默认）/ 定期检查到 preview 版；**所有周期统一 7 天**（启动时评估：首启立即、上次成功检查后满 7 天、忽略 snooze 期），记账存 localStorage 随安装持久
- **发现更新 → 弹窗三动作**：通道徽标 + 新版本 + 发布日期 + 更新日志（changelog）；**立即更新**（下载进度条 → 安装 → 重启）、**7 天后提醒**（写 snooze）、**不更新（永不提醒）**（同步设置项为「不自动检查」，可在设置重新开启）
- **About 手动检查**：可选「检查正式版更新」或「检查 preview 更新」，不受「不自动检查」限制；无更新/失败有明确 toast
- **通道隔离**：正式版用户永远只看正式版（GitHub `releases/latest` 语义天然排除 prerelease）；preview 用户自动跟进最新 preview（经 GitHub API 解析最新 `vX.Y.Z-preview.N` tag，每版唯一 tag），对应正式版发布后自动晋升
- **双层门控**：debug 构建不检查（后端返回"无更新" + 前端短路），仅 release 安装包生效；检查失败静默降级（诊断日志记录），手动检查失败才提示
- **preview 发版流**：新 `.github/workflows/publish-preview.yml`——tag `v0.x.y-preview.N`（唯一 tag + prerelease 标记）触发独立构建，stable 流已排除 preview tag 防重复

## 其他

- 测试扩充：vitest 567 → **589**（30 文件，updateService/channel 22），cargo test 128 → **134**（`find_latest_preview_tag` 5 + update_check_mode clamp 1），E2E 14 → **16**（更新弹窗冒烟 + 永不提醒同步断言）
- 文档：`docs/architecture/update.md` 方案、`docs/architecture/release.md` preview 发版流程、各 AGENTS.md 同步

# HyperCom v0.5.2

0.5.0 发布后的四项修复：循环发送每端口独立引擎（多串口并行压测）、串口热插拔状态卡死、多串口压测日志"半页刷屏"、日志空行落盘。

## 修复

**循环发送每端口独立引擎（issue #12）** — 循环发送不再随窗口聚焦/标签切换漂移：在哪个端口启动就一直发给该端口，切换聚焦不影响已运行的循环，切回后按钮变回「停止」可手动停；**多端口可并行**循环（给多个串口同时灌数据压测）；目标端口断开时自动跳过等待重连；窗口被遮挡恢复后立即补发到期命令（WebView2 隐藏窗口节流不再拖死循环）。弹窗文本模式循环同步增强

**串口热插拔状态卡死（issue #12）** — 拔出/重插串口后侧边栏状态报错且「刷新按钮治不了、只能重启」的根因修复：`error` 状态在端口重新枚举时自动重置为 disconnected（刷新可修复）；已消失的 `connected` 端口不再被无限期保留成幽灵（3 次轮询≈9s 宽限）；后端打开端口时交叉核对系统枚举，设备已拔出则回收幽灵句柄——重插后可直接打开，不再 "already open"

**多串口压测日志「半页刷屏」（issue #12）** — 应用内存超预算后每个数据批都把缓冲裁掉一半（日志只加载半页就被前半页顶掉）。软兜底裁剪改为：只裁剪自身缓冲已相当可观的端口 + 每端口 10s 冷却；真正的硬约束（字节/行数上限）保持立即生效

**日志空行不落盘（issue #12）** — 连续换行/行首行尾分隔符产生的空日志行不再写入日志文件（空数据直接跳过、解码为空跳过）；连接后无任何数据的 0 字节日志文件在关闭时自动删除

## 其他

- 测试扩充：vitest 564 → **567**（28 文件），cargo test 128/128

# HyperCom v0.5.1

0.5.0 发布后的反馈修复：GIT:BASH 模拟终端（TTY 模式验证工具）下快捷发送命令会**多执行一行空命令**。

## 修复

**GIT:BASH 快捷发送多执行一行空命令（根因修复）** — 快捷发送按命令集行结束符发送（默认 `\r\n`），而 pty 行规程（ICRNL）会把 `\r` 转成 `\n`——`\r\n` 变成两个换行，bash 执行完命令后还多收到一个空行回车。修复：TTY 写 pty 时做**回车归一**（`SerialManager::send_data` GIT: 分支），`\r\n` 统一为单个 `\r`（真实终端 Enter），`\r`/`\n`/`None` 原样保留；覆盖快捷发送条 / 命令面板 / 循环发送 / 触发自动回复 / 弹出窗全部 TX 路径

## 其他

- 测试扩充：cargo test 121 → **123**（`normalize_tty_line_ending` 映射 + 归一后实际写入字节）

# HyperCom v0.5.0

本次更新实现 issue #11 **TTY 终端模式**：端口可切换为 xterm.js 完整交互终端（真实 ANSI/VT100、光标、备用屏幕 vim/top、尺寸协商、无本地回显由对端 echo），并完成持久化、会话保留与健壮性打磨。

## 新功能

**TTY 终端模式（issue #11）** — 每端口可在 TRX（既有行级终端）与 TTY（xterm.js 完整终端模拟）间切换（`OperationPanel → 参数` 分段控件，模式经 `port_meta` 持久化、重启恢复）：ANSI/VT100 全语义（颜色/加粗/光标寻址/滚动区/备用屏幕）、全屏应用（vim/top/htop）、readline 行编辑与粘贴、尺寸协商（对端 `\x1b[18t` 查询由 xterm 经 onData 自动回）；TX **无本地回显**（命令由对端 shell echo），快捷发送/命令面板在 TTY 下复用（跳过 TX 回显行）；`useSerialReceive` 对 TTY 端口字节直喂 `ttyService`（跳过触发引擎/协议解析/行组装）

**会话跨标签保留（issue #11）** — TTY 标签在 Pane 内**常驻挂载**，非活动标签隐藏（display:none），切换标签不丢终端缓冲与滚动位置；恢复可见自动重排尺寸（vim/top 按真实尺寸重绘）。仅模式切换 / 关闭标签 / 跨 Pane 拖拽销毁实例

**模拟终端（调试专用，issue #11）** — 侧边栏工具栏新增「模拟终端」按钮：后端以 portable-pty（Windows = ConPTY）spawn 本地 git bash 作为 GIT:BASH 虚拟串口，无硬件即可验证 TTY 交互（vim/top/readline/尺寸协商/DSR 应答）；双层门控（前端 `import.meta.env.DEV` + 后端 release 命令拒绝），仅 `npm run tauri dev` 可用

**字体/字号活更新（issue #11）** — TTY 终端字体、字号经 `term.options` 实时应用，不重建 Terminal、不丢缓冲；Ctrl+滚轮缩放（8–48px，与 TRX 终端一致）

## 修复

- **TTY 模式持久化断路** — Rust `PortMetaEntry` 缺失 `mode` 字段，serde 静默丢弃 → 重启后 TTY 端口回退 TRX；补字段 + 校验钳制 + 往返测试
- **字体变更清空终端缓冲** — TtyView 挂载 effect 依赖含字体配置，改动即重建 xterm 丢会话；改 `term.options` 活更新
- **禁用模拟终端阻塞 UI** — `disable_gitbash_sim` 同步 join 读线程改 async + `spawn_blocking`（与 `close_serial_port` 对齐防「断开卡死」）
- **断线解码器残留 / resize 取整 / 死字段清理** — 断线重建流式解码器（防多字节字符跨连接污染）；pty 尺寸先取整再校验（0/负数拒绝）；移除 `lastTs` 未用字段；`detach` 保留最近尺寸（重开不再回退 80×24）

## 其他

- 新增 i18n 双语 key：`params.mode.*`（3）、`tty.*`（2）、`sidebar.toolbar.{enable,disable}GitBashSim`（2）
- 测试扩充：vitest 530 → **557**（28 文件），cargo test 112 → **121**

# HyperCom v0.4.3

本次更新集中解决 GitHub issue #7 列出的 10 个 UI 缺陷/体验问题：通知中心信息增强、快捷发送面板按钮样式与状态灯、自定义右键菜单，以及若干文案与布局修正。

## 改进

**通知中心增强（issue #7-1）** — 来自串口的消息（条件触发告警、意外断线、发送目标端口关闭、自动重连失败）现在在通知中心中携带**来源串口号**（chip 高亮），且每条通知附带**时间戳**（HH:MM:SS），多端口场景一眼可辨消息来源与发生时刻

**快捷发送面板按钮样式（issue #7-2）** — 操作面板快捷发送条的「打开命令面板」按钮从带状态的图标按钮改为**明显的按压按钮样式**：accent 填充 + 文字标签（`命令面板`），高度与两行命令药丸对齐，一眼即知可点击

**快捷发送独立面板（issue #7-4 / #7-5）** — 目标串口下拉不再显示无意义的 `· REAL/VIRTUAL` 类型后缀；底栏「发送到」提示灯改为**跟随串口真实状态**：未连接灰色、已连接绿色呼吸（订阅全局 `serial:status` 事件，打开面板时经 `port-statuses:sync` 一次性对表，已连接状态下打开也立即准确）

**自定义右键菜单（issue #7-10）** — 应用内输入框/文本域/可编辑区域的右键菜单由 webview 原生菜单改为**应用自定义菜单**（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选），样式跟随主题与语言；主窗与弹出窗（快捷发送等独立窗口）均已接入；其余区域继续屏蔽原生菜单

## 修复

- **发送提示前缀默认留空（issue #7-3）** — 终端输出已有 TX/RX 方向标识，发送提示前缀（`sendPrefix`）默认值改为空（功能保留，可在「显示」设置页配置）
- **发送区控件位置（issue #7-6）** — 命令集选择 / 循环开关 / 编辑按钮紧跟「发送命令」标题文字之后，不再被推挤到行尾
- **设置界面移除「串口参数预设」（issue #7-7）** — 该管理功能在操作面板（参数区）已有完整实现，设置界面不再重复展示
- **文案精简（issue #7-8）** — 「一键打开全部 / 一键关闭全部 / 一键连接整组 / 一键断开整组 / 一键清空」去掉「一键」描述，直接描述操作
- **分组整组执行外部工具改并行（issue #7-9）** — 组内多个已配置端口的工具**同时启动**（此前 100ms 节流串行，多端口组要等前一个跑完）

## 其他

- 新增 i18n 双语 key：`contextMenu.*`（6 个文本编辑动作）、`quickSend.openPanelShort`
- 测试扩充：vitest 527 → **530**（27 文件，useToastStore portId/createdAt），e2e 冒烟 10 → **14**

# HyperCom v0.4.2

本次更新修复 issue #6 的遗留根因问题——**TX 后长时间收不到设备响应**：读写句柄拆分（RX 不再被 TX 阻塞饿死）、摘除无界 `flush()`、前端隐藏窗口排空兜底。

## 修复

**TX 后长时间收不到响应（issue #6-10，根因修复）**

此前发送数据与接收读取共用同一把串口锁，而 Windows 上发送路径的 `flush()`（`FlushFileBuffers`）**没有超时**、受流控约束——对端设备忙 / CTS 拉低 / XOFF 时无限期阻塞。阻塞期间锁被发送独占，接收线程读不到早已到达系统缓冲区的设备响应，表现为「TX 后等很久响应才冒出来」。

本次修复分三层：

- **读写句柄拆分** — 打开串口后经 `try_clone()`（Windows 上为 `DuplicateHandle`）复制出第二个句柄：接收线程独占读句柄、发送路径独占写句柄。发送再阻塞也影响不到接收读取——响应一到就被读走、显示
- **摘除无界 `flush()` + 写入总期限** — 发送路径不再调用 `flush()`（等物理发完对调试工具几乎无收益，却是唯一无界阻塞点）；写入改为带**总期限**（2 秒）的循环，超时即报错而非无限等待；同时发送不再持有全局串口锁——端口列表轮询、其它端口命令不被慢发送拖死
- **前端隐藏窗口排空兜底** — 窗口最小化/隐藏时浏览器会停摆 `requestAnimationFrame`，接收管线改以 `setTimeout` 兜底排空，队列设上限（默认 1 万行）丢弃最旧数据，防止隐藏期间无界积压

## 其他

- 测试扩充：vitest 519 → **527**（27 文件），cargo test 106 → **112**，e2e 冒烟 8 → **10**

# HyperCom v0.4.1

本次更新集中解决 GitHub issue #6 列出的 9 个问题：发送卡顿/白屏根因异步化、终端与 RX 管线双层内存预算、rawData 内存瘦身、进程级内存显示，以及多项体验改进。

## 新功能

**内存预算双配置（issue #6-2）** — 设置新增「每端口内存预算」（默认 200MB 硬约束），并赋予「内存总预算」应用级软兜底语义（默认 2048MB，含 webview）；终端缓冲按字节记账，超限一次性裁剪到 50% 并弹出提示（每端口 10 秒节流）

**rawData 内存瘦身（issue #6-2）** — 终端行原始字节由 `number[]` 改为 `Uint8Array`，内存占用约 8 倍削减，编码切换重解码不再产生临时拷贝

**RX 写量限制（issue #6-2）** — 每端口每帧最多写入 2000 行、超出自动顺延下一帧，同步排空同样受限——高频接收不再拖垮主线程（与 TX 卡顿同源修复）

**端口排序一次性 + 右键分组（issue #6-4 / #6-5）** — 「按端口号排序」改一次性动作：一键按 COM1<COM2<COM12 自然序重排（含组内顺序），排完仍可拖拽/分组；串口右键菜单新增移入分组/新建分组并移入/移出分组

**文本模式新按钮（issue #6-3）** — 独立发送面板文本模式新增「执行当前行并移至下一行」，逐行核对命令无需手动点选下一行

## 修复

**发送卡顿 / 白屏根因（issue #6-1）** — `send_serial_data` 由同步命令改为异步 + `spawn_blocking`：原来每次发送都在事件循环主线程做串口写入与日志落盘，造成无条件卡顿，高频收发时还触发 tao 警告与白屏

**状态栏内存显示（issue #6-6）** — 内存采样改为应用进程树级（本进程 + 含 WebView2/Chromium 的后代进程 RSS 之和），能真实反映软件自身占用

**设置弹窗框选误关（issue #6-8）** — 框选文字时鼠标松手在弹窗外不再误关设置弹窗

## 改进

**通知中心面板加大（issue #6-7）** — 通知面板 320→360px 宽、340→400px 高，长告警文案与多条通知更易阅读

**快捷发送条两行显示（issue #6-9）** — pill 改两行布局：名称（含 HEX 徽标）在上、内容在下，窄窗口不再截断

## 其他

- 新增 i18n 双语 key：串口右键分组三项、`quickSend.runCurrentLineAdvance`、`toast.memoryTrim`
- 测试扩充：vitest 506 → **519**（27 文件），cargo test 103 → **106**，e2e 冒烟 6 → **8**

# HyperCom v0.4.0

本次更新集中解决 GitHub issue #5 列出的 10 个问题：发送区大改版、条件触发通知中心、配置持久化审计修复、滚动锁定重构，以及多项缺陷修复。

## 新功能

**命令发送区大改版（issue #5-4）**
- 快捷发送按钮同时显示命令**名称与内容**，不再只显示其一
- 快捷发送按钮数量**随窗口宽度动态调整**，不再写死为固定条数（`quickSendInlineCount` 仅保留 0=隐藏内联条的语义）
- 快捷发送条**首个按钮常驻**：独立图标 + 独立样式的「打开独立发送面板」按钮，一键唤起独立发送窗口
- 独立快捷发送面板重构为**双模式**：
  - **命令列表模式**：每行命令后新增「修改」按钮，可在面板内直接改名称、行尾与内容，无需跳转设置界面；点击命令行即发送
  - **文本模式**：大发送区任意输入多行文本，每行视为一条独立命令；提供「执行当前行 / 顺序完整执行 / 从当前位置执行 / 完整循环执行」四种执行方式（支持发送间隔与轮次间间隔）
- 两种模式均可设置**目标串口**（不再只能跟随活动标签）、行尾、STR/HEX
- **尝试向已关闭的串口发送命令时弹出警告**（循环发送/触发自动回复等静默路径不弹，避免刷屏）

**VSCode 式通知中心（issue #5-3）**
- 状态栏新增通知铃铛：**持久驻留**、溢出收纳、**一键清空**、单击即关
- 条件触发告警不再只显示通用文案——现在弹出**规则动作内容**，且不再 4 秒消失，会一直驻留在通知中心直到手动清除
- 触发规则**自动持久化**：新增/修改规则立即（防抖）存入 config.json，关闭再打开设置界面不再丢失

## 修复

**滚动锁定跟随重构（issue #5-1）**
- 彻底移除跟随路径上的 `scrollToIndex`（其重试循环是日志中 `Failed to scroll to index xxx after 10 attempts` 的来源），改为纯 `scrollTop` 实测钉底 + 双 rAF 校正，高频输出不再卡顿/上漂
- 跟随判定逻辑（`isAtBottom`/`computePinTarget`/`becameLocked`/`shouldFollow`）抽为纯函数并补齐单测

**配置持久化审计（issue #5-2）**
- 修复根因：设置弹窗「保存」按钮全量保存**陈旧的内存快照**，覆盖掉刚存入 config.json 的命令规则/高亮/协议模板/触发规则/外部工具——现在保存前会用实时规则库合并
- 删除全部规则后重开弹窗不再「复活」已删条目
- 修复「诊断日志」开关线格式不匹配（`diagnosticLogEnabled` ↔ `diagLogEnabled`），开关此前实际不生效

**保存的日志文本（issue #5-9）**
- 修复日志中「一轮输出的首个字符独占一行」：Rust 侧新增字节级行聚合器（与终端 RX 管线同语义），跨事件响应在日志中合并为完整行；关闭/静默时冲刷尾部

**状态栏内存占用（issue #5-5）**
- 此前显示的是**进程自身**驻留内存（几乎不变）；改为**系统整体已用内存**，数值随系统负载真实变化

**行尾选择提示不跟随（issue #5-6）**
- 根因：JSX 属性字符串转义陷阱导致运行时行尾值变成 6 字符、与领域值（4 字符）不匹配——已改用表达式字面量并抽出共享常量 + 回归测试（同时修复了发送时行尾字节丢失的隐患）

**操作面板目标 COM 切换（issue #5-8）**
- 点击输出区（含空白处）现在也会把操作面板目标切换到该分栏当前显示的标签，不再只在点击标签页时切换

## 改进

**串口分组整组执行外部工具（issue #5-7）**
- 分组右键菜单新增「整组执行外部工具」：仅运行已正确配置的串口；存在未配置串口时弹窗提示，可一键去配置或仅运行已配置

**日志保存子目录（issue #5-10）**
- 设置新增「日志子目录」选项：**按日期分文件夹（默认）/ 按串口号分文件夹 / 不区分**

## 其他

- 通知中心、触发规则、分组工具等新增 i18n 双语文案（zh-CN / en-US 完全对称，共 508×2）
- 测试大幅扩充：vitest 415 → **506**（27 文件），cargo test 48 → **103**，e2e 冒烟 6/6

## 下载安装包

- **Windows**：`hypercom_0.4.0_x64-setup.exe`（推荐，NSIS 安装包，支持中英文）或 `hypercom_0.4.0_x64_en-US.msi`
- **macOS (Apple Silicon)**：`hypercom_0.4.0_aarch64.dmg`
- **macOS (Intel)**：`hypercom_0.4.0_x64.dmg`
- **Linux**：`hypercom_0.4.0_amd64.deb` / `hypercom-0.4.0-1.x86_64.rpm` / `hypercom_0.4.0_amd64.AppImage`

> macOS 版本暂未做代码签名与公证，首次打开可能被 Gatekeeper 拦截，请在「系统设置 → 隐私与安全性」中允许运行。

## 自动更新

v0.3.x 及更早版本用户将在应用内收到更新提示，更新弹窗会显示上述更新说明。

# HyperCom v0.6.3+ 前端整理（2026-08-26，无版本号变更）

## 重构与清理
- 死代码删除：`useRuleStore.activeHighlightSetId`/`activeProtocolTemplateId` 及 setter（全仓零生产消费）、`useConfigPersistence.resetAndReload`（零消费）、`logService.setLogDirectory`（零消费，后端命令保留）、`useSerialReceive.setupPromiseRef`（死 ref）、`hasViewportManager` 导出、i18n 12 个零引用 key（550 键/侧）
- 重复实现合并：`clampNumber` 5 份页内拷贝 → `utils/clampNumber.ts`；`performance.memory` 读取两份 → `utils/jsHeap.ts`；`usePanelCyclicSend.onProgress` 死参数回调删除
- 文档对齐：AGENTS.md / hooks / ConfigModal / MainDisplay 计数断言全部修正（15 hooks / 11 域文件 / 16 CSS / 9 pages / 550 i18n 键），移除 MainDisplay 文档中已删的 TerminalRow.tsx 幽灵条目与 react-virtual 描述；ISSUES_ANALYSIS.md / TTY_PERF_INVESTIGATION.md 标注结论过时

## Bugfix（异步时序）
- 重连循环不再无视用户关闭意图：每轮退避前检查 `userClosingPortIds`，用户主动关闭后循环立即中止（此前会在下一次重试时悄悄重开；不能看 port.status——后端先发 disconnected 再发 reconnect_hint，attempt=0 时 store 已是 disconnected，会误杀循环）
- `runAutoCheck` 加模块级 in-flight 锁：改通道保存触发首检与 6h 周期重评估并发时不再双弹窗/双记账
- `usePopoutBridge` 全部 fire-and-forget emit 补 `.catch`：弹窗 webview 销毁时不再产生 unhandled rejection
- `TerminalPopout` 快照 replaceAll 竞态修复：快照到达时若本窗缓冲已有实时行，改为「快照历史 + 现有行」合并，不丢新行
- `rxPipeline.feedBytes` 保持原样：对已 release 的 manager 喂数据是静默 no-op（有界），不加 tab 门控（弹出窗 store 无 tabs，门控会丢光弹窗实时流）
- `openPort`/`closePort` 加 per-port in-flight 守卫：同一事件循环内连点不再并发打开同一串口句柄
- ThemeProvider 背景图 effect 拆分：opacity/blur 变化只改 CSS 变量，不再反复读盘（20MB 上限 IO）
- 触发引擎 respond 失败补 debug 日志（此前完全静默）

## 性能
- OperationPanel / ParamsSection / SendSection 的 `ports.find(...)` / 整包 `config` 新引用选择器拆为原语选择器：3s 端口轮询与状态更新不再无条件重渲染操作面板与参数区

## 验证
- tsc 0 诊断、vitest 684 例全绿（38 文件）、cargo check 通过
