# 插件系统设计方案（issue #17 提案）

**日期：2026-09-01 · 状态：提案（2026-09-02 修订：按评审 v2 修正 D4 观察点 / D8 CSP / 配置模型，详见 §12 修订记录） · 适用版本：0.7.0 起**

## 1. 结论

采用 **「JS 脚本插件 + 宿主声明式 UI + 显式权限」模型**：

- 插件 = 一个目录（`manifest.json` + `main.js` + 可选 `assets/`），运行时加载，无需重新编译应用。
- 插件代码在 **Web Worker 沙箱** 内执行（无 `window`/`document`/`__TAURI__`），通过 postMessage RPC 桥调用**权限过滤后的宿主 API**。
- 安全模型 = **安装即信任**（与浏览器扩展一致：permissions 是知情同意而非硬隔离）+ **CSP 硬化兜底**（生产 `connect-src 'self'` 关死 worker 直连外发，插件外联统一走后端 `plugin_http`；详见 D8）。
- 插件 UI 是**声明式注册**（按钮/菜单项/输出面板），由宿主 React 渲染；插件本身不接触 DOM。
- 敏感能力（TX 发送、HTTP 外联、shell 执行）按 manifest 声明 + 用户首次确认授予（类浏览器扩展）。
- 后端新增第 12 个命令域 `commands/plugin.rs` + `PluginManager`；config.json 新增第 9 类实体 `plugin_configs`（**仅状态**：`{id, enabled, grantedPermissions}`）；插件私有 KV 存插件目录 `data/`（见 D6），**不进 config.json**。
- 三个目标用例（解 trace / 功能按钮 / 联动软件）全部在 v1 覆盖；自定义复杂 UI（iframe 面板）列为 v2。

明确**不做**：Rust 原生插件（无 ABI，需 wasm，v3 再说）、插件市场/计费、插件远程调试器。

## 2. 需求拆解

| 用户描述 | 本质能力 | v1 覆盖 |
|---|---|---|
| 依据编译映射文件解崩溃 trace | RX 数据旁路观察 + 插件资源读取 + 输出回终端/面板 | ✅ `rx.onLine` + `fs.read(插件内)` + `terminal.append` |
| 添加功能按钮 | UI 扩展点 + 点击 → 插件执行 | ✅ Sidebar 工具栏/端口右键菜单声明式注册 |
| 联动其他软件 | 外部进程 / HTTP / 剪贴板 / 打开 URL | ✅ `shell.execute`（白名单+确认）、`http.request`（后端转发）、`clipboard`、`openExternal` |

共性抽象：**插件是「事件驱动 + 命令式 API」的脚本宿主**，与主应用解耦、权限受控、崩溃隔离。

## 3. 现状评估（可复用资产）

| 现状 | 对插件系统的意义 |
|---|---|
| `reqwest 0.13 (rustls)` 已在依赖 | HTTP 外联 API 直接复用，无需新增网络栈 |
| `tauri-plugin-shell` + `shell:allow-open` 权限 | `openExternal` 已有；`shell.execute` 需在 capabilities 加 `shell:allow-execute`（或走后端命令白名单） |
| `tauri-plugin-clipboard-manager` + 读写权限 | 剪贴板 API 现成 |
| RX 管线：`serial:data → RxPipeline（行组装：onLineAssembled 行级钩子 → 入队）→ rAF 批写 → viewportManager` | 旁路观察点明确：**行组装层**（`onLineAssembled` 同层，见 D4）；TX 回显/TOOL/回放走 viewportManager 单行入口、**不经过管线** → 观察器天然纯 RX；未装插件零开销 |
| `triggerEngine`（行级匹配 → 动作） | 已验证行级观察模式；插件观察器与其平行，不冲突。注意行级钩子**单回调可覆盖**，插件接入需多播化（D4） |
| config.json 实体机制（8 类 Vec 字段 + `mergeLiveRuleEntities` 审计） | 插件状态作第 9 类实体（仅状态，KV 不落 config），持久化/全量保存审计沿用既有纪律 |
| `CommandError` 枚举 + 11 域命令文件 | 插件命令作第 12 域，错误分类沿用 |
| 外部工具体系（`run_port_tool`/`kill_port_tool`，spawn+流式输出） | **保持独立**——外部工具是「端口绑定 + 输出进终端的进程运行器」；插件是「逻辑编排层」。插件可通过 `shell.execute` 调度同一批工具，但二者不合并 |
| 双语言 i18n（550 keys）、15 hooks、paneTree | UI 扩展点挂 Sidebar 工具栏/端口右键菜单/设置页「插件」分页，沿用现有 i18n 纪律；**插件自身 label 不做宿主翻译**（D2/P8） |
| 应用生产 webview 零网络请求（更新/HTTP 全走 Rust，背景图 data URL） | 生产 CSP 可安全设 `connect-src 'self'`——关死插件直连 fetch 不牺牲任何应用功能（D8）；dev 用独立 `devCsp` 放宽（Tauri v2 原生字段）；背景图/xterm/TTY/弹窗需回归验证 |
| `diaglog`（全局 log 落盘轮转） | 插件日志走**独立通道 + 配额**，不挤占应用自身诊断日志（P13） |
| CSP = `null`、`withGlobalTauri = true` | 主线程 eval 插件会直接触达 `__TAURI__`/DOM/localStorage → **这是选择 Worker 沙箱的决定性理由** |

