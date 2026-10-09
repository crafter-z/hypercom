# 插件系统（feat/plugin-system）

本模块支持安装目录或 ZIP 形式的普通 JS 脚本插件；设置页分别提供“安装目录”和“安装 ZIP”入口，取消任一选择器不启动另一选择器。插件只在主窗口的 Web Worker 中运行；宿主通过声明式 Sidebar 按钮、端口菜单和输出面板呈现 UI。当前没有 Rust 原生插件、插件市场、远程调试器或插件自定义 DOM。

## 运行与信任边界

- `<config_dir>/plugins/<反向域名 id>/manifest.json` 与 manifest 指定的 `entry` 是插件代码来源；入口为单文件普通脚本，不支持 ESM `import` / `require`。Rust 的 `plugin::PluginManifest::validate` 校验 id、API 主版本、路径及权限声明；启动时宿主读取 manifest，失败即拒绝运行。
- 主窗口 `usePluginHost` 在 `useSystemStore.ui.configReady` 后同步 `config.pluginConfigs` 与 Worker；每个已启用插件一个 `PluginSession`。异步启动、停用和升级按会话代次隔离；`worker.onerror` 与未处理的 Promise 拒绝触发有界重启，连续启动崩溃达到阈值后停用并持久化。弹窗不加载插件宿主。
- Worker 没有 DOM / `window.__TAURI__`；宿主和插件以 `postMessage` 通讯，宿主在每次 RPC 调用时检查 `grantedPermissions`。`list_plugins` 扫盘后读取后端最新授权；主窗 `pluginConfigSnapshot` 的共享代次拒绝跨宿主／设置页的迟到列表响应，防撤权后旧快照复活 Worker 权限。插件安装与启用是用户信任决策，不是针对恶意主窗口脚本的强沙箱：能在主窗口执行的任意脚本仍可直接调用 Tauri 命令。后端对插件命令另做主窗口来源限制、已启用及权限验证，不把 Worker 中的 `pluginId` 当成不可伪造身份。
- 生产 CSP 在 `src-tauri/tauri.conf.json` 中限制 `connect-src 'self'`，插件直连网络不可用；出站 HTTP 走 `plugin_http` 的已授权权限和规范化 URL 白名单，不自动跟随跳转，不继承系统代理。用户可单独配置插件代理。开发环境 `devCsp` 放行 Vite HMR。生产 Tauri CSP 未被 Vite mock e2e 覆盖，发布前必须单独检查。
- 更新同 id 插件时不信任更高版本号：新代码默认 **禁用并清空已授予权限**，需重新审阅授权后启用。安装准备阶段先完成完整 staging 校验；正式换入新代码前持久化 fail-closed 状态（`enabled=false`、空授权、递增 `installedAt`），换入与配置闸门在不可取消阻塞事务段内完成。进程在换入前后任意时刻退出，重启都不会恢复旧授权；失败回滚只有确认旧 manifest 完整恢复后才恢复旧配置，否则保持禁用。更新 marker 变动会终止旧 Worker，下一次启动按新 manifest 读取入口。
- 插件列表由主窗宿主和设置页共享快照；只读 `list_plugins` 不使其他只读请求失效，只有实际安装/卸载/启停/授权命令递增变更代次。权限整体替换按插件在模块级串行队列执行，换设置页不会用旧快照恢复已撤销权限。

## 磁盘与配置

- `config.json` 使用 `AppConfig.entities.plugin_configs`（`#[serde(flatten)]`，JSON 顶层键 `pluginConfigs`），仅含 id、启用状态、授予权限和安装元数据。插件 KV 位于 `plugins/<id>/data/state.json`，不进入 config.json；`storage` 权限仅访问此文件，`fs:storage` 允许读取/写入整个 `data/`，`fs:assets` 允许读取自身代码和资产。
- `install_plugin` 与 `uninstall_plugin` 返回完整权威状态数组，前端 `syncStorePluginConfigs` 回填运行镜像。`config.json` 的 `revision` 在每次保存后递增：普通 `set_config` 带 `expectedRevision`，Rust 在配置锁内 CAS 拒绝并发写入产生的旧快照；前端重新读取后端和活实体并重试，保留其他 webview 已保存的规则。`set_config` 同时在 `plugin_io` 锁内用**当前后端** `pluginConfigs` 覆盖前端提交的旧数组，避免撤权回退；备份导入显式 `restorePluginConfigs: true` 才整体恢复配置。ConfigModal 的“取消”保留期间已落盘的插件状态；多次 CAS 冲突时设置弹窗保持打开，不报告保存成功。
- Rust `plugin::validate_plugin_id` 要求反向域名每段非空；安装、卸载、资产读写共用校验。ZIP 和目录源均拒绝路径穿越/链接，并执行 2000 条、32 层、64 MiB 上限；`data/` 运行期限制单文件 16 MiB、总量 64 MiB、1024 个文件，读取也有界。普通资产 IO 不排队占住控制面闸门，控制操作忙时快速失败。安装先暂存、验证入口和复制期间 manifest 一致，再在换入前持久化禁用清权；卸载先备份目录、保存配置成功后再删备份。资产写入采用同目录临时文件替换目标，不跟随目标符号链接；Windows data 路径按首组件规范化并拒绝大小写/尾点/ADS 等别名。
- 插件 `fs.openDialog` 的唯一入口为 Rust `plugin_pick_files`：后端验证插件已启用及 `fs:open` 授权，由原生文件选择器产生路径，只读取本次选中的普通文件；单次至多 8 个文件、合计最多 64 MiB，返回 base64，宿主按 TextDecoder 编码解码（如 GBK）。不提供接收任意路径的插件字节读取命令。`ui.panel.export()` 和面板导出按钮经原生另存为对话框写入文本。

