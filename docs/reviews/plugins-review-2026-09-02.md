# 插件系统设计方案（plugins.md）评审

**评审日期：2026-09-02（修订版） · 评审对象：`docs/architecture/plugins.md`（issue #17 提案）**
**结论：方向正确（A-）。首版评审 P1「层级错误」指控经复核撤回（文档挂钩点本身 RX 专属可行）；但仍有 P2/P4 两处必须修正的实质缺陷、C1/C2 两处事实性错误，以及一批待补定义空洞。修订版全文如下。**

> 修订说明：v2 依据 advisor + 代码复核修正了 P1（观察点定位）与 P4（CSP dev 语义），并补充 C2（serial:data direction 字段）与 TTY 字节观察（P1b）。原 P3「崩溃→disabled」保留为 P5。

---

## 0. 评审范围与方法

对 `docs/architecture/plugins.md` 逐节核对。每条断言对照仓库现状核实（文件/行号可复查）；设计评判基于现有架构纪律（AGENTS.md、configMerge、RxPipeline、useSerialReceive、viewportManager、popout、capabilities、CSP 机制）。

---

## 1. 事实核对（仓库现状 vs 文档断言）

| # | 文档断言 | 核实结果 |
|---|---|---|
| F1 | config.json 实体 8 类，新增第 9 类 `plugin_configs` | ✅ 属实。但与开放问题 2 冲突，见 P2 |
| F2 | commands 11 域 → 插件第 12 域 | ⚠️ 编号自洽；D5 清单漏列 config.rs 其余命令与 session 两条；第 9 类实体域归属未定，见 C1 |
| F3 | 15 hooks → 16 | ✅ 属实（15 生产 hooks）。宿主桥装配可能需额外 hook，见 C3 |
| F4 | `tauri-plugin-shell`/`clipboard-manager` 已在依赖 | ✅ 属实（Cargo.toml L18/L62；capabilities 已含 `shell:allow-open`、`clipboard-manager:*`） |
| F5 | `reqwest 0.13 (rustls)` 已在依赖 | ✅ 属实（Cargo.toml L60；update.rs 已有 15s 超时先例） |
| F6 | CSP 现状 = `null`、`withGlobalTauri = true` | ✅ 属实（tauri.conf.json L13/L27） |
| F7 | 生产 webview 零网络请求 | ✅ 属实（src/ 全树无 `fetch(`/WebSocket/XHR/`sendBeacon`/EventSource） |
| F8 | RX 旁路挂钩点 | ✅ **修正**：RxPipeline **内部**行产出点（`onLineAssembled` 之后、入队前，rxPipeline.ts:182-185）。TX 回显/TOOL/回放走 viewportManager 单行 `appendTerminalLine`（useSerialSend.ts:111、useToolOutput.ts:21/38、useLogReplay.ts:42），**不进入 RxPipeline**。见 P1 |
| F9 | 插件崩溃 → terminate + 置 disabled | ⚠️ 合理方向，有持久 DoS 面，见 P5 |
| F10 | configMerge「新增第 5 个合并源」 | 🔴 **现状已是 5 个实体**（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs，configMerge.ts 实核）。见 C1 |
| F11 | portPresets 属 config.json 实体 | ✅ 属实，且不在 useRuleStore。D6 若把插件 kv 放 config.json 会掉同一快照陷阱，见 P2 |

---

## 2. 方案结构评审（按严重程度排序）

### P1 🟠（修订）RX 观察点定位正确，但建议显式对齐 `onLineAssembled`，并补 TTY/方向定义

**复核结论**：首版指控「文档挂钩点收到 TX/TOOL/回放行」**不成立，撤回**。