## 4. 关键决策

### D1 执行环境：Web Worker 沙箱（v1 唯一执行环境）

| 方案 | 评价 |
|---|---|
| 主线程 `new Function`/eval | ❌ 插件可读 `window.__TAURI__` 调任意命令、读 localStorage、动 DOM、污染全局。防线 = CSP+清理，脆且难审计 |
| Web Worker | ✅ 无 DOM/无 `__TAURI__`/独立全局/崩溃只杀 worker；postMessage 结构化克隆传输 `ArrayBuffer` 零拷贝；RX 高频回调在 worker 侧节流不卡 UI。**选择** |
| iframe（`sandbox="allow-scripts"`，无 allow-same-origin） | 真实 DOM 隔离，但拿不到 `window.__TAURI__`；需自定义协议 `plugin://` 加载本地文件。**留作 v2 自定义 UI 面板** |

- Worker 有 `fetch`（https 受 CORS 约束，file:// 不可用）——**出站网络必须被 CSP 与权限双关**：生产 CSP `connect-src 'self'` 使 worker 直连 fetch 失败（worker 继承创建者页面 CSP），外联统一走后端 `plugin_http`（受 manifest 白名单 + 用户授予 `http:request` 约束）；详见 D8。
- Worker 内无 `invoke` → 一切能力经 RPC 桥，权限在桥侧过滤。
- **加载实现（P6）**：宿主经后端 `read_plugin_asset` 读 `main.js` 文本 → 包 Blob URL → `new Worker(blobUrl)`（每次启用一次 RPC 往返；生产 `script-src 'self' blob:` 已放行，D8）。v1 不做自定义 `plugin://` 协议。**打包要求随此放宽**：插件入口需是**无 ESM `import`/`require` 语句的普通脚本**（esbuild IIFE/UMD bundle 模板只是推荐写法，作者也可手写单文件）；v1 不做 require 解析。

### D2 UI 扩展：声明式注册，宿主渲染

- manifest 声明 `ui: { buttons: [{id, label, icon, target}], menuItems: [...] }`；icon 用 lucide-react 图标名（宿主已有该依赖）。
- 宿主在固定扩展点渲染：Sidebar 工具栏、端口右键菜单（`sidebar.port.contextMenu` 同层）、设置页「插件」分页。
- 点击 → `host.ui.buttonClick` 消息 → worker；插件经 `api.ui.panel` 写专属输出面板 / `api.terminal.append` 写终端 / `api.notify` 发通知。
- **插件零 DOM 权限**是本模型的安全核心：恶意插件最多画错输出，不能伪造界面钓鱼。
- **插件 label 不做宿主翻译（P8）**：manifest 的 label/描述是第三方字符串，宿主原样显示；如需双语，作者可提供 `{zh, en}` 双字段（v1 允许、文档给出格式即可），宿主按当前语言取。
- **扩展点渲染范围 v1 = 主窗（P14）**：弹窗（quick-send / terminal-*，独立 webview、独立模块作用域）**不加载插件 UI/worker**——插件宿主是主窗单例；弹窗内的端口发送仍走既有 popout 意图桥（`sendToPort` 管线），与插件无交集。避免跨窗 RPC 与多 worker 实例一致性负担（v2 再评估）。