## Worker API：当前已交付

插件侧桥对象为 `self.plugin`，`plugin.api['op.name'](args)` 返回 Promise；事件处理用 `plugin.on(type, callback)` 或 `plugin.rx.onLine/onBytes/onDetached/onDropped(callback)`（返回注销函数）。RX、字节事件按批传输，因此回调收到数组，非单条记录。

- 普通 RPC 10 秒、HTTP 20 秒；`fs.openDialog` 与 `ui.panel.export` 由用户控制时长，不受固定 RPC deadline 限制。Worker 事件中 RX 数据和控制事件分离限额：`rx.detached`、UI 点击和丢弃通知使用独立 ACK 槽位/有界待发队列，避免慢插件吞掉断流控制信号。事件回调按派发快照执行，回调自注销不会跳过同批其他订阅者。

| 接口 / 事件 | 权限与语义 |
|---|---|
| `ports.list` / `ports.status` | 只读端口摘要，不暴露完整 store |
| `plugin.rx.onLine(cb)` / `plugin.on('rx.line', cb)` | `terminal:read`；TRX 行组装结果及协议帧原始字节，载荷含 `portId/seq/rawData/encoding/ts` |
| `plugin.rx.onBytes(cb)` / `plugin.on('rx.bytes', cb)` | `rx:bytes`；在 TTY/协议分流前观察原始 RX 块 |
| `plugin.rx.onDetached(cb)` | 对应已授予观察能力的端口切换或断线通知 |
| `plugin.rx.onDropped(cb)` | 观察器队列溢出、超大帧或 Worker 背压造成数据缺口时送 `rx.dropped`；观察器给端口及丢失量，Worker 背压给原因 |
| `terminal.append` | `terminal:write`；写 NOTE 旁注，不进入 TX 统计及历史 |
| `serial.send` | `serial:send`；调用时按 manifest `serial.portWhitelist` 检查端口，再走 `sendToPort` |
| `fs.read` / `fs.write` | `fs.read({rel})` 按路径选择授权：读取 `data/` 需要 `fs:storage`，读取包内资产需要 `fs:assets`；`fs.write` 仅写 `data/` 且需要 `fs:storage`。路径还由 Rust 规范化校验。 |
| `fs.openDialog` | `fs:open`；由宿主原生对话框显式选文件，返回 `{files:[{path,content}]}` |
| `http.request` | `http:request` + `http.urlWhitelist`；Rust 转发、最长 15s、响应正文最多 1 MiB |
| `shell.openExternal` | `shell:open`；后端限制 `http/https/mailto`，校验插件已启用和授权 |
| `clipboard.readText/writeText` | `clipboard` |
| `storage.get/set` | `storage`；插件私有 JSON KV，按插件串行化整文件写入 |
| `notify` / `log` | 分别为 `notify` / 无需权限；通知限时，日志令牌桶限流 |
| `ui.panel.append/clear/export` | 插件专属输出面板，聚合文本最多 512 KiB，导出经原生另存为 |
| `plugin.on('ui.buttonClick', cb)` | manifest 声明的 Sidebar/端口菜单，端口菜单携带 `context.portId`；工具栏在有活动标签时携带端口 |

`ports.onChange`、`rx.getBuffer`、`fs.list`、`shell.execute`、`events.on/emit` **未实现**，相关权限不可授予；不应作为已交付的 v1 API 宣传。TTY 不产 `rx.line`，需要原始流时使用独立授权的 `rx.bytes`。插件输出、HTTP 和外部工具并非同一权限。插件本身提供的 label 按原文呈现，不由宿主翻译。

## RX 性能边界与验证
`pluginObserver` 仅通过 `RxPipeline` 的行级多播钩子订阅；协议帧由 `enqueueFrame` 进入同一入口，和普通 TRX RX 行一样只投递一次，回放/TX 不触发此钩子。`pluginBytesObserver` 在 serial:data 层旁路，保留 TTY 字节。无订阅时不建立队列；每端口队列按行数、字节数受限，可见页按 rAF、隐藏页按 timer 递送，并在 visibilitychange 时重排已挂起的 rAF。最后一个字节订阅者注销时取消调度并清空旧端口队列。每个 Worker 的待确认事件数及字节数也有上限；跨 Worker 的字节批次使用精确长度独立 buffer，不能 transfer 与终端缓冲共享的 `rawData.buffer`。

- Rust 测试：ID 穿越、ZIP 限额、安装更新及回滚、卸载备份、资产替换、HTTP glob；`cargo test --lib --manifest-path src-tauri/Cargo.toml`。
- 前端 Vitest：权限、KV 并发、RX/字节旁路、UI 注册表和 Worker 生命周期。`npx tsc --noEmit` 与 `npm run test:run`。
- `e2e/plugin.spec.ts` 在 Chromium 中运行真实 Worker/RX/终端链路，但模拟 Rust invoke；不能证明生产 CSP、原生文件选择或真实 ZIP 安装。发版前以 Tauri 生产构建逐项检查安装→授权→启用→升级重新授权→卸载、CSP 出站阻断及多窗口行为。
