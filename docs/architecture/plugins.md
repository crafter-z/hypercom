# 插件系统

本模块支持安装目录或 ZIP 形式的普通 JS 脚本插件；设置页分别提供“安装目录”和“安装 ZIP”入口，取消任一选择器不启动另一选择器。插件逻辑在主窗 Web Worker 中运行，UI 可用声明式 Sidebar/端口菜单、文本面板或独立隔离 WebView；隔离视图可替换串口内容或创建额外工作区标签。当前没有 Rust 原生插件、插件市场或远程调试器，插件 UI 不能访问宿主 DOM。

插件作者从独立的[插件开发指南](../plugin-development.md)开始：manifest、权限、Worker API、示例、调试和打包说明集中在那里。普通用户看[设置 → 插件](../userwiki/设置.md#插件)。本文只维护宿主实现、原生 IPC、授权一致性与磁盘恢复；发行验收见[插件发版验收门](release.md#插件发版验收门)，[历史设计评审](../reviews/plugins-review-2026-09-02.md)不代表当前问题清单。

独立 UI、串口内容替换及动作创建额外工作区标签的当前实现见[隔离视图与标签契约](plugin-views.md)。Windows raw Wry adapter 已实现；其他平台隔离承载未验收时明确拒绝，不用主窗 iframe 替代。

## 运行与信任边界

- `<config_dir>/plugins/<反向域名 id>/manifest.json` 与 manifest 指定的 `entry` 是插件代码来源；入口为单文件普通脚本，不支持 ESM `import` / `require`。Rust 的 `plugin::PluginManifest::validate` 校验 id、API 主版本、路径及权限声明；启动时宿主读取 manifest，失败即拒绝运行。
- 主窗口 `usePluginHost` 在 `ui.configReady` 后同步插件状态；会话绑定 `installGeneration`，身份变化终止旧 Worker。失败计数窗口为 10 秒，窗口内累计三次启动或运行失败后尝试持久化禁用并通知；未达阈值时，加载失败按 500ms × 当前失败次数等待重试，Worker 异常重启等待 100ms。设置页刷新可重试未运行会话；若禁用状态保存失败，记录错误而不声称持久化成功。弹窗不加载插件宿主。
- Worker 没有 DOM / `window.__TAURI__`；宿主和插件以 `postMessage` 通讯，宿主在每次 RPC 调用时检查当前安装身份及 `grantedPermissions`。`list_plugins` 在控制面闸门内取得一致的磁盘与配置快照；主窗 `pluginConfigSnapshot` 按后端 `revision` 拒绝迟到的列表和变更响应，防撤权后旧快照复活权限。插件安装与启用是用户信任决策，不是针对恶意主窗口脚本的强沙箱：能在主窗口执行的任意脚本仍可直接调用 Tauri 命令。后端对插件命令另做主窗口来源限制、已启用及权限验证，不把 Worker 中的 `pluginId` 当成不可伪造身份。
- 生产主窗口 CSP 在 `src-tauri/tauri.conf.json` 中限制 `connect-src 'self'`，Worker 出站 HTTP 只能经 `plugin_http_open/read/cancel`（`http:request` 授权；manifest 的 `http.urlWhitelist` 是可选收紧作用域，声明非空时逐跳校验）。默认跟随重定向（≤10 跳）、继承系统代理；用户显式配置的插件代理优先。无隐式 timeout 或响应大小截断，期限由调用方给出。可信原生网页使用浏览器网络，不受 Worker 代理/白名单约束，仍遵守浏览器 CORS/TLS。开发环境 `devCsp` 放行 Vite HMR。
- 已安装插件的 manifest 正常时，同 ID 仅接受更高版本覆盖安装；同版/降级拒绝，旧 manifest 损坏可修复安装。安装或升级默认禁用、清除普通授权及网页信任，生成新的 UUID `installGeneration`；可信网页先弹独立确认，普通权限另行授予，取消保留已安装但禁用状态。批准与启用绑定 `expectedGeneration`，升级期间排队的旧操作拒绝。网页批准独立于 `grantedPermissions`，正常重启保持，升级重审；`installedAt` 不参与身份判断。
- 设置页允许在插件禁用时逐项授权；权限整体替换按插件在模块级队列执行，启用等待当前授权队列落盘；安装/卸载进行时禁用设置页控制，但最终安全边界仍是后端安装身份检查。
- 安装/卸载在持久化禁用清权或配置提交后即使后续步骤失败，设置页也必须重新读取 `list_plugins` 权威快照；旧 Worker 先退休，快照读取失败时 fail-closed 停止宿主 Worker，不能继续按过期前端授权执行。
- `fs.openDialog` 与 `ui.panel.export` 受跨 Worker generation 共享的 per-plugin dialog permit 限制；permit 由实际原生 picker/write 任务持有到终止，Worker 退休不会提前归还容量。KV 排队写在 dispatch 和真实写入前复核 RPC authority，旧请求不能影响新 Worker。

- legacy all-port RX/bytes observer 也按订阅 `observerStart` 截断队列；撤权后重新订阅只接收订阅之后的数据和丢失通知，不能回放授权缺失期间的字节。


## 磁盘与配置

- `config.json` 使用 `AppConfig.entities.plugin_configs`（`#[serde(flatten)]`，JSON 顶层键 `pluginConfigs`），包含 id、安装身份、启用状态、授予权限和安装元数据。插件 KV 位于 `plugins/<id>/data/state.json`，不进入 config.json；`storage` 权限仅访问此文件，`fs:storage` 允许读取/写入整个 `data/`，`fs:assets` 允许读取自身代码和资产。
- 插件管理响应、排序和调用参数见下方[宿主命令契约](#宿主命令与状态快照)。普通配置保存以 revision CAS 并保留后端权威插件状态；备份恢复只允许同安装身份恢复启用/授权，不匹配的同 ID 插件禁用清权，未提及的当前插件保持原状，备份中的未安装插件不会被安装。导入后读回权威状态，取消设置保留当前插件状态及 revision。配置导出不包含插件代码、私有数据或事务 journal。
- `trustedWebGranted` 默认 false，独立于普通授权；普通保存保留后端权威值，备份导入不能增加或恢复已撤销的网页信任。每插件浏览器数据在 `<config_dir>/plugin-web-data/<id>/`，不在插件可读写 `data/`；升级保留，禁用不删，清除/卸载经原生 profile API 清空站点数据，空 profile 文件可保留。该目录不包含在配置导出中。
- Rust 的 manifest、路径、安装包及私有数据写入额度校验是权威执行点；文件读取不按扩展名、内容、大小或整个 data/ 配额拒绝。写入等待磁盘闸门最多 2 秒；读取等待同一闸门无固定期限。只有目标确实不存在才返回 null，权限/IO 错误不伪装成缺文件。
- 目录源按已打开句柄逐组件限定：Unix使用目录句柄相对`openat`与`O_NOFOLLOW/O_NONBLOCK`，Windows使用`NtCreateFile.RootDirectory`单组件相对打开并拒绝重解析，保留所选root/递归目录句柄且检查最终路径/链接数；共享祖先不长期锁定，不阻断别的临时目录操作。拒绝源根/祖先链接、特殊文件和硬链接，不先检查pathname再跟随打开；内容不承诺原子快照，复制字节/条目/深度限额保持。
- 严格路径政策可能拒绝macOS `/var`、`/tmp`别名或Windows junction源，请选择真实非链接路径；不以不安全跟随作为降级。Windows NTFS/UNC与Unix各平台仍需真实发行验收。
- ZIP先按96MiB压缩输入上限读取不可变快照，再校验实体中央目录条数（≤2000，不按去重后的名称数计）、16MiB中央目录及64KiB单条元数据。eager parser只见已验证元数据与唯一规范footer，不能退回载荷中的另一个footer放大分配；ZIP64条目保留，解压仍逐条流式计64MiB。拒绝重复名称、伪造计数、歧义中央目录结束标记。
- 安装先完整暂存并验证入口和 manifest 一致性，再持久化禁用清权及安全 `.bak`。`plugin/transaction.rs` 将受限 journal 写入 `<config_dir>/plugin-transaction.json` 并同步，路径只能由有效插件 ID 和 UUID 派生。启动在 Worker 前恢复中断事务：最终发布前恢复旧代码和私有数据，发布完成保留新树但不恢复授权；卸载配置提交前恢复备份，提交后清理备份。恢复幂等，非法/链接/含糊状态报错并保留数据。资产写入同步临时文件后单操作替换目标（Windows `MoveFileExW` 写穿透），不再先移走旧 KV 文件。文件系统和设备必须遵守 flush/write-through；准备阶段尚未登记的惰性 staging 残留不含迁移后的私有数据。
- 插件 `fs.openDialog` 的唯一入口为 Rust `plugin_pick_files`：验证插件启用及 `fs:open` 授权，由原生文件选择器产生路径，返回原始字节的 base64。无单文件/总量/数量限额；类型 filters 仅提示并追加 All files，不限制读取内容。宿主按请求返回解码文本或 `Uint8Array`。不提供接收任意路径的插件读取命令；`ui.panel.export()` 仍通过另存为写文本。

## 宿主命令与状态快照

这是**宿主前端与 Rust 的 IPC 契约**，不是 Worker 可直接调用的 API。宿主调用经 `src/services/plugin.ts`，命令参数采用 camelCase；插件 Worker 只经开发指南中的[API 桥](../plugin-development.md#调用-api-与处理事件)访问能力。

| Rust 命令 | 宿主参数 | 响应与关键语义 |
|---|---|---|
| `list_plugins` | 无 | `PluginListResponse = {revision, pluginConfigs, plugins}`；一致扫描/状态快照，不修改配置 |
| `install_plugin` | `{sourcePath, replaceExisting?}` | `PluginStateSnapshot`；更高版本正常覆盖；同版/降级默认拒绝并返回 `plugin_replace_confirmation_required:` 前缀，`replaceExisting:true` 才会替换。替换保留 `data/`，生成新身份并清除授权/网页信任 |
| `reload_plugin` | `{id, expectedGeneration}` | `PluginStateSnapshot`；主窗、已启用、manifest 可读才允许；取消该插件网络请求并退休原生视图后，用同一安装身份/授权/数据重新加载已安装代码 |
| `uninstall_plugin` | `{id, expectedGeneration}` | `PluginStateSnapshot`；expectedGeneration 必须匹配当前安装身份（防止升级期间排队的旧请求卸载新代码）；提交后删除该插件代码、状态及私有数据 |
| `set_plugin_enabled` | `{id, enabled, expectedGeneration}` | `PluginStateSnapshot`；expectedGeneration 必须为用户实际审阅的安装身份，旧身份拒绝 |
| `set_plugin_permissions` | `{id, permissions, expectedGeneration}` | `PluginStateSnapshot`；整体替换当前支持且 manifest 已声明的权限；可在禁用时授权 |
| `set_plugin_trusted_web` | `{id, trusted, expectedGeneration}` | `PluginStateSnapshot`；仅主窗独立确认后授予；撤销同时禁用并退休视图，普通权限命令不能替代 |
| `clear_plugin_web_data` | `{id, expectedGeneration}` | `PluginStateSnapshot`；要求插件禁用，退休视图后等待原生网页数据清理完成，失败报错 |
| `read_plugin_asset` | `{id, relPath, format?}` | `string \| null`；format 缺省/text 为 UTF-8 替代解码文本，binary 为 base64。仅缺文件返回 null，权限/IO 错误 reject；不设读取大小限制 |
| `write_plugin_asset` | `{id, relPath, content?, base64?}` | 无返回值；`content`（可空）与 `base64`（原始字节）互斥，二者皆缺则报错；仅已授权 `data/` 写入，路径/原子写约束保留，不设内容大小上限 |
| `plugin_http_open` | `{pluginId, expectedGeneration, requestId, request}` | `{requestId, status, headers, url}`；先同步登记 requestId 再连网，请求体 `body`/`bodyBase64` 互斥，`timeout` 为总期限（缺省=无），`redirect` 为 follow/manual/error |
| `plugin_http_read` | `{pluginId, expectedGeneration, requestId}` | `{base64, done}`；单次最多 64 KiB 传输块，总量无业务上限；有数据即返回（EOF 可带最后一块），取消/超时/撤权立即失败 |
| `plugin_http_cancel` | `{pluginId, expectedGeneration, requestId}` | 幂等；未知 requestId 记录有界「先取消后打开」意图，挂起中的 open/read 被打断 |
| `plugin_open_external` | `{pluginId, url}` | 无返回值；需要 shell:open，仅 http/https/mailto |
| `create_plugin_view` | `{binding}` | 主 WebView 专用；校验安装/权限/端口及资源后创建独立原生 UI |
| `update_plugin_view` | `{instanceId,rect,visible,layoutRevision}` | 最新 revision 几何及可见性；按主窗 zoom/DPI 转换并裁剪 |
| `send_plugin_view_message` | `{instanceId,message}` | 只准 init/state/environment 有界 JSON，状态快照 256 KiB，不接受源代码 |
| `destroy_plugin_view` | `{instanceId}` | 幂等退休原生路由/控件，迟到消息不能复活 |

`commands/file.rs` 的 `plugin_pick_files({pluginId, options})` 原生选择后复核安装身份和权限，wire 返回 `{files:[{path, base64}]}`。`executeHostApi` 将 binary 转为 `{files:[{path, bytes: Uint8Array}]}`，text 用共享 `lineText.decodeBytes` 返回 content；`fs.read` binary 同样返回 `Uint8Array`。`PluginSession` 在成功回复时转移文件缓冲区，不做 JSON 字节数组展开或再次复制；读取完成后再次核对请求仍存活及授权，旧请求不泄漏结果。`fs.read`/`fs.openDialog` 无 RPC 读取期限。文件读取与可信网页批准无关，完整读取仍受实际内存和运行时字符串/缓冲区能力约束。

`PluginConfigEntry` 包含 `id`、`installGeneration`、`enabled`、`trustedWebGranted`、`grantedPermissions` 和可选 `installedAt` / `source`。`PluginView` 另含校验后的 manifest、可声明/可授予权限和错误信息；manifest 损坏时仍列出错误项。`pluginConfigSnapshot` 按后端 revision 拒绝旧列表与旧变更响应，同步网页批准；安装身份变化丢弃旧 manifest UI 并使旧 KV 缓存失效。

## Worker 桥与派发

作者 API、事件载荷、配额和示例已集中至[插件开发指南](../plugin-development.md#api-参考)，这里不维护第二份接口表。

宿主执行链：`PluginSession.handleWorkerRequest` 验证当前安装身份、启用态及调用时权限 → `pluginHostApi.executeHostApi` 校验参数并执行具体能力。RX 数据在有当前读取授权时才转发；`pluginBridge` 收到批次后按订阅快照执行回调，等待返回的 Promise settle 后 ACK。RPC 到期只回收回执槽位，不能把迟到结果交给替换后的 Worker，也不承诺取消已开始的后端副作用。文件读取、私有写入、KV 持久化、`http.*` 与 `view.sendBinary` 不适用通用 RPC 期限（大文件/长连接/用户选择），取消仍走显式通道。

**错误分级**：`__plugin_ready` 现在由桥在用户入口脚本同步执行完成后发出；此前的加载/解析/初始化异常是致命启动失败（重试与 10 秒三次熔断保留）。就绪后的未处理拒绝、`worker.onerror` 与显式 `error` 事件只写诊断日志并限流提示，不终止会话、不清空插件内存。真正的原生视图进程故障仍按视图失败处理。

**纯网页插件**：`PluginManifest.entry` 可省略，仅当存在非空 `trusted-web` + `input:"none"` 视图且无 Worker 按钮/菜单时合法；`ui.views[].worker:false` 允许混合插件中的某个可信页不依附 Worker。宿主对这些视图使用 `workerEpoch=0`，不创建空 Worker、不等待 Worker ACK，Worker 重启不影响它们。

## RX 性能边界
`pluginObserver` 仅通过 `RxPipeline` 的行级多播钩子订阅；协议帧由 `enqueueFrame` 进入同一入口，和普通 TRX RX 行一样只投递一次，回放/TX 不触发此钩子。`pluginBytesObserver` 在 serial:data 层旁路，保留 TTY 字节。无订阅时不建立队列；每端口队列按行数、字节数受限，可见页按 rAF、隐藏页按 timer 递送，并在 visibilitychange 时重排已挂起的 rAF。最后一个字节订阅者注销时取消调度并清空旧端口队列。每个 Worker 的待确认事件数及字节数也有上限；跨 Worker 的字节批次使用精确长度独立 buffer，不能 transfer 与终端缓冲共享的 `rawData.buffer`。

## 验证与发行边界

- Rust 测试：ID/路径与 manifest 上限、ZIP 限额、安装身份与旧操作拒绝、同版替换确认、重载保持身份、纯网页 manifest 规则、逐 rename 中断恢复及卸载提交边界、缺文件与二进制/空内容区分、私有写入无全目录配额、HTTP 取消先于打开/无接收者持续生效、重定向模式与 glob 规范化；`cargo test --lib --manifest-path src-tauri/Cargo.toml`。
- 前端 Vitest：revision 响应乱序、升级期间权限操作、启用前授权、KV 读失败/损坏数据保全、通知配额、RX/字节旁路、UI 注册表与 Worker 初次失败恢复。`npx tsc --noEmit` 与 `npm run test:run`。
- `e2e/plugin.spec.ts` 使用真实 Chromium Worker/RX/终端但模拟 Rust invoke，不能证明原生选择器、真实 ZIP 事务或生产 WebView CSP。最终安装包验收见[发版要求](release.md#插件发版验收门)；下面的已执行记录不是发行包签收。

### 已执行的原生回归（2026-10-10）

2026-10-10 原生回归使用隔离配置及 `tauri build --debug --no-bundle`（生产前端资产与 CSP、Rust debug 可执行文件）：启用前授权、初始化 KV、200 条通知限流、HTTP 查询精确匹配、深目录额度拒绝后已有文件仍可读写、升级期间旧授权拒绝、重新授权保留 KV、卸载均通过；四个已启用插件同时启动并读取各自 KV 全部成功。五组磁盘中断快照由真实原生启动恢复（备份/私有数据迁移/发布、卸载提交前后），私有数据及禁用清权状态符合预期；这不是物理断电测试，也不替代最终 release 安装包和其他平台验收。

### 2026-10-29 文件二进制与无限额读取

Windows 生产前端资产/debug 应用、独立配置与测试桌面实跑普通 Worker 插件（trustedWebGranted=false）：包内 0–255 全字节、空文件、文本与非法 UTF-8 替代解码；`data/` 及原生选择器读取 65 MiB + 1 字节，Worker 得到 Uint8Array 且末字节完整；原生选择器一次选 9 个 `.bin`（插件过滤提示为 `.txt`）成功。该验证不包含流式读取或无限可用内存承诺。
