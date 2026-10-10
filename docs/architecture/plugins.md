# 插件系统

本模块支持安装目录或 ZIP 形式的普通 JS 脚本插件；设置页分别提供“安装目录”和“安装 ZIP”入口，取消任一选择器不启动另一选择器。插件逻辑在主窗 Web Worker 中运行，UI 可用声明式 Sidebar/端口菜单、文本面板或独立隔离 WebView；隔离视图可替换串口内容或创建额外工作区标签。当前没有 Rust 原生插件、插件市场或远程调试器，插件 UI 不能访问宿主 DOM。

插件作者从独立的[插件开发指南](../plugin-development.md)开始：manifest、权限、Worker API、示例、调试和打包说明集中在那里。普通用户看[设置 → 插件](../userwiki/设置.md#插件)。本文只维护宿主实现、原生 IPC、授权一致性与磁盘恢复；发行验收见[插件发版验收门](release.md#插件发版验收门)，[历史设计评审](../reviews/plugins-review-2026-09-02.md)不代表当前问题清单。

独立 UI、串口内容替换及动作创建额外工作区标签的当前实现见[隔离视图与标签契约](plugin-views.md)。Windows raw Wry adapter 已实现；其他平台隔离承载未验收时明确拒绝，不用主窗 iframe 替代。

## 运行与信任边界

- `<config_dir>/plugins/<反向域名 id>/manifest.json` 与 manifest 指定的 `entry` 是插件代码来源；入口为单文件普通脚本，不支持 ESM `import` / `require`。Rust 的 `plugin::PluginManifest::validate` 校验 id、API 主版本、路径及权限声明；启动时宿主读取 manifest，失败即拒绝运行。
- 主窗口 `usePluginHost` 在 `ui.configReady` 后同步插件状态；会话绑定 `installGeneration`，身份变化终止旧 Worker。失败计数窗口为 10 秒，窗口内累计三次启动或运行失败后尝试持久化禁用并通知；未达阈值时，加载失败按 500ms × 当前失败次数等待重试，Worker 异常重启等待 100ms。设置页刷新可重试未运行会话；若禁用状态保存失败，记录错误而不声称持久化成功。弹窗不加载插件宿主。
- Worker 没有 DOM / `window.__TAURI__`；宿主和插件以 `postMessage` 通讯，宿主在每次 RPC 调用时检查当前安装身份及 `grantedPermissions`。`list_plugins` 在控制面闸门内取得一致的磁盘与配置快照；主窗 `pluginConfigSnapshot` 按后端 `revision` 拒绝迟到的列表和变更响应，防撤权后旧快照复活权限。插件安装与启用是用户信任决策，不是针对恶意主窗口脚本的强沙箱：能在主窗口执行的任意脚本仍可直接调用 Tauri 命令。后端对插件命令另做主窗口来源限制、已启用及权限验证，不把 Worker 中的 `pluginId` 当成不可伪造身份。
- 生产 CSP 在 `src-tauri/tauri.conf.json` 中限制 `connect-src 'self'`，插件直连网络不可用；出站 HTTP 走 `plugin_http` 的已授权权限和规范化 URL 白名单，不自动跟随跳转，不继承系统代理。用户可单独配置插件代理。开发环境 `devCsp` 放行 Vite HMR。生产 Tauri CSP 未被 Vite mock e2e 覆盖，发布前必须单独检查。
- 已安装插件的 manifest 正常时，同 ID 仅接受版本号严格更高的覆盖安装；同版/降级拒绝，旧 manifest 损坏时允许修复安装。成功安装或升级默认 **禁用并清空授权**，生成新的 UUID `installGeneration`；卸载重装不会复用身份。启用/授权命令携带用户实际审阅的 `expectedGeneration`，在取得闸门后校验，升级期间排队的旧授权、旧启用和旧 Worker 自动禁用不会作用于替换代码。`installedAt` 只是安装元数据，不参与身份判断。
- 设置页允许在插件禁用时逐项授权；应先授予初始化所需权限再启用。权限整体替换按插件在模块级队列执行，启用等待当前授权队列落盘；安装/卸载进行时禁用设置页控制，但最终安全边界仍是后端安装身份检查。

## 磁盘与配置

- `config.json` 使用 `AppConfig.entities.plugin_configs`（`#[serde(flatten)]`，JSON 顶层键 `pluginConfigs`），包含 id、安装身份、启用状态、授予权限和安装元数据。插件 KV 位于 `plugins/<id>/data/state.json`，不进入 config.json；`storage` 权限仅访问此文件，`fs:storage` 允许读取/写入整个 `data/`，`fs:assets` 允许读取自身代码和资产。
- 插件管理响应、排序和调用参数见下方[宿主命令契约](#宿主命令与状态快照)。普通配置保存以 revision CAS 并保留后端权威插件状态；备份恢复只允许同安装身份恢复启用/授权，不匹配的同 ID 插件禁用清权，未提及的当前插件保持原状，备份中的未安装插件不会被安装。导入后读回权威状态，取消设置保留当前插件状态及 revision。配置导出不包含插件代码、私有数据或事务 journal。
- Rust 的 manifest、路径、包容量及私有数据额度校验是权威执行点；作者可见的数值限制集中在[开发指南](../plugin-development.md#限制与错误处理)。普通资产 IO 按 FIFO 最多等待磁盘闸门 2 秒；授权及路径/额度检查后，只有目标确实不存在才返回 null，超时/权限/编码/IO 错误不能伪装成缺文件。
- 安装先完整暂存并验证入口和 manifest 一致性，再持久化禁用清权及安全 `.bak`。`plugin/transaction.rs` 将受限 journal 写入 `<config_dir>/plugin-transaction.json` 并同步，路径只能由有效插件 ID 和 UUID 派生。启动在 Worker 前恢复中断事务：最终发布前恢复旧代码和私有数据，发布完成保留新树但不恢复授权；卸载配置提交前恢复备份，提交后清理备份。恢复幂等，非法/链接/含糊状态报错并保留数据。资产写入同步临时文件后单操作替换目标（Windows `MoveFileExW` 写穿透），不再先移走旧 KV 文件。文件系统和设备必须遵守 flush/write-through；准备阶段尚未登记的惰性 staging 残留不含迁移后的私有数据。
- 插件 `fs.openDialog` 的唯一入口为 Rust `plugin_pick_files`：后端验证插件已启用及 `fs:open` 授权，由原生文件选择器产生路径，只读取本次选中的普通文件；单次至多 8 个文件、合计最多 64 MiB，返回 base64，宿主按 TextDecoder 编码解码（如 GBK）。不提供接收任意路径的插件字节读取命令。`ui.panel.export()` 和面板导出按钮经原生另存为对话框写入文本。

## 宿主命令与状态快照

这是**宿主前端与 Rust 的 IPC 契约**，不是 Worker 可直接调用的 API。宿主调用经 `src/services/plugin.ts`，命令参数采用 camelCase；插件 Worker 只经开发指南中的[API 桥](../plugin-development.md#调用-api-与处理事件)访问能力。

| Rust 命令 | 宿主参数 | 响应与关键语义 |
|---|---|---|
| `list_plugins` | 无 | `PluginListResponse = {revision, pluginConfigs, plugins}`；一致扫描/状态快照，不修改配置 |
| `install_plugin` | `{sourcePath}` | `PluginStateSnapshot = {revision, pluginConfigs}`；安装成功后禁用清权并分配新身份，保留升级前的用户 `data/` |
| `uninstall_plugin` | `{id}` | `PluginStateSnapshot`；提交后删除该插件代码、状态及私有数据 |
| `set_plugin_enabled` | `{id, enabled, expectedGeneration}` | `PluginStateSnapshot`；expectedGeneration 必须为用户实际审阅的安装身份，旧身份拒绝 |
| `set_plugin_permissions` | `{id, permissions, expectedGeneration}` | `PluginStateSnapshot`；整体替换当前支持且 manifest 已声明的权限；可在禁用时授权 |
| `read_plugin_asset` | `{id, relPath}` | UTF-8 `string \| null`；仅已授权目标确实不存在为 null，空文件返回 `''`，其他失败 reject |
| `write_plugin_asset` | `{id, relPath, content}` | 无返回值；仅已授权 `data/` 文本写入，先校验父目录及总额度 |
| `plugin_http` | `{pluginId, request}` | `{status, body, truncated}`；请求字段为 method/url/headers?/body?/timeout?，timeout 单位为秒 |
| `plugin_open_external` | `{pluginId, url}` | 无返回值；需要 shell:open，仅 http/https/mailto |
| `create_plugin_view` | `{binding}` | 主 WebView 专用；校验安装/权限/端口及资源后创建独立原生 UI |
| `update_plugin_view` | `{instanceId,rect,visible,layoutRevision}` | 最新 revision 几何及可见性；按主窗 zoom/DPI 转换并裁剪 |
| `send_plugin_view_message` | `{instanceId,message}` | 只准 init/state/environment 有界 JSON，状态快照 256 KiB，不接受源代码 |
| `destroy_plugin_view` | `{instanceId}` | 幂等退休原生路由/控件，迟到消息不能复活 |

文件选择另由 `commands/file.rs` 的 `plugin_pick_files({pluginId, options})` 实现，原生选择后再次核对安装身份和权限；它返回 `{files:[{path, base64}]}` 给宿主，宿主按插件指定编码解码，再将 `{files:[{path, content}]}` 返回 Worker。不能把此原生 wire 形状与 Worker API 混用。

`PluginConfigEntry` 包含 `id`、`installGeneration`、`enabled`、`grantedPermissions` 和可选的 `installedAt` / `source`。`PluginView` 另含校验后的 manifest、可声明/可授予权限和错误信息；manifest 损坏时仍列出错误项。`pluginConfigSnapshot` 按后端 revision 拒绝旧列表与旧变更响应，安装身份变化则丢弃旧 manifest UI 并使旧 KV 缓存失效。

## Worker 桥与派发

作者 API、事件载荷、配额和示例已集中至[插件开发指南](../plugin-development.md#api-参考)，这里不维护第二份接口表。

宿主执行链：`PluginSession.handleWorkerRequest` 验证当前安装身份、启用态及调用时权限 → `pluginHostApi.executeHostApi` 校验参数并执行具体能力。RX 数据在有当前读取授权时才转发；`pluginBridge` 收到批次后按订阅快照执行回调，等待返回的 Promise settle 后 ACK。RPC 到期只回收回执槽位，不能把迟到结果交给替换后的 Worker，也不承诺取消已开始的后端副作用。

## RX 性能边界
`pluginObserver` 仅通过 `RxPipeline` 的行级多播钩子订阅；协议帧由 `enqueueFrame` 进入同一入口，和普通 TRX RX 行一样只投递一次，回放/TX 不触发此钩子。`pluginBytesObserver` 在 serial:data 层旁路，保留 TTY 字节。无订阅时不建立队列；每端口队列按行数、字节数受限，可见页按 rAF、隐藏页按 timer 递送，并在 visibilitychange 时重排已挂起的 rAF。最后一个字节订阅者注销时取消调度并清空旧端口队列。每个 Worker 的待确认事件数及字节数也有上限；跨 Worker 的字节批次使用精确长度独立 buffer，不能 transfer 与终端缓冲共享的 `rawData.buffer`。

## 验证与发行边界

- Rust 测试：ID/路径与 manifest 上限、ZIP 限额、安装身份与旧操作拒绝、逐 rename 中断恢复及卸载提交边界、父目录额度、缺文件与读取失败区分、HTTP 查询字面匹配；`cargo test --lib --manifest-path src-tauri/Cargo.toml`。
- 前端 Vitest：revision 响应乱序、升级期间权限操作、启用前授权、KV 读失败/损坏数据保全、通知配额、RX/字节旁路、UI 注册表与 Worker 初次失败恢复。`npx tsc --noEmit` 与 `npm run test:run`。
- `e2e/plugin.spec.ts` 使用真实 Chromium Worker/RX/终端但模拟 Rust invoke，不能证明原生选择器、真实 ZIP 事务或生产 WebView CSP。最终安装包验收见[发版要求](release.md#插件发版验收门)；下面的已执行记录不是发行包签收。

### 已执行的原生回归（2026-10-10）

2026-10-10 原生回归使用隔离配置及 `tauri build --debug --no-bundle`（生产前端资产与 CSP、Rust debug 可执行文件）：启用前授权、初始化 KV、200 条通知限流、HTTP 查询精确匹配、深目录额度拒绝后已有文件仍可读写、升级期间旧授权拒绝、重新授权保留 KV、卸载均通过；四个已启用插件同时启动并读取各自 KV 全部成功。五组磁盘中断快照由真实原生启动恢复（备份/私有数据迁移/发布、卸载提交前后），私有数据及禁用清权状态符合预期；这不是物理断电测试，也不替代最终 release 安装包和其他平台验收。