### D3 权限模型（类浏览器扩展）

- manifest 声明 `permissions: string[]`；桥侧按「已授予权限集」在**每次调用时校验**（非注入时过滤）——撤销即时生效，worker 内旧 API 引用不因注入时点残留权限（P7）。manifest permissions 只是「可授予上限」。
- **出站双关**：`http:request` 是唯一合法出站通道——manifest 白名单 + 用户授予 + 生产 CSP `connect-src 'self'`（D8）三层；插件内直连 `fetch` 被 CSP 关死，不走桥即无权限可言。
- 敏感权限（`serial:send`/`http:request`/`shell:execute`）首次启用时弹确认框，列出 manifest 声明与风险说明；设置页可逐权限撤销。
- 可选权限参数：`http.urlWhitelist`（glob）、`shell.executableWhitelist`——声明即白名单，运行时校验。**`serial.send` 支持 per-port 白名单**（manifest 声明或首次授权时用户选择端口），对齐 triggerEngine 的 per-port 语义（P10）。
- 权限是**静态 per-plugin**、用户显式授予；与浏览器扩展一致的信任模型（恶意插件需用户先批准，批准后责任在用户）。

### D4 RX 数据接入：旁路观察者（行组装层，RX 专属）

- 新模块 `src/utils/pluginObserver.ts`：注册到 RxPipeline 的**行组装层钩子**（`onLineAssembled` 同层——每条完整 RX 行组装完成、解码后入队前触发，rxPipeline.ts:182），**不消费、不修改**数据流。
- **为什么是行组装层而非批写层（P1）**：TX 回显、TOOL 输出、日志回放走 viewportManager 单行 `appendTerminalLine`（useSerialSend/useToolOutput/useLogReplay），**不经过 RxPipeline**——挂管线内即天然只见纯 RX 行（后端 `serial:data` direction="RX"，serial/mod.rs:49）。挂 rAF 批写层或终端写口才会混入非 RX 行，故不采用。
- **多播注册（关键实现约束）**：行级钩子现状是**单回调可覆盖**（`setOnLineAssembled`，触发引擎已占用，rxPipeline.ts:140）。插件观察须把钩子升级为**多播注册表**（宿主触发器 + N 个插件观察者并存），插件**不得**再 set 覆盖触发引擎；或为插件另设独立多播旁路。禁止沿用 serial:data 块级订阅——P1-1 已证明读事件块边界任意、跨块匹配失效，行语义必须在组装层。
- 批转发：每帧至多一条 postMessage 携带 N 行（`ArrayBuffer` transfer 零拷贝）；**宿主侧 per-frame 行数 + 字节数设上限**（对齐 `maxLinesPerTick`/`maxQueuedLines` 纪律），超限丢最旧并告警（插件可见）（P12）。
- 仅在**已启用插件且订阅 rx** 时激活总线；零插件时路径上无任何额外分支开销。
- **回调载荷给未解码字节 + 编码 label（P1b）**：`{portId, seq, rawData: Uint8Array, encoding, ts}`——端口设 GBK 时宿主预解码文本会强加编码选择；文本由插件自行按需解码（栈帧地址等 ASCII 子串不受影响，中文路径/符号由插件决定）。
- **TRX/TTY 模式切换断流通知**：插件启用期间端口切到 `tty` → 行观察器对该端口断流；宿主向插件发 `rx.detached({portId, reason:'mode-tty'})`，切回 TRX 恢复。v1 仅 TRX 行；TTY 原始字节订阅留 v2。

### D5 后端形态