仓库实际分层：
```
serial:data（direction 字段后端就有：serial/mod.rs:49 "RX"|"TX"）
  → useSerialReceive：TTY 分流 → ttyService；协议模板 → ProtocolFrameReassembler 分帧
  → RxPipeline.feedBytes → RxLineAssembler 字节切行
      → onLineAssembled 行级钩子（rxPipeline.ts:182，P1-1 触发器已挂这里）
      → 解码入队 → rAF tick → appendTerminalLines（viewportManager，RX 批写）
TX 回显/TOOL/回放：直接 appendTerminalLine（viewportManager 单行，不经过 RxPipeline）
```
- 复数批写 `appendTerminalLines` 由 RxPipeline 默认 opts 唯一调用（rxPipeline.ts:417）——在管线内行产出点挂钩**不会**混入 TX/TOOL/回放，「`terminal:read` 范围扩大」不成立。
- 但要补三个定义空洞：
  1. **推荐对齐 `onLineAssembled`**（rxPipeline.ts:182，触发器已用行级钩子）：D4 说挂「rAF 批写 appendTerminalLines 前」，与仓库已有的行级钩子位置（解码后入队前，逐行触发）不同。rx.onLine 若想逐行、免 TX 污染，应**注册第二个 onLineAssembled 观察者**或复用该钩子（注意现是「单回调可覆盖」——setOnLineAssembled 多次 set 取最后一次，需改多播或另挂）。文档需明确：rx.onLine 在**行组装层**（每个完整行，含静默 flush 尾行），而非 rAF 批写层。
  2. **TTY 字节观察留白**：D4「v1 仅 TRX 行；TTY 不进观察器」与「TRX/TTY 是 per-port 模式」冲突——**插件启用时端口从 TRX 切 TTY**，观察器瞬间断流且无通知。用例①（解崩溃 trace）的插件可能正是 TTY 场景。至少定义：切换时向插件发 `rx.detached`/状态事件（端口处于 TTY 模式时 rx.onLine 不触发，插件可感知）。
  3. **direction 字段**：`onLineAssembled` 回调对象现无 direction（纯 RX 路径所以没有）；rx.onLine 在行组装层天然纯 RX，若插件还要观察 TX（用例③联动软件看完整会话），应显式给 direction 并说明来自 `serial:data` 事件字段（serial/mod.rs:49）。

### P1b 🟠（新增）插件读 RX 行与既有「编码」耦合

`onLineAssembled` 回调给 `text`（已按当前 per-port 编码解码）+ `rawData`。用例①要「按编译映射解栈帧」——插件需要的是**原始字节**还是**解码文本**？若端口设 GBK，插件拿到的 `text` 已是 GBK→UTF-8 转码结果，栈帧地址（ASCII 子串）不受影响，但中文路径/符号会被转码。建议：rx.onLine 明确给 `rawData`（Uint8Array，未解码）+ 当前 encoding label，文本由插件自行决定是否解码——避免把宿主编码选择强加给插件。

### P2 🔴 配置模型自相矛盾：D6「第 9 类实体含 kv」 vs 开放问题 2「KV 存插件目录」

- §1/D6：`plugin_configs` 实体 = `{id, enabled, grantedPermissions, kv}`。
- §11 开放问题 2：推荐 KV 存 `<plugin_dir>/data/state.json`，config.json 只存启用/权限。
- 若 KV 进 config.json：kv 是可变高频数据，落「启动快照陷阱」（issue #5-2）——ConfigModal 全量保存若不并入会整体覆盖；且 `mergeLiveRuleEntities` 只并 useRuleStore 实体，KV 必须进 store 或另走存储路径。
- 文档自洽：既然开放问题 2 倾向 KV 不入 config，§1/D6 不该把 kv 写进 config 实体。

**建议**：文档内统一——`plugin_configs` = `{id, enabled, grantedPermissions}` 纯状态（走 config.json 纪律）；kv 归 `<plugin_dir>/data/` 经 `storage.get/set` 权限 API 读写。同步修正 §1/D6/§7。此决策应先于 C1（决定第 9 类实体字段）。

### P3（修订为 P5，见下）— 原 P3 崩溃 disabled 保留

### P4 🟠（修订）D8 CSP：dev 源漂移指控不成立，但 dev/prod 双策略是更好的解法

**复核结论**：advisor 对「script-src 源漂移」的反驳成立——dev 下主文档来自 devUrl（http://localhost:1420），`'self'` 即该源，Vite module scripts 属 `'self'`，不会被拦。撤回源漂移指控。

但 D8 仍有三个实质问题：

