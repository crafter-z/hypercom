# 插件系统

本模块支持安装目录或 ZIP 形式的普通 JS 脚本插件；设置页分别提供“安装目录”和“安装 ZIP”入口，取消任一选择器不启动另一选择器。插件逻辑在主窗 Web Worker 中运行（纯网页插件可以没有 Worker），UI 可用声明式 Sidebar/端口菜单、文本面板或独立隔离 WebView；隔离视图可替换串口内容或创建额外工作区标签。当前没有 Rust 原生插件、插件市场或远程调试器，插件 UI 不能访问宿主 DOM。

插件作者从独立的[插件开发指南](../plugin-development.md)开始：manifest、权限、Worker API、示例、调试和打包说明集中在那里。普通用户看[设置 → 插件](../userwiki/设置.md#插件)。本文只维护宿主实现、原生 IPC、授权一致性与磁盘恢复；发行验收要求见[插件发版验收门](release.md#插件发版验收门)。

独立 UI、串口内容替换及动作创建额外工作区标签的当前实现见[隔离视图与标签契约](plugin-views.md)。Windows raw Wry adapter 已实现；其他平台隔离承载未验收时明确拒绝，不用主窗 iframe 替代。

## 运行与信任边界

- `<config_dir>/plugins/<反向域名 id>/manifest.json` 与 manifest 指定的 `entry` 是插件代码来源；入口为单文件普通脚本，不支持 ESM `import` / `require`。Rust 的 `plugin::PluginManifest::validate` 校验 id、API 主版本、路径及权限声明；启动时宿主读取 manifest，失败即拒绝运行。
- 主窗口 `usePluginHost` 在 `ui.configReady` 后同步插件状态；会话绑定 `installGeneration`，身份变化终止旧 Worker。启动失败计数窗口为 10 秒：窗口内累计三次启动失败后尝试持久化禁用并通知，未达阈值时按 500ms × 当前失败次数等待自动重试；`__plugin_ready` 之后的运行时错误只记诊断，不重启、不计数（分级见 [Worker 桥与派发](#worker-桥与派发)）。设置页刷新可重试未运行会话；若禁用状态保存失败，记录错误而不声称持久化成功。弹窗不加载插件宿主。
- Worker 没有 DOM / `window.__TAURI__`；宿主和插件以 `postMessage` 通讯，宿主在每次 RPC 调用时检查当前安装身份及 `grantedPermissions`。`list_plugins` 在控制面闸门内取得一致的磁盘与配置快照；主窗 `pluginConfigSnapshot` 按后端 `revision` 拒绝迟到的列表和变更响应，防撤权后旧快照复活权限。插件安装与启用是用户信任决策，不是针对恶意主窗口脚本的强沙箱：能在主窗口执行的任意脚本仍可直接调用 Tauri 命令。后端对插件命令另做主窗口来源限制、已启用及权限验证，不把 Worker 中的 `pluginId` 当成不可伪造身份。
- 生产主窗口 CSP 在 `src-tauri/tauri.conf.json` 中限制 `connect-src 'self'`，并以 `wasm-unsafe-eval` 允许插件 Worker 编译/实例化 WebAssembly；Worker 出站 HTTP 只能经 `plugin_http_open/read/cancel`（`http:request` 授权；manifest 的 `http.urlWhitelist` 是可选收紧作用域，声明非空时逐跳校验）。默认跟随重定向（≤10 跳）、继承系统代理；用户显式配置的插件代理优先。无隐式 timeout 或响应大小截断，期限由调用方给出（完整语义见 [HTTP 流式契约](#http-流式契约)）。可信原生网页使用浏览器网络，不受 Worker 代理/白名单约束，仍遵守浏览器 CORS/TLS。开发环境 `devCsp` 放行 Vite HMR 并同步允许 WASM。
- 已安装插件的 manifest 正常时，同 ID 仅接受更高版本覆盖安装；同版/降级拒绝，旧 manifest 损坏可修复安装。安装或升级默认禁用、清除普通授权及网页信任，生成新的 UUID `installGeneration`；可信网页先弹独立确认，普通权限另行授予，取消保留已安装但禁用状态。批准与启用绑定 `expectedGeneration`，升级期间排队的旧操作拒绝。网页批准独立于 `grantedPermissions`，正常重启保持，升级重审；`installedAt` 不参与身份判断。设置页仅在 `install_plugin` 返回同版/降级前缀时弹替换确认，取消不写磁盘；安装后按权威快照中 `installGeneration` 的变化识别新装插件，不按渲染进程的 manifest 列表推断。
- 重载（`reload_plugin`）只重启已安装副本：不重新读取来源目录、不写 `config.json`（revision 不变），保留 `installGeneration`、`grantedPermissions`、`trustedWebGranted` 与 `data/`；要求主窗调用、已启用且磁盘 manifest 仍可校验。后端取消该插件在途 HTTP 并退休原生视图后返回当前快照；前端先停旧 Worker，快照被 revision 判旧即报错，否则严格等待新 Worker 到 `__plugin_ready` 再刷新列表并重建视图；只有快照被接受且新 Worker 就绪后才提示成功，陈旧快照或启动失败只报错。纯网页插件不创建 Worker。
- 设置页允许在插件禁用时逐项授权；权限整体替换按插件在模块级队列执行，启用等待当前授权队列落盘；安装/卸载进行时禁用设置页控制，但最终安全边界仍是后端安装身份检查。
- 安装/卸载在持久化禁用清权或配置提交后即使后续步骤失败，设置页也必须重新读取 `list_plugins` 权威快照；旧 Worker 先退休，快照读取失败时 fail-closed 停止宿主 Worker，不能继续按过期前端授权执行。
- `fs.openDialog` 与 `ui.panel.export` 受跨 Worker generation 共享的 per-plugin dialog permit 限制；permit 由实际原生 picker/write 任务持有到终止，Worker 退休不会提前归还容量。KV 排队写在 dispatch 和真实写入前复核 RPC authority，旧请求不能影响新 Worker。

- legacy all-port RX/bytes observer 也按订阅 `observerStart` 截断队列；撤权后重新订阅只接收订阅之后的数据和丢失通知，不能回放授权缺失期间的字节。


## 磁盘与配置

- `config.json` 使用 `AppConfig.entities.plugin_configs`（`#[serde(flatten)]`，JSON 顶层键 `pluginConfigs`），包含 id、安装身份、启用状态、授予权限、网页信任和安装元数据。插件 KV（`pluginKv`）位于 `plugins/<id>/data/state.json`，不进入 config.json；`storage` 权限仅访问此文件，`fs:storage` 允许读取/写入整个 `data/`，`fs:assets` 允许读取自身代码和资产。KV 只在确认文件不存在时初始化空对象，读缓存按安装代次失效、并发首载共享同一次读盘；`set` 按插件串行、整体序列化后经 `write_plugin_asset` 原子替换；不设键长、值大小、节点数或文件大小上限，但仍只接受可无损 JSON 化的值（拒绝非有限数、访问器、循环引用等），`undefined` 删除键。
- 插件管理响应、排序和调用参数见下方[宿主命令契约](#宿主命令与状态快照)。普通配置保存以 revision CAS 并保留后端权威插件状态；备份恢复只允许同安装身份恢复启用/授权，不匹配的同 ID 插件禁用清权，未提及的当前插件保持原状，备份中的未安装插件不会被安装。导入后读回权威状态，取消设置保留当前插件状态及 revision。配置导出不包含插件代码、私有数据或事务 journal。
- `trustedWebGranted` 默认 false，独立于普通授权；普通保存保留后端权威值，备份导入不能增加或恢复已撤销的网页信任。浏览器数据在 `<config_dir>/plugin-web-data/<id>/<installGeneration>/`，目录入口统一校验 UUID，不在插件可读写 `data/`；同代次重载/禁用不删，新安装代次不复用旧站点数据。清除/卸载经原生 profile API 清空当前代次站点数据，失败如实返回且可重试，空 profile 文件可保留；崩溃遗留的旧代次不向新代码暴露。该目录不包含在配置导出中。
- Rust 的 manifest、路径及安装包额度校验是权威执行点；私有数据读写不按扩展名、内容、大小、总量或整个 data/ 配额拒绝。资产读写、`list_plugins`、安装/卸载/重载、启用/授权/网页信任变更、网页数据清理与配置恢复共用 `AppState.plugin_io` 异步闸门串行；统一准入只对等待闸门设置 5 秒 busy 可重试期限，不给已开始的文件 IO、用户对话框或 HTTP 添加隐式业务期限。普通 revision-CAS `set_config` 不排在插件 IO 后面，备份恢复仍先取得闸门，保持安装/授权事务锁序。HTTP/资产授权使用轻量 manifest 校验，视图只在锁外读取选中资源快照；安装/启用/完整重载仍保留完整包校验。只有目标确实不存在才返回 null，权限/IO 错误不伪装成缺文件。
- 目录源按已打开句柄逐组件限定：Unix使用目录句柄相对`openat`与`O_NOFOLLOW/O_NONBLOCK`，Windows使用`NtCreateFile.RootDirectory`单组件相对打开并拒绝重解析，保留所选root/递归目录句柄且检查最终路径/链接数；共享祖先不长期锁定，不阻断别的临时目录操作。拒绝源根/祖先链接、特殊文件和硬链接，不先检查pathname再跟随打开；内容不承诺原子快照，复制字节/条目/深度限额保持。
- 严格路径政策可能拒绝macOS `/var`、`/tmp`别名或Windows junction源，请选择真实非链接路径；不以不安全跟随作为降级。Windows NTFS/UNC与Unix各平台仍需真实发行验收。
- ZIP先按96MiB压缩输入上限读取不可变快照，再校验实体中央目录条数（≤2000，不按去重后的名称数计）、16MiB中央目录及64KiB单条元数据。eager parser只见已验证元数据与唯一规范footer，不能退回载荷中的另一个footer放大分配；ZIP64条目保留，解压仍逐条流式计64MiB。拒绝重复名称、伪造计数、歧义中央目录结束标记。
- 安装先完整暂存并验证入口和 manifest 一致性，再持久化禁用清权及安全 `.bak`。`plugin/transaction.rs` 将受限 journal 写入 `<config_dir>/plugin-transaction.json` 并同步，路径只能由有效插件 ID 和 UUID 派生。启动在 Worker 前恢复中断事务：最终发布前恢复旧代码和私有数据，发布完成保留新树但不恢复授权；卸载配置提交前恢复备份，提交后清理备份。恢复幂等，非法/链接/含糊状态报错并保留数据。资产写入同步临时文件后单操作替换目标（Windows `MoveFileExW` 写穿透），不再先移走旧 KV 文件。文件系统和设备必须遵守 flush/write-through；准备阶段尚未登记的惰性 staging 残留不含迁移后的私有数据。
- **安全授权恢复屏障**：启停、权限、网页信任及配置恢复的插件状态变更，先原子同步 `plugin-trust-recovery.json`，只有 primary 与 safe backup 都同步成功后才清除。启动发现残留 marker 时在暴露 Worker 前将插件禁用、清空权限和网页信任并安全落盘；marker/schema/读取失败不忽略。这样 primary 后续损坏回退旧 `.bak` 也不会复活撤销前授权；普通配置备份语义不变，插件代码/私有数据不因该屏障被删除。
- 插件 `fs.openDialog` 的唯一入口为 Rust `plugin_pick_files`：验证插件启用及 `fs:open` 授权，由原生文件选择器产生路径，返回原始字节的 base64。无单文件/总量/数量限额；类型 filters 仅提示并追加 All files，不限制读取内容。宿主按请求返回解码文本或 `Uint8Array`。不提供接收任意路径的插件读取命令；`ui.panel.export()` 仍通过另存为写文本。
- `read_plugin_asset`/`write_plugin_asset` 是包资产与私有区的唯一文件入口：读取逐组件拒绝链接/重解析/硬链接与非常规文件，越界报错，仅目标缺失返回 null；`format` 缺省/text 为 UTF-8 替代解码文本，binary 返回 base64（宿主解码为 `Uint8Array`）。写入只接受 `data/` 首段，先逐组件拒绝链接并补齐父目录，再以同目录临时文件同步后单操作替换目标（`plugin::transaction::replace_file` + `sync_dir`）；`content`（含空串）与 `base64`（原始字节，可为零长度）互斥，二者皆缺报错；不设内容大小上限，也不扫描整个 `data/` 配额。

## 宿主命令与状态快照

这是**宿主前端与 Rust 的 IPC 契约**，不是 Worker 可直接调用的 API。宿主调用经 `src/services/plugin.ts`，命令参数采用 camelCase；插件 Worker 只经开发指南中的[API 桥](../plugin-development.md#调用-api-与处理事件)访问能力。

| Rust 命令 | 宿主参数 | 响应与关键语义 |
|---|---|---|
| `list_plugins` | 无 | `PluginListResponse = {revision, pluginConfigs, plugins}`；一致扫描/状态快照，不修改配置 |
| `install_plugin` | `{sourcePath, replaceExisting?, expectedGeneration?}` | `PluginStateSnapshot`；更高版本正常覆盖；同版/降级默认拒绝并返回 `plugin_replace_confirmation_required:` 前缀，`replaceExisting:true` 才会替换。替换保留 `data/`，生成新身份并清除授权/网页信任；安装前先持久化「禁用+清权」状态，后续步骤失败保持 fail-closed、不回滚旧授权 |
| `reload_plugin` | `{id, expectedGeneration}` | `PluginStateSnapshot`；主窗、已启用、manifest 可读才允许；不写配置（revision 不变），取消该插件网络请求并退休原生视图后用同一安装身份/授权/网页信任/数据重新加载已安装代码 |
| `uninstall_plugin` | `{id, expectedGeneration}` | `PluginStateSnapshot`；expectedGeneration 必须匹配当前安装身份（防止升级期间排队的旧请求卸载新代码）；配置提交后删除代码、状态及私有数据，并取消在途 HTTP、退休视图、清除网页站点数据；目录缺失按已卸载处理 |
| `set_plugin_enabled` | `{id, enabled, expectedGeneration}` | `PluginStateSnapshot`；expectedGeneration 必须为用户实际审阅的安装身份，旧身份拒绝；启用需 manifest 可读且声明可信网页时已获 `trustedWebGranted`；禁用提交后取消在途 HTTP 并退休视图 |
| `set_plugin_permissions` | `{id, permissions, expectedGeneration}` | `PluginStateSnapshot`；整体替换为 manifest 已声明且宿主支持的权限子集，可在禁用时授权；撤掉 `http:request` 会取消在途请求，按已提交授权退休被拒视图 |
| `set_plugin_trusted_web` | `{id, trusted, expectedGeneration}` | `PluginStateSnapshot`；仅主窗独立确认后授予，`trusted=true` 要求 manifest 声明可信网页视图；撤销同时禁用并退休视图，普通权限命令不能替代；`.bak` 更新失败时报错但状态已提交 |
| `clear_plugin_web_data` | `{id, expectedGeneration}` | `PluginStateSnapshot`；要求插件禁用，退休视图后等待原生网页数据清理完成（清站点数据，空 profile 可保留，实现见[隔离视图](plugin-views.md)），失败报错 |
| `read_plugin_asset` | `{id, relPath, format?}` | `string \| null`；format 缺省/text 为 UTF-8 替代解码文本，binary 为 base64。仅缺文件返回 null，权限/IO 错误 reject；不设读取大小限制 |
| `write_plugin_asset` | `{id, relPath, content?, base64?}` | 无返回值；`content`（可空）与 `base64`（原始字节）互斥，二者皆缺则报错；仅已授权 `data/` 写入，路径/原子写约束保留，不设内容大小上限 |
| `plugin_http_open` | `{pluginId, expectedGeneration, requestId, request}` | `{requestId, status, headers, url}`；先同步登记 requestId 再连网（全局在途上限 64），请求体 `body`/`bodyBase64` 互斥，`timeout` 为非负有限秒数且是整个请求截止（缺省或 0 = 无截止），`redirect` 缺省 `follow`（≤10 跳）、可选 `manual`/`error` |
| `plugin_http_read` | `{pluginId, expectedGeneration, requestId}` | `{base64, done}`；单次最多 64 KiB 传输块，总量无业务上限；有数据即返回（EOF 可带最后一块），`Pending` 状态明确报错；取消/超时/撤权立即失败，`done` 后移除条目 |
| `plugin_http_cancel` | `{pluginId, expectedGeneration, requestId}` | 幂等；未知 requestId 记录有界（32 条）「先取消后打开」意图，挂起中的 open/read 被打断；归属其他安装代次的 requestId 报错 |
| `plugin_open_external` | `{pluginId, url}` | 无返回值；需要 shell:open，仅 http/https/mailto |
| `create_plugin_view` | `{binding}` | 主 WebView 专用；校验安装/权限/端口及资源后创建独立原生 UI |
| `update_plugin_view` | `{instanceId, rect, occlusions?, visible, layoutRevision}` | 最新 revision 几何、局部遮挡（≤64 矩形，见[隔离视图](plugin-views.md)）及可见性；按主窗 zoom/DPI 转换并裁剪 |
| `send_plugin_view_message` | `{instanceId,message}` | 只准 init/state/environment 有界 JSON，状态快照 256 KiB，不接受源代码 |
| `destroy_plugin_view` | `{instanceId}` | 幂等退休原生路由/控件，迟到消息不能复活 |

旧的单命令 `plugin_http`（`{status, body, truncated}`，带 1 MiB 响应截断与 15 秒超时上限）已移除；响应体现在只能经 `plugin_http_open` + `plugin_http_read` 拉取，取消走 `plugin_http_cancel`。三个命令共享进程级 `PluginHttpRegistry`，`requestId` 由 Worker 在 open 前生成并贯穿整个请求生命周期；`signal` 与 `responseType` 只在 Worker 侧消费，不进入原生 wire（wire 请求字段为 `method`/`url`/`headers`/`body`/`bodyBase64`/`timeout`/`redirect`）。

### HTTP 流式契约

- **状态机与准入**：`plugin_http_open` 在同步准入阶段把 `requestId` 写入注册表（`ReadState::Pending`），因此响应头返回前 `plugin_http_cancel` 就能命中并打断挂起的 send；拿到响应头后转 `Streaming`，`read` 报告 `done` 后转 `Finished` 并移除条目。`Pending` 阶段调用 `read` 明确报错而不是返回空块；重复 `requestId` 或全局在途超过 64 条时 open 直接拒绝（运行时资源保护，不是内容上限）。open 先校验主窗来源、安装代次、启用态、`http:request` 授权与 manifest 声明，再解析 URL、白名单和代理；read 每次调用重校验代次、启用态与授权，cancel 校验代次与请求归属（撤销后取消仍可到达）。
- **读取与取消**：读取是拉取式的，单次最多 `TRANSPORT_CHUNK_BYTES`（64 KiB），有数据即返回，SSE 可逐事件交付；超出传输块的字节原样保留给下一次 read，总量无业务上限，`done:true` 的最后一块仍可携带字节。宿主侧 `pluginHttp` 按插件限制 64 条在途登记与 64 条取消墓碑，`requestId` 在 open 完成前即可取消；取消先于 open 到达时，前端先记墓碑，原生 `PluginHttpRegistry` 再由 `MAX_PRE_CANCELLED`（32 条）有界意图窗口承接，并按 plugin + 安装代次绑定。
- **期限**：`timeout` 是整个请求（打开 + 所有读取）的绝对截止时间，不从每块重置；缺省或 `0` 表示无总截止，负数/非有限值拒绝。read 在服务残余字节之前先检查截止，避免过期请求继续产出。
- **重定向与作用域**：宿主手动逐跳发送，reqwest 自动重定向与 Referer 均关闭；跨源仅保留 Accept/Accept-Language/Content-Language/Content-Type/Content-Encoding/Range，未知自定义头和凭据头不转发，同源合法业务头保留。301/302 仅 POST 改 GET，303 除 GET/HEAD 改 GET，只有实际重写时删除 body 及 representation headers；307/308 保留方法、body 与类型/编码。错误文本剥离 userinfo/query/fragment。`follow` 默认最多 10 跳；`manual` 不跟随、`error` 直接失败；manifest `http.urlWhitelist` 为可选作用域，非空时初始 URL 与每一跳目标都按 `url_glob_match` 校验（`*` 不跨 `/`，`**` 跨段，其余字符字面量，`?` 是查询分隔符）。未显式启用插件代理时走 reqwest 默认（继承系统代理），启用后插件代理优先；响应头名小写、重复头以 ", " 合并，`url` 为最终响应地址。
- **取消传播**：禁用、撤销 `http:request`、撤销网页信任、卸载、重载、替换安装都会取消该插件全部在途请求（随状态提交或 reload/替换操作执行）；配置恢复导入执行整体取消。open 准入后和 read 前后都重校验安装代次、启用态与 `http:request` 授权，撤权后的旧请求立即失败且不交付字节。

`commands/file.rs` 的 `plugin_pick_files({pluginId, options})` 原生选择后复核安装身份和权限，wire 返回 `{files:[{path, base64}]}`。`executeHostApi` 将 binary 转为 `{files:[{path, bytes: Uint8Array}]}`，text 用共享 `lineText.decodeBytes` 返回 content；`fs.read` binary 同样返回 `Uint8Array`。`PluginSession` 在成功回复时转移文件缓冲区，不做 JSON 字节数组展开或再次复制；读取完成后再次核对请求仍存活及授权，旧请求不泄漏结果。`fs.read`/`fs.openDialog` 无 RPC 读取期限。文件读取与可信网页批准无关，完整读取仍受实际内存和运行时字符串/缓冲区能力约束。

`PluginConfigEntry` 包含 `id`、`installGeneration`、`enabled`、`trustedWebGranted`、`grantedPermissions` 和可选 `installedAt` / `source`。`PluginView` 另含校验后的 manifest、可声明/可授予权限和错误信息；manifest 损坏时仍列出错误项。`pluginConfigSnapshot` 按后端 revision 拒绝旧列表与旧变更响应，同步网页批准；安装身份变化丢弃旧 manifest UI 并使旧 KV 缓存失效。会写配置的命令返回保存后的快照（`snapshot()` 在 `config.json` 提交后取 revision）；`reload_plugin`/`clear_plugin_web_data` 不写配置、返回当前快照。`syncStorePluginConfigs` 只接受不小于已接受 revision 与 store 当前 revision 的快照，`syncPluginListSnapshot` 先过同一闸门再替换视图。

## Worker 桥与派发

作者 API、事件载荷、配额和示例已集中至[插件开发指南](../plugin-development.md#api-参考)，这里不维护第二份接口表。

宿主执行链：`PluginSession.handleWorkerRequest` 验证当前安装身份、启用态及调用时权限 → `pluginHostApi.executeHostApi` 校验参数并执行具体能力。RX 数据在有当前读取授权时才转发；`pluginBridge` 收到批次后按订阅快照执行回调，等待返回的 Promise settle 后 ACK。RPC 到期只回收回执槽位，不能把迟到结果交给替换后的 Worker，也不承诺取消已开始的后端副作用。文件读取、私有写入、KV 持久化与 `http.*` 不适用通用 RPC 期限（大文件/长连接/用户选择），取消仍走显式通道。`view.sendBinary` 使用独立 10 分钟传输 RPC 资源期限，并受逐块 30 秒 ACK 和主动闲置回收约束（见[二进制通道](plugin-views.md#视图二进制通道)）。每会话普通 RPC 回执槽位上限 32；`http.cancel` 可绕普通槽使用最多额外 64 个取消槽，既避免取消排在自身请求后，又不允许无限取消洪泛。

**错误分级**：`__plugin_ready` 现在由桥在用户入口脚本同步执行完成后发出；此前的加载/解析/初始化异常是致命启动失败（重试与 10 秒三次熔断保留）。就绪后的未处理拒绝、`worker.onerror` 与显式 `error` 事件只写诊断日志并限流提示，不终止会话、不清空插件内存。真正的原生视图进程故障仍按视图失败处理。显式重载走 `startReady`：在 `__plugin_ready` 之前失败或 10 秒未 ready 会把错误 reject 给调用方并提示，不永久占用管理队列。readiness 的结算绑定启动代次，旧 IO 完成不能结算新启动；ready 后以 30 秒健康探针检测静默终止，连续两次未回应按崩溃回收，而正常异步错误仍只记录诊断。

**纯网页插件**：`PluginManifest.entry` 可省略，仅当存在非空 `trusted-web` + `input:"none"` 视图且无 Worker 按钮/菜单时合法；`ui.views[].worker:false` 允许混合插件中的某个可信页不依附 Worker。宿主对这些视图使用 `workerEpoch=0`，不创建空 Worker、不等待 Worker ACK，Worker 重启不影响它们。

## RX 性能边界
`pluginObserver` 仅通过 `RxPipeline` 的行级多播钩子订阅；协议帧由 `enqueueFrame` 进入同一入口，和普通 TRX RX 行一样只投递一次，回放/TX 不触发此钩子。`pluginBytesObserver` 在 serial:data 层旁路，保留 TTY 字节。无订阅时不建立队列；每端口队列按行数、字节数受限，可见页按 rAF、隐藏页按 timer 递送，并在 visibilitychange 时重排已挂起的 rAF。最后一个字节订阅者注销时取消调度并清空旧端口队列。每个 Worker 的待确认事件数及字节数也有上限；跨 Worker 的字节批次使用精确长度独立 buffer，不能 transfer 与终端缓冲共享的 `rawData.buffer`。

## 验证与发行边界

- Rust 测试：ID/路径与 manifest 上限、ZIP 限额、安装身份与旧操作拒绝、同版/降级替换确认、安装与卸载事务在各 rename 边界的中断恢复、纯网页 manifest 规则、缺失/空/二进制内容区分、原样大文件读取、原子替换、data/ 路径分类与 Windows 别名拒绝、HTTP 取消先于打开且无接收者持续生效、重定向模式与 glob 规范化；`cargo test --lib --manifest-path src-tauri/Cargo.toml`。原生生命周期与网页数据的验收要求见[验证边界](plugin-views.md#验证边界)。
- 前端 Vitest：revision 响应乱序、升级期间权限操作、启用前授权、KV 读失败/损坏数据保全与无配额串行写队列、空内容/二进制 `fs.write`、HTTP 拉取/取消/撤权后重校验、重载陈旧响应与启动失败拒绝、通知配额、RX/字节旁路、UI 注册表与 Worker 初次失败恢复。`npx tsc --noEmit` 与 `npm run test:run`。
- `e2e/plugin.spec.ts` 使用真实 Chromium Worker/RX/终端但模拟 Rust invoke，不能证明原生选择器、真实 ZIP 事务或生产 WebView CSP。最终安装包验收见[发版要求](release.md#插件发版验收门)。
