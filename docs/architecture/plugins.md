# 插件系统

本模块支持安装目录或 ZIP 形式的普通 JS 脚本插件；设置页分别提供“安装目录”和“安装 ZIP”入口，取消任一选择器不启动另一选择器。插件逻辑在主窗 Web Worker 中运行（纯网页插件可以没有 Worker），UI 可用声明式 Sidebar/端口菜单、文本面板或独立隔离 WebView；隔离视图可替换串口内容或创建额外工作区标签。插件市场提供可选的索引、版本检查和用户确认后安装流程，但不提供自动安装或隐式信任；插件 UI 不能访问宿主 DOM。

插件作者从独立的[插件开发指南](../plugin-development.md)开始：manifest、权限、Worker API、示例、调试和打包说明集中在那里。普通用户看[设置 → 插件](../userwiki/设置.md#插件)。本文只维护宿主实现、原生 IPC、授权一致性与磁盘恢复；发行验收要求见 [`release.md`](release.md) 的插件原生验收边界。

独立 UI、串口内容替换及动作创建额外工作区标签的当前实现见[隔离视图与标签契约](plugin-views.md)。Windows raw Wry adapter 已实现；其他平台隔离承载未验收时明确拒绝，不用主窗 iframe 替代。

## 运行与信任边界

- `<config_dir>/plugins/<反向域名 id>/manifest.json` 与 manifest 指定的 `entry` 是插件代码来源；入口为单文件普通脚本，不支持 ESM `import` / `require`。Rust 的 `plugin::PluginManifest::validate` 校验 id、API 主版本、路径及权限声明；启动时宿主读取 manifest，失败即拒绝运行。
- 主窗口 `usePluginHost` 在 `ui.configReady` 后同步插件状态；会话绑定 `installGeneration`，身份变化终止旧 Worker。启动失败计数窗口为 10 秒：窗口内累计三次启动失败后尝试持久化禁用并通知，未达阈值时按 500ms × 当前失败次数等待自动重试；`__plugin_ready` 之后的运行时错误只记诊断，不重启、不计数（分级见 [Worker 桥与派发](#worker-桥与派发)）。设置页刷新可重试未运行会话；若禁用状态保存失败，记录错误而不声称持久化成功。弹窗不加载插件宿主。
- Worker 没有 DOM / `window.__TAURI__`；宿主和插件以 `postMessage` 通讯，宿主在每次 RPC 调用时检查当前安装身份及 `grantedPermissions`。`list_plugins` 在控制面闸门内取得一致的磁盘与配置快照；主窗 `pluginConfigSnapshot` 按后端 `revision` 拒绝迟到的列表和变更响应，防撤权后旧快照复活权限。插件安装与启用是用户信任决策，不是针对恶意主窗口脚本的强沙箱：能在主窗口执行的任意脚本仍可直接调用 Tauri 命令。后端对插件命令另做主窗口来源限制、已启用及权限验证，不把 Worker 中的 `pluginId` 当成不可伪造身份。
- `shell.execute` 是高风险的主窗 Worker→宿主能力，不注入到视图页面。每次调用复核启用态、安装代次和 `shell:execute` 授权；权限用于用户明确授权能力，不额外设置命令专用并发、输出或参数业务配额围栏；宿主通用 RPC 在途限制仍适用。`program`、`args`、`cwd`、环境和 stdin 按操作系统进程语义传递，插件可显式选择 shell 解释器；禁用、撤权、显式重载、卸载或替换会取消并等待直接子进程，但仅 Worker 崩溃或停止时，宿主可能只丢弃 RPC 回执，不保证取消已启动的原生命令；命令可运行至自身结束、调用方 timeout 或后续用户禁用。任何情况下都不承诺终止进程树或撤销已发生的副作用。
- 生产主窗口 CSP 在 [`tauri.conf.json`](../../src-tauri/tauri.conf.json) 中明确设置 `connect-src 'self' ipc: http://ipc.localhost https://ipc.localhost`，并以 `wasm-unsafe-eval` 允许插件 Worker 编译/实例化 WebAssembly。这些新增来源仅为 Tauri 内部 IPC 端点，使 raw custom-protocol fetch 可用；Tauri 2.12 不会自动补齐它们，不能只保留 `'self'` 后依赖 fallback。它们不表示额外开放外网、任意 localhost 或泛 HTTP/HTTPS 访问；Worker 没有 invoke key，不能直接使用宿主通用 native IPC，出站 HTTP 仍只能经 `plugin_http_open/read/cancel` 授权桥（`http:request` 授权；manifest 的 `http.urlWhitelist` 是可选收紧作用域，声明非空时逐跳校验）。默认跟随重定向（≤10 跳）、继承系统代理；用户显式配置的插件代理优先。无隐式 timeout 或响应大小截断，期限由调用方给出（完整语义见 [HTTP 流式契约](#http-流式契约)）。可信原生网页使用浏览器网络，不受 Worker 代理/白名单约束，仍遵守浏览器 CORS/TLS。开发 `devCsp` 保留相同内部 IPC 来源，仅额外允许 `ws://localhost:1420` 用于 Vite HMR，并同步允许 WASM；[`pluginFsCsp.test.ts`](../../src/services/pluginFsCsp.test.ts) 守卫这两组精确连接来源。
- 已安装插件的 manifest 正常时，同 ID 仅接受更高版本覆盖安装；同版/降级拒绝，旧 manifest 损坏可修复安装。安装或升级默认禁用、清除普通授权及网页信任，生成新的 UUID `installGeneration`；可信网页先弹独立确认，普通权限另行授予，取消保留已安装但禁用状态。批准与启用绑定 `expectedGeneration`，升级期间排队的旧操作拒绝。网页批准独立于 `grantedPermissions`，正常重启保持，升级重审；`installedAt` 不参与身份判断。设置页仅在 `install_plugin` 返回同版/降级前缀时弹替换确认，取消不写磁盘；安装后按权威快照中 `installGeneration` 的变化识别新装插件，不按渲染进程的 manifest 列表推断。
- 重载（`reload_plugin`）只重启已安装副本：不重新读取来源目录、不写 `config.json`（revision 不变），保留 `installGeneration`、`grantedPermissions`、`trustedWebGranted` 与 `data/`；要求主窗调用、已启用且磁盘 manifest 仍可校验。后端取消该插件在途 HTTP 并退休原生视图后返回当前快照；前端先停旧 Worker，快照被 revision 判旧即报错，否则严格等待新 Worker 到 `__plugin_ready` 再刷新列表并重建视图；只有快照被接受且新 Worker 就绪后才提示成功，陈旧快照或启动失败只报错。纯网页插件不创建 Worker。
- 设置页允许在插件禁用时逐项授权；权限整体替换按插件在模块级队列执行，启用等待当前授权队列落盘；安装/卸载进行时禁用设置页控制，但最终安全边界仍是后端安装身份检查。
- 安装/卸载在持久化禁用清权或配置提交后即使后续步骤失败，设置页也必须重新读取 `list_plugins` 权威快照；旧 Worker 先退休，快照读取失败时 fail-closed 停止宿主 Worker，不能继续按过期前端授权执行。
- `fs.openDialog`、`fs.openDirectoryDialog`、`fs.saveFile` 与 `ui.panel.export` 受跨 Worker generation 共享的 per-plugin dialog permit 限制；permit 由实际原生 picker/write 任务持有到终止，Worker 退休不会提前归还容量；Rust 预算表使用弱引用并在新准入时回收过期 ID，元数据不随历史插件数永久增长。KV 排队写在 dispatch 和真实写入前复核 RPC authority，旧请求不能影响新 Worker。
- 插件目录权限分开授权：`fs:open-dir` 列目录/读文件/读元数据；推荐的最小 `fs:export-dir` 仅创建/覆盖导出文件并自动创建父目录；兼容保留的 `fs:write-dir` 还允许追加、显式建目录、删除和重命名。目录根只能来自 `plugin_pick_directory` 原生目录选择器（授予任一目录权限即可选择），`grantId` 与插件 ID、`installGeneration` 绑定，展示用 path 不是访问能力。每次操作都重校验启用态、manifest、当前对应权限、安装身份和授权，限制目标为 canonical root + 相对路径，拒绝绝对路径、`..`、链接/重解析点与越界；最小导出不隐式获得读取或破坏性目录操作。授权无 TTL、无数量上限，只存在宿主内存；重启、禁用、全部目录权限撤销、卸载、替换或重载时失效。
- `fs:save` 是独立的任意目录 Save As 最小权限：`fs.saveFile` 每次在原生保存对话框中由用户产生目标，只接受内容与标题/文件名/过滤器提示，不接受插件指定的绝对路径，也不产生可复用目录 grant。`plugin_save_file` 在选择后与写提交前复核身份/授权；取消返回 null，与空内容保存成功不同。`fs.exportFile` / `fs.saveFile` 均接受 UTF-8 文本或完整原始字节，不增加内容业务大小限额、读取权限或隐式 RPC 截止；既有 `fs:write-dir` 与无额外权限的 `ui.panel.export` 保持兼容。
- `serial:control` 独立于 `serial:send`，仅允许通过共享串口 runtime 打开/关闭白名单内端口，不向 Worker 暴露直接 invoke。`pluginHostApi` 与原生 `plugin_serial_open/close` 都复核安装身份、启用态、manifest/当前权限与端口白名单；关闭使用 `expectedConnectionGeneration` CAS，不将排队旧关闭作用到新连接。`ports.list/status` 走原生权威连接摘要（含代次，无额外控制权限），仅显示 `mode` 优先采用已有宿主 UI metadata，不用过期 store 状态/代次覆盖 native；打开不抢占前端焦点或隐式发送；无通用 RPC 控制期限。授权确认分别说明控制风险、白名单目录导出及每次 Save As 的差异。

- legacy all-port RX/bytes observer 也按订阅 `observerStart` 截断队列；撤权后重新订阅只接收订阅之后的数据和丢失通知，不能回放授权缺失期间的字节。

## 插件市场协议与生命周期

插件市场是**不可信的远程元数据来源**，不是插件权限或代码的信任根。新配置默认使用官方 `pluginMarketplaceUrl`，用户可以替换为自己的索引源；宿主按以下协议读取索引，不会自动安装或隐式信任代码，也不会阻止本地目录/ZIP 安装。

### 文档格式与校验

- 索引是 UTF-8 JSON：`{"schemaVersion":1,"plugins":["https://.../plugin.json"]}`。`schemaVersion` 必须为 `1`，`plugins` 最多 256 项，每项是插件描述 JSON 的 URL。索引和描述均不超过 1 MiB；索引/描述顶层未知字段、非法 JSON、未知 schema、空/非法 URL 都拒绝。
- 描述 JSON 是 `{"schemaVersion":1,"manifest":{...},"downloadUrl":"https://...zip","homepage":"https://...","releaseNotes":"..."}`。`homepage` 与 `releaseNotes` 可省略；`manifest` 按本模块相同的 Rust 权威校验（id、版本、apiVersion、entry、权限和 UI 路径）执行，不能用市场元数据绕过插件包校验。`downloadUrl` 和可选 `homepage` 只接受 `http`/`https`，不得包含凭据或 fragment；部署应优先使用 HTTPS，HTTP 仅适合受控的本地/私有镜像。
- 索引中的 URL 只表示可检查的元数据地址；下载 URL 只表示待用户审阅的代码来源。市场响应、描述和归档均按外部输入处理，不执行描述中的脚本，也不因为 URL 可访问就授予权限。

### 命令与生命周期

1. `fetch_plugin_marketplace({sourceUrl})` 获取并校验一个明确的索引来源，返回 `{schemaVersion, plugins}`。前端在来源变更时丢弃旧请求结果；失败时保留现有本地插件状态。
2. `check_plugin_updates({sourceUrl?})` 优先使用当前输入的市场源，缺省时回退到已保存的 `pluginMarketplaceUrl`；读取描述并与当前安装版本按数字 semver 比较，返回包含 `id`、`latestVersion`、`descriptionUrl`、`downloadUrl`、`manifest`、`updateAvailable` 以及已安装时的 `currentVersion`（未安装时省略）和可选发布说明/主页的结果。前端在检查成功前先用 field-only revision CAS 保存当前源；检查只读，不下载、替换或改变权限。
3. 用户选择更新后，前端展示描述中的 id、版本、权限、主页和发布说明，并将 `metadataUrl`、`expectedId`、`expectedVersion`（以及已安装插件的 `expectedGeneration`）原样绑定到确认操作。后端重新获取描述并逐字段校验，拒绝 id/version 不匹配、旧安装代次、非法 URL、无效 manifest 或归档校验失败；不能信任前端此前缓存的 JSON。
4. 确认安装沿用普通插件事务：先完整下载、解压和校验，再提交禁用/清权状态和代码替换。成功后保留插件 `data/`，生成新的 `installGeneration`，清除普通授权与可信网页信任，并记录 `source: "marketplace"` 与归档 `updateUrl`；用户必须重新审阅并授予权限。任何准备或网络失败都不应报告安装成功，事务恢复/配置快照仍按普通安装规则执行。
5. 取消确认、同版/降级拒绝或代次变化只结束本次市场操作，不修改已安装代码；市场检查也不自动升级。重载已安装代码和本地安装仍遵循原有生命周期，不把 `installedAt` 当作身份。

### 自动检查联动与通知

插件市场更新检查已接入软件更新检查生命周期：`useAutoUpdate` 在配置就绪后并行调用 `src/utils/pluginUpdateService.ts` 的 `runPluginAutoCheck`（7 天周期、独立 localStorage 记账），`AboutDialog` 的手动检查并行调用 `runPluginManualCheck`；`updateCheckMode = 'none'` 时两者都不自动检查，DEV 构建不自动检查（手动显式检查可绕过）。后台检查使用已提交的 `pluginMarketplaceUrl`（仅未初始化时回退当前配置值），不读取设置草稿。发现已安装插件的可用更新时，应用经通知中心投递一条粘性 info 通知（`action: 'open-plugin-settings'`，点击通知中心行或右下角提示均可直达“设置 → 插件”）；通知只提示，不自动下载、安装或回写配置，未安装的市场插件不参与提示。插件检查失败静默记录诊断，不影响软件更新结果；设置页的“检查更新”手动入口仍保留。

### 宿主边界

市场请求通过 Rust 网络层发起并沿用 HTTP 代理、重定向和 TLS 边界；不得从 Worker 直接调用 Tauri 命令或把市场 URL 当作插件的 `http.urlWhitelist`。市场权限仅影响安装后插件，不能授予市场服务任何宿主权限。当前市场源地址保存在 `pluginMarketplaceUrl`，市场安装会把归档地址保存为插件的 `updateUrl`；这些地址只用于后续展示/检查，不构成签名或供应链证明。需要发布完整性与供应链保证时，应在部署层提供 HTTPS、签名或可信镜像。

## 磁盘与配置

- `config.json` 使用 `AppConfig.entities.plugin_configs`（`#[serde(flatten)]`，JSON 顶层键 `pluginConfigs`），包含 id、安装身份、启用状态、授予权限、网页信任和安装元数据。插件 KV（`pluginKv`）位于 `plugins/<id>/data/state.json`，不进入 config.json；`storage` 权限仅访问此文件，`fs:storage` 允许读取/写入整个 `data/`，`fs:assets` 允许读取自身代码和资产。KV 只在确认文件不存在时初始化空对象，读缓存按安装代次失效、并发首载共享同一次读盘；`set` 按插件串行、整体序列化后经 `write_plugin_asset` 原子替换；不设键长、值大小、节点数或文件大小上限，但仍只接受可无损 JSON 化的值（拒绝非有限数、访问器、循环引用等），`undefined` 删除键。
- 插件管理响应、排序和调用参数见下方[宿主命令契约](#宿主命令与状态快照)。普通配置保存以 revision CAS 并保留后端权威插件状态；备份恢复只允许同安装身份恢复启用/授权，不匹配的同 ID 插件禁用清权，未提及的当前插件保持原状，备份中的未安装插件不会被安装。导入后读回权威状态，取消设置保留当前插件状态及 revision。配置导出不包含插件代码、私有数据或事务 journal。
- `trustedWebGranted` 默认 false，独立于普通授权；普通保存保留后端权威值，备份导入不能增加或恢复已撤销的网页信任。浏览器数据在 `<config_dir>/plugin-web-data/<id>/<installGeneration>/`，目录入口统一校验 UUID，不在插件可读写 `data/`；同代次重载/禁用不删，新安装代次不复用旧站点数据。清除/卸载经原生 profile API 清空当前代次站点数据，失败如实返回且可重试，空 profile 文件可保留；崩溃遗留的旧代次不向新代码暴露。该目录不包含在配置导出中。
- Rust 的 manifest、路径及安装包额度校验是权威执行点；私有数据读写不按扩展名、内容、文件总大小、总量或整个 data/ 配额拒绝。`AppState.plugin_io` 仍串行化 `list_plugins`、市场索引/描述读取、安装/卸载/重载、启用/授权/网页信任变更、网页数据清理与配置恢复等控制面事务，但不再覆盖资产数据读取、编码或大块临时文件写入的整个阶段。资产 IO 与新范围/分页读取通过独立公平调度器准入；兼容资产读取以短闸门取得准入快照，句柄打开也在闸门外；写侧提交前仍通过短闸门复核身份，新范围/分页不持全局闸门，而依赖 session 失效信号与打开前后/交付前的 authority 复核；详见[文件 IO、raw 传输与会话](#文件-ioraw-传输与会话)。闸门等待仍最多 5 秒，繁忙可重试，不给已开始的文件 IO、用户对话框或 HTTP 添加隐式业务期限（例外：原生视图退休 15 秒、可信网页数据清理 30 秒——两者都在 UI 线程同步析构 WebView2，无上限会让整窗冻结）。普通 revision-CAS `set_config` 不排在插件 IO 后面，备份恢复仍先取得闸门，保持安装/授权事务锁序。HTTP/资产授权使用轻量 manifest 校验，视图只在锁外读取选中资源快照；安装/启用/完整重载仍保留完整包校验。只有目标确实不存在才返回 null，权限/IO 错误不伪装成缺文件。
- 目录源按已打开句柄逐组件限定：Unix使用目录句柄相对`openat`与`O_NOFOLLOW/O_NONBLOCK`，Windows使用`NtCreateFile.RootDirectory`单组件相对打开并拒绝重解析，保留所选root/递归目录句柄且检查最终路径/链接数；共享祖先不长期锁定，不阻断别的临时目录操作。拒绝源根/祖先链接、特殊文件和硬链接，不先检查pathname再跟随打开；内容不承诺原子快照，复制字节/条目/深度限额保持。
- 严格路径政策可能拒绝macOS `/var`、`/tmp`别名或Windows junction源，请选择真实非链接路径；不以不安全跟随作为降级。Windows NTFS/UNC与Unix各平台仍需真实发行验收。
- ZIP先按96MiB压缩输入上限读取不可变快照，再校验实体中央目录条数（≤2000，不按去重后的名称数计）、16MiB中央目录及64KiB单条元数据。eager parser只见已验证元数据与唯一规范footer，不能退回载荷中的另一个footer放大分配；ZIP64条目保留，解压仍逐条流式计64MiB。拒绝重复名称、伪造计数、歧义中央目录结束标记。
- 安装先完整暂存并验证入口和 manifest 一致性，再持久化禁用清权及安全 `.bak`。`plugin/transaction.rs` 将受限 journal 写入 `<config_dir>/plugin-transaction.json` 并同步，路径只能由有效插件 ID 和 UUID 派生。启动在 Worker 前恢复中断事务：最终发布前恢复旧代码和私有数据，发布完成保留新树但不恢复授权；卸载配置提交前恢复备份，提交后把备份**原子改名**为 `.trash-<uuid>`，不在启动或配置锁内做递归删除。恢复幂等，非法/链接/含糊状态报错并保留数据。递归删除只在窗口/托盘创建完成后由后台 sweep 执行：sweep 的选择阶段与插件 IO 闸门串行、删除阶段不占闸门，journal 存在时不触碰任何树，单棵删除失败只记日志不中止；`.backup-*` 仅在其插件已不在配置中、或普通非链接活目录仍存在时才回收，链接不能证明备份已有替代；`.staging-*` 若含 `data/`（升级 `private-data`→`publish` 窗口内私有数据的唯一副本）永不回收，即使没有 journal 也保留原名，不先改为可清理的 `.trash-*`。启动期恢复失败**不再中止启动**：先 arm `plugin-trust-recovery.json`，把 journal 隔离为 `plugin-transaction.json.corrupt-<uuid>`，所有插件按 fail-closed 禁用并清空授权/网页信任后继续启动；持久化失败时保留 journal 与 marker 以便下次重试，仍不阻塞启动。资产写入同步临时文件后单操作替换目标（Windows `MoveFileExW` 写穿透），不再先移走旧 KV 文件。文件系统和设备必须遵守 flush/write-through；准备阶段尚未登记的惰性 staging 残留不含迁移后的私有数据。
- **安全授权恢复屏障**：启停、权限、网页信任及配置恢复的插件状态变更，先原子同步 `plugin-trust-recovery.json`，只有 primary 与 safe backup 都同步成功后才清除。启动发现残留 marker 时在暴露 Worker 前将插件禁用、清空权限和网页信任并安全落盘；marker/schema/读取失败不忽略。这样 primary 后续损坏回退旧 `.bak` 也不会复活撤销前授权；普通配置备份语义不变，插件代码/私有数据不因该屏障被删除。
- 插件 `fs.openDialog` 的唯一入口为 Rust `plugin_pick_files`：验证插件启用及 `fs:open` 授权，由原生文件选择器产生路径，返回原始字节的 base64。无单文件/总量/数量限额；类型 filters 仅提示并追加 All files，不限制读取内容。宿主按请求返回解码文本或 `Uint8Array`。不提供接收任意路径的插件读取命令；`ui.panel.export()` 仍通过另存为写文本。
- 插件 `fs.openDirectoryDialog` 的唯一入口为 Rust `plugin_pick_directory`：授予 `fs:open-dir`、`fs:export-dir` 或 `fs:write-dir` 即可选择，原生目录选择器返回路径后先拒绝根及其祖先中的链接/重解析点，再产生 canonical root 并创建内存 grant，返回 `{grantId, name, path}`（支持 `multiple` 多选）；`path` 只用于展示，后续只能通过 grant 的相对路径触达该根。每次调用都重跑同一套启用/权限/manifest/安装代次校验，并在 `spawn_blocking` 中枚举、读取或修改。读侧：list（可递归、无深度上限）、read file、stat；写侧：旧 fs:write-dir 的 write file（overwrite/append，可自动建父目录）、create dir、remove、rename；最小 fs:export-dir 单独走 plugin_export_file，仅相对路径原子覆盖导出并创建父目录。所有写操作只允许在 canonical root 内，拒绝链接/重解析点和越界；`plugin_release_directory` 幂等释放，插件状态变化时自然失效。
- 旧 `read_plugin_asset`/`write_plugin_asset` 全文件接口保留，新增 `read_plugin_asset_raw` 加速旧 binary 读取，并由 `plugin_fs_read_ranges` 提供有界窗口；普通插件的范围读取不继承宿主 bootstrap/KV 私有读取例外。读取仍拒绝链接/重解析/硬链接与非常规文件、越界报错；旧文本返回 UTF-8 替代解码文本，旧 JSON wire 的 binary 仍为 base64，raw wire 直接返回字节。写入只接受 `data/` 首段，`content`（含空串）与 `base64`（原始字节，可为零长度）互斥；`PreparedAssetWrite` 在同目录暂存、锁外写入并同步，重新取得短闸门复核安装身份/权限/目标后才执行 `plugin::transaction::replace_file` 与 `sync_dir`。同插件写入经 `asset_write_queue` 串行，安装/授权生命周期继续由控制面闸门串行，不设内容大小上限，也不扫描整个 `data/` 配额。

## 宿主命令与状态快照

这是**宿主前端与 Rust 的 IPC 契约**，不是 Worker 可直接调用的 API。管理命令经 [`plugin.ts`](../../src/services/plugin.ts)，新文件会话/窗口/分页经 [`pluginFs.ts`](../../src/services/pluginFs.ts)，命令参数采用 camelCase；插件 Worker 只经开发指南中的[API 桥](../plugin-development.md#调用-api-与处理事件)访问能力。

| Rust 命令 | 宿主参数 | 响应与关键语义 |
|---|---|---|
| `list_plugins` | 无 | `PluginListResponse = {revision, pluginConfigs, plugins}`；一致扫描/状态快照，不修改配置 |
| `fetch_plugin_marketplace` | `{sourceUrl}` | `MarketplaceIndex = {schemaVersion, plugins}`；校验 schema、URL 和最多 256 个描述地址；只读，不改变插件状态 |
| `check_plugin_updates` | `{sourceUrl?}` | `MarketplaceUpdate[]`；优先检查当前草稿 sourceUrl，缺省时使用已保存的 `pluginMarketplaceUrl`，按数字 semver 填充 `currentVersion`/`updateAvailable`；只读，不自动下载或安装 |
| `install_marketplace_plugin` | `{metadataUrl, expectedId, expectedVersion, expectedGeneration?}` | `PluginStateSnapshot`；重新获取并校验描述与归档，绑定用户审阅的 id/version/代次；成功后记录来源、换新安装代次并清权，保留 `data/` |
| `install_plugin` | `{sourcePath, replaceExisting?, expectedGeneration?}` | `PluginStateSnapshot`；更高版本正常覆盖；同版/降级默认拒绝并返回 `plugin_replace_confirmation_required:` 前缀，`replaceExisting:true` 才会替换。替换保留 `data/`，生成新身份并清除授权/网页信任；安装前先持久化「禁用+清权」状态，后续步骤失败保持 fail-closed、不回滚旧授权 |
| `reload_plugin` | `{id, expectedGeneration}` | `PluginStateSnapshot`；主窗、已启用、manifest 可读才允许；不写配置（revision 不变），取消该插件网络请求并退休原生视图后用同一安装身份/授权/网页信任/数据重新加载已安装代码 |
| `uninstall_plugin` | `{id, expectedGeneration}` | `PluginStateSnapshot`；expectedGeneration 必须匹配当前安装身份（防止升级期间排队的旧请求卸载新代码）；配置提交后删除代码、状态及私有数据，并取消在途 HTTP、退休视图、清除网页站点数据；目录缺失按已卸载处理。视图退休与清网页数据在 UI 线程执行且有 15/30 秒上限，失败只记日志（配置已提交即视为卸载成功），递归删除交给后台 sweep，不阻塞命令 |
| `set_plugin_enabled` | `{id, enabled, expectedGeneration}` | `PluginStateSnapshot`；expectedGeneration 必须为用户实际审阅的安装身份，旧身份拒绝；启用在配置锁外复用完整 manifest/声明视图资源校验，随后在锁内复核安装代次；声明可信网页时还须已获 `trustedWebGranted`；禁用提交后取消在途 HTTP、退休视图并释放该插件的目录授权 |
| `set_plugin_permissions` | `{id, permissions, expectedGeneration}` | `PluginStateSnapshot`；整体替换为 manifest 已声明且宿主支持的权限子集，可在禁用时授权；撤掉 `http:request` 会取消在途请求，目录权限全部撤掉时释放该插件的目录授权，按已提交授权退休被拒视图 |
| `set_plugin_trusted_web` | `{id, trusted, expectedGeneration}` | `PluginStateSnapshot`；仅主窗独立确认后授予，`trusted=true` 要求 manifest 声明可信网页视图；撤销同时禁用并退休视图，普通权限命令不能替代；`.bak` 更新失败时报错但状态已提交 |
| `clear_plugin_web_data` | `{id, expectedGeneration}` | `PluginStateSnapshot`；要求插件禁用，退休视图后等待原生网页数据清理完成（清站点数据，空 profile 可保留，实现见[隔离视图](plugin-views.md)），失败报错 |
| `read_plugin_asset` | `{id, relPath, format?}` | 兼容保留 `string \| null`；format 缺省/text 为 UTF-8 替代解码文本，binary 为 base64。仅缺文件返回 null，权限/IO 错误 reject；不设读取大小限制 |
| `read_plugin_asset_raw` | `{id, relPath, expectedGeneration?}` | 原始字节 `Response`，加速旧 binary 读取；仅 custom-protocol，缺文件为 `PLUGIN_FILE_NOT_FOUND`，宿主映射旧缺失语义；明确 raw unsupported 才可回退旧命令 |
| `write_plugin_asset` | `{id, relPath, content?, base64?}` | 无返回值；`content`（可空）与 `base64`（原始字节）互斥，二者皆缺则报错；仅已授权 `data/` 写入，路径/原子写约束保留，不设内容大小上限 |
| `plugin_serial_list` | `{pluginId, expectedGeneration}` | 原生权威端口摘要数组，含 connectionGeneration；只要求主窗、启用态和安装身份，无额外 serial:control |
| `plugin_serial_status` | `{pluginId, expectedGeneration, portId}` | 单端口原生摘要或 null；初始未连接代次为 0，已关闭保留历史成功代次 |
| `plugin_serial_open` | `{pluginId, expectedGeneration, portId, params?}` | `{port,result:'opened'\|'already-open',connectionGeneration}`；serial:control + 白名单，params 使用 camelCase 子字段，已连接不重开或修改参数 |
| `plugin_serial_close` | `{pluginId, expectedGeneration, portId, expectedConnectionGeneration}` | `{port,result:'closed'\|'already-closed'}`；serial:control + 白名单 + 原生连接代次 CAS；旧代次不能关闭新会话 |
| `plugin_export_file` | `{pluginId, grantId, relPath, content?, base64?}` | `{path,bytesWritten}`；fs:export-dir，仅所选 grant 根 + 相对文件名，UTF-8 文本/字节互斥，按需建父目录并原子覆盖，无 append/remove/rename/read |
| `plugin_save_file` | `{pluginId, content?, base64?, options}` | `{path,bytesWritten}` 或 null；fs:save，每次原生 Save As，options 仅标题/文件名/过滤器提示，不接受目标路径，取消不写入 |
| `plugin_pick_directory` | `{pluginId, options}` | `PluginPickedDirectory[]`；options 为 `{title?, multiple?}`。主窗原生目录选择器，校验目录权限与安装代次，canonicalize 后创建 grant；无 TTL、无数量上限 |
| `plugin_list_directory` | `{pluginId, grantId, relPath?, recursive?}` | `Array<{name, rel, kind, size, modifiedMs}>`；默认只列一层，`recursive:true` 返回整棵树且不设深度上限；每次调用重校验权限/代次/grant；链接和特殊文件为 `other` |
| `plugin_read_directory_file` | `{pluginId, grantId, relPath}` | 兼容保留 `{path, base64}`；路径必须解析到 canonical grant root 内；链接/重解析点拒绝；无内容大小上限，一次性读取 |
| `plugin_read_directory_file_raw` | `{pluginId, grantId, relPath}` | HCFD 原始 frame，`{path}` 仅为展示元数据（≤128 KiB），文件字节直接拼接；旧 text/binary 读取的快速路径，只有明确 raw unsupported 才回退旧 wire |
| `plugin_stat_directory_entry` | `{pluginId, grantId, relPath}` | `{name, rel, kind, size, modifiedMs}`；只读元数据，不读取文件内容 |
| `plugin_write_directory_file` | `{pluginId, grantId, relPath, content?, base64?, mode?, createParents?}` | `{path, bytesWritten}`；content（可空 UTF-8）与 base64（原始字节）互斥；mode 为 overwrite（默认，原子替换）/append；createParents 默认 true；无内容大小上限 |
| `plugin_create_directory` | `{pluginId, grantId, relPath, recursive?}` | 无返回值；recursive 默认 true；逐组件拒绝链接/重解析点 |
| `plugin_remove_directory_entry` | `{pluginId, grantId, relPath, recursive?}` | 无返回值；recursive 默认 false；非递归删除非空目录会失败；不能删除授权根 |
| `plugin_rename_directory_entry` | `{pluginId, grantId, fromRel, toRel}` | 无返回值；源必须存在，目标父目录必须存在，目标不能已存在；源/目标都必须在 grant root 内 |
| `plugin_release_directory` | `{pluginId, grantId}` | 无返回值；幂等释放，仅释放属于该 plugin 的 grant；不需要目录权限（清理入口仍要求主窗） |
| `plugin_fs_open_session` | `{pluginId, expectedGeneration}` | 返回 UUID sessionId，绑定当前安装身份；同插件新 session 使旧 session 退休，宿主按 Worker epoch 懒创建 |
| `plugin_fs_close_session` | `{pluginId, sessionId}` | 幂等关闭会话，取消其请求并清理游标；不把旧 session 交给新 Worker |
| `plugin_fs_cancel` | `{pluginId, sessionId, requestId}` | 幂等取消，支持有界 cancel-before-request 意图；取消不提前释放仍在实际 IO 中的 permit |
| `plugin_fs_release` | `{pluginId, sessionId, requestId}` | 宿主交付/放弃 raw 结果后的幂等释放回执；归还已完成结果持有的字节 lease，不等 Worker ACK，也不是插件清空 JS 内存的证明 |
| `plugin_fs_read_ranges` | `{pluginId, expectedGeneration, sessionId, requestId, ranges, priority?}` | 原始 HCFR frame；ranges 为 `{rel, offset, length, grantId?}[]`，1..64 项、单项 ≤4 MiB、申请长度和 ≤8 MiB；默认 background；整批先鉴权，单项缺失/IO 可恢复，取消/会话/权限错误整批拒绝 |
| `plugin_fs_list_directory_page` | `{pluginId, expectedGeneration, sessionId, requestId, grantId, relPath?, recursive?, cursor?, limit?, priority?}` | JSON `{entries, nextCursor}`；limit 默认 256、1..1000，另有 1 MiB 元数据估算软预算、128 层目录栈；真增量枚举、不排序、非快照，opaque cursor 绑定会话/grant/目录条件，闲置 60 秒失效 |
| `plugin_http_open` | `{pluginId, expectedGeneration, requestId, request}` | `{requestId, status, headers, url}`；先同步登记 requestId 再连网（全局在途上限 64），请求体 `body`/`bodyBase64` 互斥，`timeout` 为非负有限秒数且是整个请求截止（缺省或 0 = 无截止），`redirect` 缺省 `follow`（≤10 跳）、可选 `manual`/`error` |
| `plugin_http_read` | `{pluginId, expectedGeneration, requestId}` | `{base64, done}`；单次最多 64 KiB 传输块，总量无业务上限；有数据即返回（EOF 可带最后一块），`Pending` 状态明确报错；取消/超时/撤权立即失败，`done` 后移除条目 |
| `plugin_http_cancel` | `{pluginId, expectedGeneration, requestId}` | 幂等；未知 requestId 记录有界（32 条）「先取消后打开」意图，挂起中的 open/read 被打断；归属其他安装代次的 requestId 报错 |
| `plugin_open_external` | `{pluginId, url}` | 无返回值；需要 shell:open，仅 http/https/mailto |
| `plugin_shell_execute` | `{pluginId, expectedGeneration, request: {program, args?, cwd?, env?, stdin?, timeoutMs?}}` | `{exitCode, stdout, stderr}`；需要 shell:execute；按 OS 进程语义执行，直接子进程生命周期由插件能力层管理；不额外设置命令专用并发/输出/参数业务配额（宿主通用 RPC/OS/内存限制仍适用） |
| `create_plugin_view` | `{binding}` | 主 WebView 专用；校验安装/权限/端口及资源后创建独立原生 UI |
| `update_plugin_view` | `{instanceId, rect, occlusions?, visible, layoutRevision}` | 最新 revision 几何、局部遮挡（≤64 矩形，见[隔离视图](plugin-views.md)）及可见性；按主窗 zoom/DPI 转换并裁剪 |
| `send_plugin_view_message` | `{instanceId,message}` | 只准 init/state/environment 有界 JSON，状态快照 256 KiB，不接受源代码 |
| `destroy_plugin_view` | `{instanceId}` | 幂等退休原生路由/控件，迟到消息不能复活 |

HTTP 只经 `plugin_http_open`、`plugin_http_read` 和 `plugin_http_cancel` 三个命令；三者共享进程级 `PluginHttpRegistry`，`requestId` 由 Worker 在 open 前生成并贯穿请求生命周期。`signal` 与 `responseType` 只在 Worker 侧消费；原生 wire 字段为 `method`、`url`、`headers`、`body`、`bodyBase64`、`timeout` 和 `redirect`。

### 文件 IO、raw 传输与会话

文件数据面和生命周期控制面分离，入口分别是 [`plugin_fs.rs`](../../src-tauri/src/commands/plugin_fs.rs)、[`io_scheduler.rs`](../../src-tauri/src/plugin/io_scheduler.rs) 与兼容 [`plugin.rs`](../../src-tauri/src/commands/plugin.rs)；公开 Worker 参数见[开发指南](../plugin-development.md#范围读取批量与目录分页)，不把这些原生 session/request 命令暴露给插件直接 invoke。

#### raw frame 与兼容路径

- `plugin_fs_read_ranges` 仅通过 Tauri custom-protocol 返回 `tauri::ipc::Response` 原始字节。`require_raw_transport` 在打开文件前检查 Tauri 自动添加的 `origin`、`tauri-invoke-key` 请求头，缺失返回 `PLUGIN_FS_RAW_UNSUPPORTED`，使不带这些自动头的 postMessage fallback 无法读取并再通过脚本回传大数据；宿主 service 不手动伪造这些头。这是传输路径选择，不是针对恶意主窗口脚本的额外身份认证。
- frame 是 ASCII `HCFR` + little-endian u32 元数据字节数 + UTF-8 JSON `{results:[{rel,offset,length,error?}]}` + 拼接 payload。frame 中 `offset` 是 payload 内位置，不是文件偏移；错误项 length 为 0，结果顺序与请求一致，metadata ≤512 KiB。文件字节不经 base64、JSON 数字数组或 eval；控制面请求、目录页与 frame 描述用小 JSON 是允许的。
- [`pluginFs.ts`](../../src/services/pluginFs.ts) 的 `decodePluginFsFrame` 仅接受 ArrayBuffer，并校验 magic、元数据、结果数/rel、连续偏移、长度与完整 payload 覆盖；剥离 header/metadata 后才交付字节。单窗口不暴露其他文件/描述区，批量各项可共享本批 payload buffer，`pluginFsTransferables` 去重 transfer list。原生组帧、剥离 payload 及运行时传输可能复制，不能称端到端零拷贝。
- 旧 `fs.read`、`fs.openDialog`、`fs.readDirectoryFile` 和写接口保持参数、返回类型、无业务文件总大小上限及无隐式读取期限。资产 binary 经 `pluginService.readPluginAssetBytes` 优先调用 `read_plugin_asset_raw`；目录 text/binary 经 [`file.ts`](../../src/services/file.ts) 的 `fileService.readPluginDirectoryBytes` 优先调用 `plugin_read_directory_file_raw`，text 再按指定 encoding 解码。目录 frame 是 ASCII `HCFD` + little-endian u32 元数据长度 + UTF-8 JSON `{path}`（≤128 KiB）+ 文件原始字节；[`pluginBinary.ts`](../../src/services/pluginBinary.ts) 的 `decodeLegacyDirectoryFrame` 校验并剥离元数据，展示路径不成为下一次读取权限。两条兼容路径都只有明确 `PLUGIN_FS_RAW_UNSUPPORTED` 才回退旧 base64 wire，权限/IO/非法 raw 响应不得以兼容为由重试旧通道。旧 `read_plugin_asset` 和 `plugin_read_directory_file` 命令本身仍保留 text/base64 契约。`fs.openDialog` 仍用原有选择器 wire，视图二进制 `view.sendBinary` 也不因此改成 raw，继续遵守自己的分块、ACK 和预算契约。

#### 会话、取消与资源所有权

- [`pluginFs.ts`](../../src/utils/pluginFs.ts) 的 `PluginFsContext` 随根 `PluginSession` 的 plugin ID + installGeneration + Worker epoch 建立，native session 懒打开，旧插件不调用新 API 就不多一次启动 IPC。`stop()` 先 mark dead 再 cancel/close，迟到的 open 自行关闭。后端 `PluginFsRegistry` 将 UUID session 与插件/安装代次绑定，新的同插件 session 退休旧 session；同安装代次重载也不能复用旧 session。session invalid 本次失败，下次新请求才可懒重开，不自动重放旧范围或旧 cursor。
- Worker bridge 在发送前生成 requestId，保留 signal 在 Worker 内并从 wire 移除；abort 先让 Promise 以 AbortError 失败，再经 `fs.cancel` 独立取消。host 新 FS lane 最多 8 个请求，不占普通 32 槽；`fs.cancel` 与 `http.cancel` 共享额外 64 个有界取消槽。native cancel-before-request 意图窗口有界，close/release 幂等。新 FS API 没有隐式总 RPC 截止。
- 每次准入、排队后以及读取前后复核安装代次、启用态、manifest 声明、当前权限、session 与目录 grant；先鉴权整个批次，再读取各项。目录范围需要 `fs:open-dir`，资产和 data/ 分别需要 `fs:assets` / `fs:storage`，不放宽宿主 bootstrap 或 KV 读取特例。禁用、撤权、重载、卸载、替换及配置恢复使相关 session 失效；宿主发 Worker 回执前再查当前 authority，迟到结果只丢弃。
- 阻塞读取持有真实 `IoPermit`，取消等待者、Worker 退休或发出 release 都不能提前释放仍在运行的 IO 容量。真实读取结束后 `finish_io` 只归还并发，成功范围/分页响应的 reservation 继续由 request entry 持有；`attachPluginFsLease` / `releasePluginFsResultWithRetry` 让 host 在 Worker postMessage 成功、transfer 失败或放弃结果后的 finally 中发 `plugin_fs_release`，清理仅有一次有界重试，不重试文件操作本身。这是宿主交付后的资源确认，没有新增 Worker 字节 ACK 协议，不等待 Worker ACK 或插件消费完 Uint8Array，也不计量插件后续自行保留的副本。cancel 不代表已完成结果的 release；成功分页的 release 只清理请求 lease，不删除后续可继续使用的 cursor；原生分页请求在成功返回前失败/取消时，`Admission` 退休对应游标，不能自动用旧 cursor 重试。registry 只有一个每 5 秒巡检的 reaper，回收完成至少 60 秒但尚未 release 的结果与闲置达到 60 秒的 cursor；不会按 60 秒截断仍运行的文件 IO。EOF 立即删游标，显式 release 立即清理已完成请求。

#### 公平调度、路径与分页

`IoScheduler` 使用短 mutex 保护计数/队列，锁不跨 await；watch 显式取消，等待 future drop 也清理队列。默认实际 IO 并发全局 4、每插件 2、每会话 2，background 全局最多 3、为交互保留 1 槽；在途受控字节预留全局 64 MiB、每插件 32 MiB；后台全局/每插件/每会话令牌桶各为 8 MiB/s、8 MiB 突发，排队上限 64，交互权重 3、aging 250ms 防后台饥饿，按 owner（plugin + session）公平轮转。`acquire_with_cost` 将保留到 release 的 `memory_bytes` 与后台令牌的 `io_cost` 分离，兼容 `acquire` 仍令两者相同：范围批次预留 `2 × 申请字节数 + 512 KiB`，带宽成本为 `max(申请字节数, ranges.length × 4096)`，零长度窗口也包含有界元数据/句柄工作成本；目录页预留 2 MiB，带宽成本 1 MiB。它们是运行时估算与调度成本，不是实际文件内容配额或总内存硬保证。插件预算跨 session 聚合；`cleanup_token_buckets` 先按当前时间补充令牌，仅在没有后台活动/排队任务、没有保留字节 lease，且桶已补满（或关闭该级限速）时回收插件/会话桶。闲置但未补满的桶仍保留 token 债务，`session_bytes` 记录交付前 lease，串行请求或重开 session 不能重置插件总账。priority 是调度提示，不能通过新 Worker 或多个请求绕过每插件总账。兼容资产读写及目录 raw 全文件路径以零字节 reservation 共享并发准入，不增加文件大小上限；未把 `plugin_pick_files` 或目录旧 JSON fallback 重写为新范围协议。调度与 RX/control 的 eventBytes 独立；**这些 soft IO budgets 只控制宿主负责的 IO/交付资源，不是整个插件、JS 堆、WebView 或 OS 总内存限额；没有新增独立插件进程或硬堆配额。**

[`fs_access.rs`](../../src-tauri/src/plugin/fs_access.rs) 的 `open_regular_file`（包内资产/私有文件）与 `open_directory_range_file`（目录授权范围）逐组件从钉住的根目录句柄打开；包内路径保持严格 package 规则，目录路径共用 `sanitize_directory_rel`，保留目录大小写及 Unix 合法的 `~`、`:`、尾点/尾空格名称，不把它们当包别名拒绝。`read_open_range` 对已打开普通文件 seek 后有界读取，不做整文件读取后切片；零长度、offset ≥ EOF 和 EOF 短读都是成功。Unix 使用 `openat` / `O_NOFOLLOW` 并从 `fdopendir` / `fstatat` 枚举/检查，Windows 使用 `NtCreateFile.RootDirectory` 相对打开与 `NtQueryDirectoryFile` 枚举。新范围路径拒绝绝对路径、`..`、链接/重解析点、硬链接及非常规文件，根的祖先也不能通过链接重定向；不把用户展示用的 path 当授权，内容不承诺快照。旧目录 raw 命令单独使用 `open_legacy_directory_file`，复用同一逐组件句柄策略，但允许最终普通文件是硬链接，以保留旧 `fs.readDirectoryFile` 行为；链接/重解析点与特殊文件仍拒绝，资产 legacy 读取及新范围的硬链接拒绝边界不变。

`DirectoryCursor` 的 frame 保留 `anchor` + `DirectoryStream`，跨页不重新按 pathname 打开目录；目录/祖先替换不能把后续枚举重定向到另一棵树。它按页增量产出，不先收整棵树、不做全树排序。每页除了 limit 还有 1 MiB 元数据**估算**软预算，按每条 `(name 与 rel 的 UTF-8 字节之和) × 6 + 160` 累加；下一条跨预算时连同已打开子目录句柄放入 `pending`，下一页继续，不丢条目。递归栈最多 128 层、条目 rel 最多 4096 UTF-8 字节；超过边界或名称不是合法文本会明确报错，不静默裁剪。链接/重解析点、特殊文件与硬链接文件的 page kind 为 `other`，不向下遍历；普通条目沿用 `{name, rel, kind, size, modifiedMs}`，size/modifiedMs 超过 JS 安全整数时返回 `PLUGIN_FS_ENTRY_UNSAFE_INTEGER` 而非截断。registry 全局最多保留 128 个请求、64 个游标，cancel-before-request 窗口最多 64 条。

cursor 绑定 plugin/session/grant 及规范化 rel/recursive；后续可省略 rel/recursive 沿用记录值，显式传入则必须相同。cursor 闲置达到 60 秒失效、会话退休清理，不是可持久化或跨重载恢复的目录快照。旧 `plugin_list_directory` 仍完整收集并排序，不新增分页的元数据/128 层限制；目录 grant 本身继续无 TTL，不要混淆 grant 与 cursor 的寿命。

兼容资产读取由 `read_asset_payload` / `asset_read_authority` 在短 gate 内取得准入快照，随后在 gate 外通过 `blocking_open` 调用 `open_authorized_asset`；permit 随实际阻塞打开任务持有，不随被取消的 awaiter 提前释放。句柄打开后、读取前后仍复核 authority；实际读取按 64 KiB 协作检查 `legacy_file_authority`，打开、读取和编码均不占全局 gate。`write_plugin_asset` 先取得同插件 `asset_write_queue`，短 gate 新建 `PreparedAssetWrite`，在 gate 外 `write_cancellable` 写临时文件并 fsync，再取得短 gate 复核 generation、权限、authority 与目标，最后原子替换；失效请求不能提交到新安装。生命周期/安装事务仍由 `plugin_io` 串行，不把全局 gate 拆除当作弱化身份检查。

### HTTP 流式契约

- **状态机与准入**：`plugin_http_open` 在同步准入阶段把 `requestId` 写入注册表（`ReadState::Pending`），因此响应头返回前 `plugin_http_cancel` 就能命中并打断挂起的 send；拿到响应头后转 `Streaming`，`read` 报告 `done` 后转 `Finished` 并移除条目。`Pending` 阶段调用 `read` 明确报错而不是返回空块；重复 `requestId` 或全局在途超过 64 条时 open 直接拒绝（运行时资源保护，不是内容上限）。open 先校验主窗来源、安装代次、启用态、`http:request` 授权与 manifest 声明，再解析 URL、白名单和代理；read 每次调用重校验代次、启用态与授权，cancel 校验代次与请求归属（撤销后取消仍可到达）。
- **读取与取消**：读取是拉取式的，单次最多 `TRANSPORT_CHUNK_BYTES`（64 KiB），有数据即返回，SSE 可逐事件交付；超出传输块的字节原样保留给下一次 read，总量无业务上限，`done:true` 的最后一块仍可携带字节。宿主侧 `pluginHttp` 按插件限制 64 条在途登记与 64 条取消墓碑，`requestId` 在 open 完成前即可取消；取消先于 open 到达时，前端先记墓碑，原生 `PluginHttpRegistry` 再由 `MAX_PRE_CANCELLED`（32 条）有界意图窗口承接，并按 plugin + 安装代次绑定。
- **期限**：`timeout` 是整个请求（打开 + 所有读取）的绝对截止时间，不从每块重置；缺省或 `0` 表示无总截止，负数/非有限值拒绝。read 在服务残余字节之前先检查截止，避免过期请求继续产出。
- **重定向与作用域**：宿主手动逐跳发送，reqwest 自动重定向与 Referer 均关闭；跨源仅保留 Accept/Accept-Language/Content-Language/Content-Type/Content-Encoding/Range，未知自定义头和凭据头不转发，同源合法业务头保留。301/302 仅 POST 改 GET，303 除 GET/HEAD 改 GET，只有实际重写时删除 body 及 representation headers；307/308 保留方法、body 与类型/编码。错误文本剥离 userinfo/query/fragment。`follow` 默认最多 10 跳；`manual` 不跟随、`error` 直接失败；manifest `http.urlWhitelist` 为可选作用域，非空时初始 URL 与每一跳目标都按 `url_glob_match` 校验（`*` 不跨 `/`，`**` 跨段，其余字符字面量，`?` 是查询分隔符）。未显式启用插件代理时走 reqwest 默认（继承系统代理），启用后插件代理优先；响应头名小写、重复头以 ", " 合并，`url` 为最终响应地址。
- **取消传播**：禁用、撤销 `http:request`、撤销网页信任、卸载、重载、替换安装都会取消该插件全部在途请求（随状态提交或 reload/替换操作执行）；配置恢复导入执行整体取消。open 准入后和 read 前后都重校验安装代次、启用态与 `http:request` 授权，撤权后的旧请求立即失败且不交付字节。

[`file.rs`](../../src-tauri/src/commands/file.rs) 的 `plugin_pick_files({pluginId, options})` 原生选择后及所有文件读取完成后都复核安装身份和权限，长时间读取期间撤权/替换不能交付旧授权结果；wire 仍返回 `{files:[{path, base64}]}`。`executeHostApi` 将 binary 转为 `{files:[{path, bytes: Uint8Array}]}`，text 用共享 `lineText.decodeBytes` 返回 content；`fs.read` binary 同样返回 Uint8Array，优先 raw 的兼容路径见上文。`PluginSession` 在成功回复时 transfer 文件缓冲区，避免交付时再次克隆，不将二进制展开为 JSON 数字数组；读取完成后再次核对请求仍存活及授权，旧请求不泄漏结果。旧全文件与新范围/分页读取均不设通用 RPC 读取期限；仍受实际内存和运行时字符串/缓冲区能力约束，不要求可信网页批准。

旧目录实现同样在 [`file.rs`](../../src-tauri/src/commands/file.rs)：`plugin_pick_directory` 只接受主窗调用与原生选择结果（支持多选），`plugin_list_directory`/`plugin_read_directory_file`/`plugin_stat_directory_entry` 与写侧 `plugin_write_directory_file`/`plugin_create_directory`/`plugin_remove_directory_entry`/`plugin_rename_directory_entry` 都通过 grant 重校验后才在阻塞线程池操作；`plugin_release_directory` 只删除本插件 grant。新范围/分页由同一 grant 能力延伸，不是插件自报根路径的新入口；前端 `executeHostApi` 做参数形状、编码/解码和 buffer transfer，原生层保留权威围栏。

`PluginConfigEntry` 包含 `id`、`installGeneration`、`enabled`、`trustedWebGranted`、`grantedPermissions` 和可选 `installedAt` / `source`。`PluginView` 另含校验后的 manifest、可声明/可授予权限和错误信息；manifest 损坏时仍列出错误项。`pluginConfigSnapshot` 按后端 revision 拒绝旧列表与旧变更响应，同步网页批准；安装身份变化丢弃旧 manifest UI 并使旧 KV 缓存失效。会写配置的命令返回保存后的快照（`snapshot()` 在 `config.json` 提交后取 revision）；`reload_plugin`/`clear_plugin_web_data` 不写配置、返回当前快照。`syncStorePluginConfigs` 只接受不小于已接受 revision 与 store 当前 revision 的快照，`syncPluginListSnapshot` 先过同一闸门再替换视图。

## Worker 桥与派发

作者 API、事件载荷、配额和示例已集中至[插件开发指南](../plugin-development.md#api-参考)，这里不维护第二份接口表。

宿主执行链：`PluginSession.handleWorkerRequest` 验证当前安装身份、启用态及调用时权限 → `pluginHostApi.executeHostApi` 校验参数并执行具体能力。RX 数据在有当前读取授权时才转发；`pluginBridge` 收到批次后按订阅快照执行回调，等待返回的 Promise settle 后 ACK。RPC 到期只回收回执槽位，不能把迟到结果交给替换后的 Worker，也不承诺取消已开始的后端副作用。文件读取、私有写入、目录导出 `fs.exportFile`、原生另存为 `fs.saveFile`、串口 `serial.open/close`、KV 持久化与 `http.*` 不适用通用 RPC 期限（真实 IO/长连接/用户选择/连接收尾），取消仍走显式通道，不将未完成操作伪装成到期成功。`view.sendBinary` 使用独立 10 分钟传输 RPC 资源期限，并受逐块 30 秒 ACK 和主动闲置回收约束（见[二进制通道](plugin-views.md#视图二进制通道)）。每会话普通 RPC 回执槽位上限 32；新范围/批量/分页文件请求使用独立 8 槽，`http.cancel` / `fs.cancel` 共享最多额外 64 个取消槽，既避免文件扫描挤满普通控制 RPC 或取消排在自身请求后，又不允许无限取消洪泛。

**Worker 就绪与错误分级**：桥在用户入口脚本同步执行完成后发出 `__plugin_ready`。入口加载、解析或初始化失败属于启动失败，按启动重试与熔断策略处理；就绪后的未处理拒绝、`worker.onerror` 与显式 `error` 事件只写诊断日志并限流提示，不终止会话或清空插件内存。原生视图故障按视图失败处理。`startReady` 将启动代次绑定到 readiness 结算，旧 IO 不能结算新启动；ready 后健康探针检测静默终止，正常异步错误仍只记录诊断。

**纯网页插件**：`PluginManifest.entry` 可省略，仅当存在非空 `trusted-web` + `input:"none"` 视图且无 Worker 按钮/菜单时合法；`ui.views[].worker:false` 允许混合插件中的某个可信页不依附 Worker。宿主对这些视图使用 `workerEpoch=0`，不创建空 Worker、不等待 Worker ACK，Worker 重启不影响它们。

## RX 性能边界
`pluginObserver` 仅通过 `RxPipeline` 的行级多播钩子订阅；协议帧由 `enqueueFrame` 进入同一入口，和普通 TRX RX 行一样只投递一次，回放/TX 不触发此钩子。`pluginBytesObserver` 在 serial:data 层旁路，保留 TTY 字节。无订阅时不建立队列；每端口队列按行数、字节数受限，可见页按 rAF、隐藏页按 timer 递送，并在 visibilitychange 时重排已挂起的 rAF。最后一个字节订阅者注销时取消调度并清空旧端口队列。每个 Worker 的待确认事件数及字节数也有上限；跨 Worker 的字节批次使用精确长度独立 buffer，不能 transfer 与终端缓冲共享的 `rawData.buffer`。

## 验证与发行边界

范围/分页 raw 通道、队列与 soft IO budgets 的自动化验证不等于真实环境性能验收；尚未完成发行 WebView、真实磁盘与多插件同时扫描大文件的实机压测。当前并发/字节/速率预算是准入与在途资源策略，不是吞吐/延迟 SLA，也不能证明主窗绝不阻塞或插件/应用总内存有硬上限。没有新增独立插件进程或堆配额。

- Rust 库测试覆盖 manifest/路径/ZIP 边界、市场索引/描述 schema 与 URL 校验、安装身份与事务恢复、权限和目录 grant、原子文件写入、HTTP 流式取消与重定向、本机命令执行与取消；运行 `npm run test:rust`（统一入口的临时目录隔离见[提交与验证](conventions.md#提交与验证)）。
- 前端类型检查与 Vitest 覆盖 revision 快照、权限撤销、KV/文件/目录/HTTP、Worker、RX 旁路、通知和 UI 注册表；运行 `npx tsc --noEmit` 与 `npm run test:run`。
- `e2e/plugin.spec.ts` 使用 Chromium Worker/RX/终端和 mock Rust invoke；它不证明原生选择器、ZIP 事务或生产 WebView CSP。目标平台安装包验收见 [`release.md`](release.md) 与 [`plugin-views.md`](plugin-views.md)。