1. 🔴 **`devCsp` 缺失**：Tauri v2 `SecurityConfig` 有独立 `devCsp` 字段（config.schema.json:1159，注入 dev 构建的 HTML）。文档把 dev 例外写进同一 CSP 字符串（「dev 例外：放行 HMR ws」）是**错误机制**——正确做法是 **prod 用硬化 `csp`，dev 用放宽的 `devCsp`**（dev 下收紧 webview 无意义，且 react-refresh 需要更宽策略）。文档需改为「`csp` = 硬化值（生产）+ `devCsp` = 放宽值（含 ws://localhost:1420 等）」。
2. 🟠 **react-refresh 内联 preamble**：vite.config.ts 用 `@vitejs/plugin-react`（已核实）。dev 下该插件在 HTML 注入内联 refresh preamble 脚本 → 严格 `script-src 'self' blob:` **会拦内联脚本**，需 `'unsafe-inline'` 或 nonce。这是文档没提的第二个 dev 缺口，随 devCsp 放宽一并解决（devCsp 里放 `script-src 'self' 'unsafe-inline' blob:` 即可，生产 csp 不受影响）。
3. 🟠 **v2 CSP 注入机制与弹窗共用**：`app.security.csp` 配置后由 Tauri 注入且**全局**——主窗 + 全部 WebviewWindow（quick-send/terminal-*，capabilities 已含）共用同一 CSP；`devCsp` 同理全局。D8 回归清单列了弹窗 ✅，但需写明「devCsp 也作用于弹窗」与「弹窗是否执行插件宿主代码」（若执行则每窗建 worker+连桥，跨窗一致性未定义，见 P13/C5）。

### P5 🟠 Worker 崩溃→「置 disabled」可被利用为持久 DoS

- 恶意/缺陷插件每次启用即崩 → 被置 disabled（持久 config 状态）→ 反复失败无自愈；宿主持久配置被插件异常行为污染，与「崩溃隔离」承诺相悖。
- 单次瞬崩（未捕获 rejection）即永久禁用过重。
- 建议：连续 N 次「启用后 X 秒内崩溃」才置 disabled（附 diaglog 原因）；单次崩溃先 terminate + 通知 + 提供重试/禁用。明确崩溃计数边界与用户提示。

### P6 🟠 Worker 加载实现未定义：IIFE vs Blob URL