- 新增 `commands/plugin.rs`（第 12 域）+ `AppState.plugin_manager: Arc<Mutex<PluginManager>>`。
- 命令：`list_plugins` / `install_plugin(zipPath|dirPath)` / `uninstall_plugin(id)` / `set_plugin_enabled(id, enabled)` / `set_plugin_permissions(id, perms)` / `read_plugin_asset(id, relPath)` / `write_plugin_asset(id, relPath)` / `plugin_http(request)` / `plugin_shell(request)`。
- `read/write_plugin_asset`：**路径规范化 + 前缀校验**（`canonicalize` 后必须落在 `<plugins_dir>/<id>/` 内），防 `../` 穿越；`write` 仅 `storage` 权限授予后可用（限制写入 `data/` 子目录）。
- `plugin_http`：复用 `reqwest 0.13`；超时 15s（对齐 update.rs 惯例）；无凭据注入。
- `plugin_shell`：v1 仅 `openExternal` + 白名单可执行文件（`tauri-plugin-shell` 的 `Command` 或后端 `std::process`，取前者以复用现成 scope 校验）；`shell:allow-execute` 权限按需加进 capabilities。`openExternal` 的 per-plugin 限制（现 `shell:allow-open` 全局授权）实施时评估（见 §8）。
- `plugin_configs` 实体 CRUD（enable/permissions 落盘）并入 plugin.rs——permission/enable 变更需校验 + 联动运行时（terminate/重启 worker），超出 storage.rs 通用 upsert 语义；持久化本体走 ConfigManager 第 9 类 Vec（D6）。storage.rs 不加新命令。
- 事件 `plugins:changed` → 前端刷新插件列表。

### D6 配置与持久化

- 插件目录：`<config_dir>/plugins/<id>/`（与 config.json 同根，沿用 `ConfigManager` 路径解析）；v1 仅用户级。
- config.json 第 9 类实体 `plugin_configs: Vec<PluginConfigEntry>`：**仅存状态** `{id, enabled, grantedPermissions}`（+ 可选 `installedAt`/`source` 元数据）。**不含 `kv`**（P2）——插件私有 KV 存 `<plugin_dir>/data/state.json`，经 `storage.get/set` 权限 API 读写；卸载即随目录清理，config.json 不被高频 KV 写入污染，且避开「启动快照陷阱」（issue #5-2：全量保存会整体覆盖未并入的实体字段，portPresets 先例）。
- **持久化审计**：所有全量 `set_config` 前必须把活插件状态并入 `mergeLiveRuleEntities`——现状该函数已合并 **5 个实体**（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs），插件为**第 6 个合并源**。
- 插件状态变更 500ms 防抖自动保存（镜像 groups/portMeta 模式）。
- 卸载/更新时清理：卸载删除目录（含 data/）；重装覆盖保留还是重置 data/ 由插件 `version` 比较决定，v1 默认**保留 data/**（KV 生命周期长于插件代码，除非作者显式要求重置）。

### D7 分发与验证

- 目录即插件格式；zip 用于安装（`install_plugin` 解压 → 校验 → 落目录）。
- manifest 校验（纯函数，vitest）：必填 `id`（反向域名）/`name`/`version`/`apiVersion`/`entry`/`permissions`；`entry` 与 `assets` 路径必须指向插件目录内；`apiVersion` 与宿主兼容（宿主 API semver，`requiresApi >= 1.0`）。
- **zip 解压路径穿越（zip slip）单独防护（P11）**：解压阶段逐条目校验相对路径（拒绝 `../`、绝对路径、符号链接），与 manifest `entry`/`assets` 前缀检查分开实现、分开测试。
- 签名：可选 minisign（复用 updater 公钥体系），无签名 = 「未验证」标记 + 安装提示；v1 不强制。
- 插件更新：v1 手动（重装 zip/覆盖目录）；v2 可挂 update.rs 通道模型。

### D8 安全加固（CSP 兜底）

Worker 有原生 `fetch`——若不关死出站，`terminal:read` 权限下可见的串口数据可被插件直连外发，绕开 `http:request` 权限与桥侧过滤。「权限过滤 API 注入」对出站网络不成立，必须有传输层兜底。**注意边界**：CSP 只堵**出站意外通道**（直连 fetch、img 外链 beacon），挡不住本地能力（`serial.send`/`fs.read`/`terminal.append`/`clipboard`）——本地能力完全靠桥侧**调用时**权限校验（D3/P7）。

- **生产 CSP**（tauri.conf.json `app.security.csp`，当前为 `null`）：
  `default-src 'self'; script-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'`
  - `connect-src 'self'` 关死 worker 直连 fetch：worker 继承创建者页面 CSP 且与主文档同源，`'self'` 仅指应用自身；应用生产 webview **零网络请求**——自动更新/HTTP 外联全走 Rust 命令（update.rs / plugin_http）；背景图是 **data URL，不经 fetch，不受 `connect-src` 约束**，且已被 `img-src data:` 放行（与现状 `read_image_data_url` 兼容）。
  - `script-src 'self' blob:`：插件 worker 经 Blob URL 加载需显式放行 `blob:`；`'self'` 覆盖 Vite 产物。
  - `style-src 'unsafe-inline'`：React 内联 style + xterm 注入样式所需（现状页面依赖，收紧需先审计）。
  - **dev 用独立 `devCsp` 字段**（Tauri v2 `SecurityConfig.devCsp` 原生存在，config.schema.json:1159），**不在生产字符串里做 dev 例外**。dev 下主文档源即 `build.devUrl`（http://localhost:1420），`'self'` 即该源——Vite module scripts 属 `'self'` 无需放行；真正的 dev 缺口有二：① **@vitejs/plugin-react 的 HMR refresh preamble 是内联脚本** → `script-src` 需放行 `'unsafe-inline'`（或 nonce）；② HMR websocket → `connect-src` 需放行 `ws://localhost:1420`。devCsp 建议：`default-src 'self'; script-src 'self' 'unsafe-inline' blob:; connect-src 'self' ws://localhost:1420; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'`。
  - **注入机制**：`csp`/`devCsp` 由 Tauri 注入 HTML 且**全局**——主窗 + 全部 WebviewWindow（quick-send / terminal-* 弹窗，capabilities 已含）共用；`devCsp` 未配置时 Tauri 回退注入 `csp`。CSP 变更回归清单须含弹窗 webview。
- **CSP 是兜底层，不是唯一防线**：主姿态仍是信任模型——「安装即信任，permissions 是知情同意而非硬隔离」（与浏览器扩展一致）。CSP 关的是**绕过权限模型的意外通道**（直连 fetch、img 外链 beacon），不替代权限语义。两层同时部署：恶意插件需用户先批准安装/启用，且即便批准也无法越过 `connect-src 'self'` 直发数据。
- **manifest 校验权威点在 Rust**：TS 侧校验只是 UX 预检；`install_plugin` 必须做后端独立校验——serde 反序列化 + 必填字段/`apiVersion` 兼容性 + `entry`/`assets` 路径前缀检查 + **zip 解压条目穿越校验**（D7）。前端结果不可信，前端校验失败 ≠ 后端拒绝。
- **已授予权限是硬上限，过滤在调用时**：每次 RPC 校验当前 grantedPermissions，撤销即时生效；CSP 只保证无直连出站通道，本地能力撤销不依赖 CSP，依赖桥侧调用时校验（D3）。
- **e2e 跑生产 `csp` 的构建**（devCsp 放宽不引入生产风险，但要防回归测试误测 devCsp 而漏掉生产策略）。

## 5. 架构

```
┌─ 主 webview（React）────────────────────────────────────────────┐
│  Sidebar/TabBar/…（声明式扩展点渲染，v1 仅主窗）                    │
│        │ click / 状态                                            │
│  pluginHost.ts ──(RPC 桥, 调用时权限校验)──▶ Worker(插件 main.js)   │
│        │                ◀──postMessage(结构化克隆/transfer)────   │
│  ├─ rxObserver（RX 旁路总线, 行组装层, 批转发）                     │
│  └─ api 实现层（invoke → 后端命令 / RxPipeline / sendToPort）      │
└───────────────┬──────────────────────────────────────────────────┘
        invoke / events（plugins:changed / plugin:event）
┌─ 后端（Rust）────────────────────────────────────────────────────┐
│  AppState.plugin_manager: Arc<Mutex<PluginManager>>               │
│  commands/plugin.rs（第 12 域：CRUD/资产/http/shell）              │
│  <config_dir>/plugins/<id>/ + config.json plugin_configs 实体      │
└──────────────────────────────────────────────────────────────────┘
```

### 目录约定

```
<config_dir>/plugins/
└── com.example.symresolve/
    ├── manifest.json
    ├── main.js          # 单个普通脚本（无 ESM import/require；作者可用 esbuild 模板打包）
    ├── assets/          # 只读资源（编译映射文件等）
    └── data/            # 可写私有区（storage 权限；state.json = 插件 KV，D6）
```

### RPC 契约

- 双向消息均带 `{seq, op, args}`；插件侧 `plugin.api.<op>(...)` 为 Promise；宿主侧错误 → reject（错误串入 diaglog）。
- 单次**同步**调用超时 5s；长任务（http/fs/shell/大文件读）走异步事件通道或按能力上限设独立超时（`http.request` 15s 上限不被 5s 截断）（P13）。
- 回调风暴：宿主侧队列上限（默认 1000 条/帧，超限丢弃最旧并告警）。
- 插件崩溃（worker error/unhandledrejection）→ terminate + 通知 + 提供重试/禁用；**连续 N 次「启用后 X 秒内崩溃」才置 disabled**（阈值防恶意/缺陷插件以崩溃做持久 DoS；单次瞬崩不写持久状态）（P5）；宿主进程不受影响。

### Host API v1（插件侧视图）

```
ports.list() / ports.status(portId) / ports.onChange(cb)
rx.onLine(cb)                        // {portId, seq, rawData: Uint8Array, encoding, ts}——未解码字节 + 编码 label（D4/P1b）
rx.getBuffer(portId, {from, to})     // 只读快照，单次 ≤ 2000 行（行文本惰性解码同 terminal 语义）
terminal.append(portId, text, opts)  // 旁注行，direction 显式（NOTE/INFO…）；不进流量统计/发送历史（P9）
serial.send(portId, data, {isHex, lineEnding})  // 走 sendToPort 全管线；per-port 白名单约束（P10）
fs.read(rel) / fs.list(rel) / fs.write(rel, data)   // 限定插件目录；write 仅 data/（storage 权限）
http.request({method, url, headers, body, timeout}) // 后端转发，15s 上限；urlWhitelist glob 校验
shell.execute(exec, args, opts) / shell.openExternal(url)  // executableWhitelist；openExternal per-plugin 限制实施时评估
clipboard.readText() / clipboard.writeText(text)
notify({title, body, level})
storage.get(key) / storage.set(key, value)  // data/state.json（D6，不进 config.json）
log(level, msg)                      // 插件日志独立通道 + 配额，不挤占 diaglog（P13）
events.on(event, cb) / events.emit(event, payload)
```

### 宿主 → 插件事件

```
lifecycle: enabled|disabled|uninstalled
rx.line 批（默认 rAF 批；权限 terminal:read；行组装层产出）
rx.detached({portId, reason})        // TRX→TTY 切换等行观察断流通知（D4）
port.status / ports.changed
ui.buttonClick({buttonId, context})  // context = 端口等
```

### Manifest schema

```json
{
  "id": "com.example.symresolve",
  "name": "Symbol Resolver",
  "version": "1.2.0",
  "description": "依据 map 文件解崩溃栈",
  "apiVersion": "1.0",
  "entry": "main.js",
  "permissions": ["terminal:read", "terminal:write", "fs:assets"],
  "http": { "urlWhitelist": ["https://symbols.example.com/**"] },
  "shell": { "executableWhitelist": ["addr2line", "llvm-symbolizer"] },
  "ui": {
    "buttons": [
      { "id": "resolve-last", "label": "解析上次崩溃", "icon": "Search", "target": "sidebar" }
    ],
    "menuItems": [
      { "id": "resolve-line", "label": "解析此行", "target": "port-context" }
    ]
  }
}
```

## 6. 三个目标用例走查

**① 解崩溃 trace**：插件启用后 `rx.onLine` 观察（行组装层，纯 RX；按 `encoding` 自解码）→ 行匹配栈帧模式（`triggerEngine` 同款 contains/regex）→ 命中行 → `fs.read("assets/symbols.map")` 建索引（首行懒加载）→ 翻译 → `terminal.append`（`direction:'NOTE'` 旁注样式）或 `ui.panel.append` 聚合结果。零侵入：原数据流不变，翻译行是新行，原始行保留。若端口处于 TTY 模式，观察器断流且收到 `rx.detached`——插件应提示用户该模式不支持行观察。

**② 功能按钮**：manifest 声明 `ui.buttons` → Sidebar 工具栏渲染 → 点击 → `ui.buttonClick` → 插件执行（如「发送厂商握手序列」= `serial.send` × N 步（per-port 白名单内）+ 状态展示）。

**③ 联动其他软件**：`shell.execute`（白名单，如调用 flasher CLI）流式读输出经 `events.emit` 转发到 `ui.panel`；或 `http.request` 拉远端符号服务/状态查询 → 结果回面板。`openExternal` 开文档/工具链接。

## 7. 里程碑与工作量（单人全职估）

| 里程碑 | 内容 | 验收 | 估时 |
|---|---|---|---|
| M1 骨架 | PluginManager 后端（扫描/校验/CRUD）+ plugin.rs + config 实体 + 设置页「插件」分页 + WorkerHost 加载 + 生命周期 | 安装 hello-world 插件、启用/禁用、日志可见 | 3–4 天 |
| M2 数据 API | rx 行组装层旁路（多播化 onLineAssembled）+ rx.onLine/getBuffer + terminal.append + serial.send + ports 只读 + 权限调用时校验 | 示例插件翻译 RX 栈帧行（用例①） | 3–4 天 |
| M3 能力 API | fs/http/shell(白名单)/clipboard/notify/storage/openExternal | 示例插件联动外部工具/远端服务（用例③） | 2–3 天 |
| M4 UI 扩展点 | Sidebar 按钮、端口右键菜单、输出面板、确认对话框 | 按钮点击执行插件（用例②） | 2–3 天 |
| M5 加固 | 超时/配额/崩溃阈值、zip 安装 + 解压穿越校验、签名（可选）、示例插件仓库、e2e/单测 | 全量测试绿 | 2–3 天 |

合计约 **2–3.5 周**。核心（M1–M4）约 2 周先落地，M5 加固按需。
> 估时锚点：M1 含全栈（后端管理器 + 新命令域 + 新持久化实体 + 新 UI 分页 + worker 生命周期），对比仓库既有功能（2–3 周/功能）偏紧；实施时若按天核算超支，M1 可拆 M1a（后端扫描/CRUD/校验）/M1b（前端设置页 + WorkerHost），各自独立验收。

## 8. 风险与边界

- **CSP 收紧影响面**：`csp: null` → 硬化值（prod `csp` + dev `devCsp` 双字段）是一次全局变更，必须回归背景图/xterm/TTY/弹窗/更新弹窗；devCsp 放宽只影响 dev 构建，e2e 须跑生产 csp（D8）。
- **RX 高频带宽**：批转发 + 宿主侧 per-frame 行/字节额度 + 插件侧节流；实测（SIM:Loopback 高频模式）验证无卡顿。
- **行级钩子多播化**：`setOnLineAssembled` 单回调 → 多播注册表是既有触发引擎的改动面，需回归触发规则（M2 首件事）。
- **TRX/TTY 模式切换断流**：per-port `mode` 切换使行观察器断流——D4 定义 `rx.detached` 通知，插件需处理（用例① TTY 场景暂不支持，明确提示）。
- **Tauri iframe/自定义协议兼容性**：v2 才引入 `plugin://`；v1 脚本模型不依赖。
- **与外部工具重叠**：不合并，职责分层（运行器 vs 编排层），避免破坏既有 `run_port_tool` 闭环。
- **`openExternal` 全局授权**：现 `shell:allow-open` 对主窗全局可用；插件获得该权限后可开任意 URL——http.urlWhitelist 不约束它，实施时评估 per-plugin 限制或对插件走独立受限通道。
- **生态冷启动**：提供插件模板仓库（esbuild bundle 模板 + 三个示例插件）+ 文档；插件校验器 CLI 可在 CI 用。
- **插件可见 RX 数据**：属 `terminal:read` 权限明示用途，授予即知情。
- 不做：Rust 原生/wasm 插件、插件市场、插件内嵌 iframe 自定义 UI（v2）、插件多 webview 弹窗（复用 popout 体系需额外协议）、弹窗内插件 UI（v2）。

## 9. 测试与验证策略

- 纯函数单测（vitest）：manifest 校验、路径穿越防护、**权限过滤矩阵（含撤销后旧引用被拒的调用时校验用例）、RPC 桥（fake worker）、RX 旁路总线（注入假管线，断言纯 RX 无 TX/TOOL 混入）**——桥侧调用时权限校验是方案核心，纯函数矩阵测试必须覆盖。
- 后端单测（cargo test）：`read/write_plugin_asset` 穿越用例、**zip 解压条目穿越（zip slip：`../`/绝对路径/符号链接）用例**、`plugin_http` 参数校验（不触 serialport FFI，Windows 全平台可跑）；**manifest 校验权威点在 Rust**——`install_plugin` 对畸形 manifest（缺字段/`apiVersion` 不兼容/`entry` 越目录）拒绝安装的用例必须在后端测，TS 预检结果不可信。
- CSP 回归（e2e + 手动清单）：设 prod `csp` + dev `devCsp` 后背景图加载、xterm 渲染、TTY 会话、弹窗 webview、dev HMR（ws + refresh preamble）均正常；**e2e 断言基于生产 csp 的构建**；插件直连 fetch 被拒（插件内 `fetch` 抛出 CSP 错误）作为安全断言。
- e2e（playwright + DEV 构建）：安装示例插件 → 启用 → 注入 RX 行 → 断言翻译输出；权限拒绝路径（未授权 API → reject）；**端口切 TTY 后观察器断流 + `rx.detached` 通知**。
- 性能冒烟：SIM:Loopback 高频下启用 rx 观察插件，断言帧率无劣化。

## 10. 对现有约定的影响

- `commands/` 11 → 12 域；`mod.rs` re-export + `lib.rs` `invoke_handler!` 注册。plugin_configs 实体 CRUD 并入 plugin.rs（D5），storage.rs 不加命令。
- config.json 实体 8 → 9 类（**仅状态实体**，KV 不落 config）；`mergeLiveRuleEntities` 新增插件合并源（**第 6 个**，现状已 5 个）；AGENTS.md/README 索引更新。
- hooks 15 → 17：`usePlugins`（列表/启用/权限/安装/卸载）+ 主窗插件宿主桥装配 hook（worker 生命周期单例，exactly-once，镜像 usePopoutBridge 模式）；`src/utils/pluginHost.ts` + `pluginObserver.ts`。
- i18n 新增 `plugins.*` key（宿主 UI：设置页/确认框/菜单宿主部分，双语）；**插件自身 label 不翻译**（作者自管或提供 `{zh,en}`）。
- **CSP 硬化**：`tauri.conf.json` 新增 `app.security.csp`（生产硬化值）+ `app.security.devCsp`（dev 放宽，Tauri v2 原生字段）——一次全局安全变更，需回归背景图/xterm/TTY/弹窗/更新弹窗，e2e 跑生产 csp。
- capabilities 按需加 `shell:allow-execute`。
- 新增文档：本文件入 `docs/architecture/README.md` 索引。

## 11. 开放问题（实施前需拍板）

1. `shell.execute` 走 `tauri-plugin-shell`（capabilities scope 校验）还是后端白名单命令？——推荐前者（scope 机制成熟），白名单由 manifest 声明 + 用户确认。
2. ~~插件私有 KV 存 config.json 实体还是插件目录 `data/state.json`？~~ —— **已定**：存插件目录 `data/state.json`（D6 采纳；config.json 只存启用/权限，规避快照陷阱）。
3. 首个版本是否要求 minisign 签名？——推荐不强制（社区插件冷启动优先），「未验证」标记 + 提示。

## 12. 修订记录

- **2026-09-02（评审 v2 修订）**：按 `docs/reviews/plugins-review-2026-09-02.md` 修正——
  - **D4**：RX 旁路观察点改为**行组装层**（对齐 `onLineAssembled`），并补多播注册约束、纯 RX 语义依据、载荷给未解码字节 + encoding（P1/P1b/C2）、per-frame 额度（P12）、TRX/TTY 切换 `rx.detached`（P1b-2）。
  - **D8**：CSP 改用 **prod `csp` + dev `devCsp` 双字段**（Tauri v2 原生），补 react-refresh 内联 preamble 与 HMR ws 的 dev 缺口、注入机制与弹窗全局共用（P4）。
  - **D6/§1**：`plugin_configs` 改为**仅状态实体**（KV 出 config.json），开放问题 2 关闭（P2）。
  - **D3/§5**：权限过滤明确为**调用时校验**（撤销即时生效）（P7）。
  - **D1**：Worker 加载实现明确为后端读文件 → Blob URL → Worker，打包要求放宽为无 ESM 语句（P6）。
  - **§5 RPC**：崩溃处置加阈值（防持久 DoS）（P5）；5s 超时限定同步调用，长任务独立通道（P13）。
  - **D2/§10**：插件 label 不做宿主翻译（P8）、扩展点 v1 仅主窗（P14）；hooks 15→17（C3）。
  - **D7/§9**：zip 解压穿越单列为独立防护与测试（P11）。
  - **§10/D6**：`mergeLiveRuleEntities` 计数修正为第 6 个合并源（C1）。