- `main.js` 是目录文件。读文件走 fetch(asset://…)（需自定义协议，v1 不做）还是后端 `read_plugin_asset` RPC → 文本 → Blob → `new Worker(blobUrl)`？后者每次启用一次 RPC，可接受但必须写明。
- 若走「读文本→Blob」，则「IIFE bundle」约束可放宽为「无 ESM import/require 语句的普通脚本」——文档「作者需打成 IIFE bundle（esbuild 模板）」与实际加载机制有一层未澄清选择。
- Blob URL worker 与 `script-src blob:` 绑定（生产已放行）。

### P7 🟡 权限模型缺「撤销即生效」——过滤必须在调用时，而非注入时

D3「桥侧按已授予权限集过滤 API 注入」有歧义：若 worker 启动时按当时 grantedPermissions 注入 `plugin.api.*`，**用户事后撤销，worker 里旧引用仍可调用**——serial.send/fs.read/terminal.append 都是本地能力，CSP 挡不住。D8「已授予权限是硬上限」只在「每次调用都校验」时成立。建议：权限过滤在**桥调用层**（每次 RPC 校验，撤销即时生效）；manifest permissions 只是可授予上限。§9 补「撤销后旧引用调用被拒」。

### P8 🟡 声明式 UI label 与 i18n 纪律冲突

插件按钮/菜单 label 是第三方字符串（manifest `label: "解析上次崩溃"`）——宿主无法翻译。需明确 label 不做 i18n（作者自管）或 manifest 提供 `{zh,en}` 双字段按当前语言取。

### P9 🟡 `terminal.append` 方向语义未定义

「TX 样式行」若走 appendTerminalLine 带 direction:'TX'，终端看起来像发了串口数据，且不经 sendToPort → 不进流量统计/发送历史/后端。用例①翻译行需要独立方向（NOTE）。建议显式传 direction 并说明不进流量统计。

### P10 🟡 `serial.send` 无 per-port 作用域

`serial:send` 授权后插件可对任意 portId 发送。对比 triggerEngine per-port via portId 语义，建议支持 per-port 白名单（manifest 或首次授权选端口）。

### P11 🟡 zip 解压路径穿越未单列

D8 只提 manifest 校验 + entry/assets 前缀检查，但 zip 解压阶段条目穿越（`../`/绝对路径/符号链接）未单列为安全控制——zip 安装标准攻击面，应列进 §9 后端测试。

### P12 🟡 RX 批转发缺宿主侧额度

「每帧至多一条 postMessage 携带 N 行」——N 未定；每行带 raw: ArrayBuffer（transfer），高频 RX（SIM 10kHz）下 transfer 风暴。建议 per-frame 行上限 + 字节上限（对齐 maxLinesPerTick=2000/maxQueuedLines=10000 纪律），超限丢最旧并告警。

### P13 🟡 RPC 5s 超时与能力上限矛盾 + 插件日志挤占 diaglog

- 单次调用超时 5s，但 http.request 上限 15s——合法长调用被宿主 5s 截断，契约矛盾。5s 只该约束纯同步桥调用；http/fs/shell 长任务需异步事件通道，或超时提到与能力上限一致。
- 插件 log 并入 diaglog：坏插件高频日志挤掉应用自身诊断日志（diaglog 512KB 轮转丢最旧）。需插件日志配额或独立通道。

### P14 🟡 扩展点渲染范围 vs 多 webview 体系

主窗与弹窗（quick-send/terminal-*）是独立 webview、独立 worker。弹窗是否渲染插件按钮？worker 在不在？v1 不做插件多 webview 弹窗，但扩展点渲染范围需定义，否则弹窗里出现点了没反应的按钮。

### P15 🟡 里程碑估时缺锚点

M1 骨架 3-4 天含 PluginManager + 新命令域 + config 实体 + 设置页 + WorkerHost + 生命周期——全栈 + 新持久化 + 新 UI，对比仓库 2-3 周/功能惯例偏乐观。建议给锚点或拆 M1。

---

## 3. 交叉引用与一致性缺陷

- **C1 「第 5 个合并源」计数错**：`mergeLiveRuleEntities` 现状已合并 5 个实体（configMerge.ts:33-38 实核）。插件实体加入应为**第 6 个**。§1「第 9 类实体」与 D6「第 5 个合并源」自相矛盾。
- **C2 serial:data 带 direction，但 onLineAssembled 回调丢方向**：后端事件已有 `direction: "RX"|"TX"`（serial/mod.rs:49）——即 RX 事件理论上可带 TX（GIT:BASH/TTY 场景的 TX 是否也 emit serial:data？serial/mod.rs:363 emit_data_event 的 direction 由调用方传，读线程只发 RX；发送路径不 emit serial:data，故管线纯 RX）。文档 D4 说「RxPipeline 行产出点」若指 onLineAssembled，天然纯 RX；若插件需 TX 需另接。见 P1-3。
- **C3 hooks 计数**：实际需 `usePlugins`（列表/启用/权限/安装/卸载）+ 主窗单例宿主桥装配（exactly-once，镜像 usePopoutBridge）≈ 2 个新 hooks → 17，非 15→16。
- **C4 弹窗 webview CSP 全局共用**：`security.csp`/`devCsp` 全局注入，主窗+弹窗共用。弹窗是否执行插件宿主代码未定义（见 P14）。
- **C5 D8「已授予权限是硬上限」依赖调用时校验**：见 P7。
- **C6 TTY 端口字节流与 TRX 观察器边界**：D4 说 v1 TTY 不进观察器，但未定义「端口 TRX→TTY 切换」的运行时行为。见 P1-2。
- **C7 manifest 校验权威点在 Rust + 前端预检只是 UX**：✅ 正确且必要。
- **C8 `img-src 'self' data:` 与背景图兼容**：✅ 核对成立（read_image_data_url 产 data: URL，img-src data: 放行；data URL 不经 fetch，不受 connect-src 影响）。文档此条正确。

---

## 4. 安全模型专项评审

方向（Worker 沙箱 + 信任模型 + CSP 兜底 + 声明式 UI 零 DOM）**正确**，与现有架构纪律一致。Worker 边界价值判断（主线程 eval 触达 `__TAURI__`/DOM/localStorage）正确且是决定性理由。专项发现：

1. **CSP 兜底层价值 = 堵意外通道而非硬隔离**（文档已正确表述）。需补推论：**CSP 挡不住本地能力**（serial.send/fs.read/terminal.append/clipboard），这些完全靠桥侧权限 + 调用时校验。文档对本地能力防线描述弱于出站网络（P7）。
2. **zip 解压穿越**、**撤销即时生效**是安全测试矩阵必补项（P7/P11）。
3. **一个缺失通道**：`http.request` 后端转发响应可含任意内容回写；`openExternal` 可开任意 URL（现 shell:allow-open 全局授权）——URL 白名单只约束 http.request，openExternal 是否 per-plugin 限制未提。
4. **dev 安全姿态**：devCsp 放宽不引入生产风险（仅 dev 构建注入），但要确认 CI/e2e 跑的是生产 CSP 的构建，否则 CSP 回归测试可能测的是 devCsp。

---

## 5. 改进优先级与结论

**必须修正（实施前）**：
1. P2 config 模型统一——kv 出 config.json（采纳开放问题 2 推荐），plugin_configs 只存状态。
2. P4 D8 改用 prod `csp` + dev `devCsp` 双字段（config.schema.json:1159 确认存在），补 react-refresh 内联 preamble 需 devCsp 放宽 script-src；写明 v2 注入机制与弹窗共用。
3. P1 明确定位 `onLineAssembled` 行级钩子（或新增多播注册），补 TTY 切换断流通知 + direction 字段语义。
4. P7 权限过滤移到调用时校验（撤销即时生效）。
5. C1/C2 计数与 direction 语义修正（第 6 个合并源；onLineAssembled 纯 RX 但缺 direction 字段）。

**应在提案内补充定义（实施前）**：
P5 崩溃阈值、P6 worker 加载实现、P8 UI label i18n、P9 terminal.append direction、P10 serial.send per-port、P11 zip 解压穿越、P12 批转发额度、P13 超时与日志配额、P14 弹窗扩展点范围、P15 估时锚点。

**已核实正确的设计点**（无需改动）：
- Worker 沙箱 vs 主线程 eval 决策；声明式 UI 零 DOM。
- CSP `connect-src 'self'` 与背景图/零网络请求兼容；`img-src data:` 放行。
- 权限模型方向、manifest 校验权威点在 Rust。
- 外部工具与插件不合并的职责分层。

**建议动作**：按 1-5 修改文档后再进入 M1；P1 的定位（onLineAssembled 行级 vs rAF 批写层）与 P2 的 config 决策牵动 §2/§4/§9 多处，最先拍板。

---

## 6. 附件：文档内具体位置索引

| 缺陷 | 位置 |
|---|---|
| P1/P1b | §3 现状表「RX 管线」行、§4 D4、§5 Host API rx.onLine、§9 |
| P2 | §1 结论、§4 D6、§11 开放问题 2 |
| P4 | §3 现状表「CSP = null」行、§4 D8、§10 |
| P5 | §5 RPC 契约「插件崩溃」条 |
| P6 | §4 D1/D8 |
| P7 | §4 D3、D8「已授予权限是硬上限」 |
| P8/P9/P10/P12/P13 | §5 Host API、§4 D2/D4 |
| P11 | §4 D7/D8、§9 后端测试 |
| P14 | §4 D2、§10 |
| C1 | §4 D6「第 5 个合并源」 |
| C2 | §4 D5、§5 Host API rx.onLine |
| C3 | §10 hooks 15→16 |

---

## 7. 修订记录

- **v2（2026-09-02）**：复核 advisor 两项反驳并核实代码后修正——P1 撤回「层级错误」指控，改为「定位正确，建议对齐 onLineAssembled + 补 TTY/direction 定义」；P4 撤回「script-src 源漂移」指控，改为「dev 源即 devUrl 无漂移，但应改用 prod csp + dev devCsp 双字段，并补 react-refresh 内联 preamble 缺口」。新增 P1b（编码耦合）、C2（serial:data direction）、C8（img-src 核对确认）。原 P3 重编号为 P5。
