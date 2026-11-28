# 协作控制面、CLI/MCP 与远程串口

本模块为本地自动化工具（`hypercomctl` CLI 与 MCP Server）、远程 HyperCom 工作台及插件显式串口借用提供统一的控制面与数据面。核心原则：**同一物理串口只由设备所在宿主独占持有**，GUI、CLI、MCP 与远程客户端通过同一领域调度与租约仲裁访问，不各自打开设备句柄。

## 模块与 Crate 拓扑

| 组件 | 位置 | 职责 |
|---|---|---|
| 共享协议 crate | `src-tauri/hypercom-protocol/` | 线协议帧编解码、`ControlCommand`、`PortRef`、IPC（Named Pipe / UDS）、PIN 校验 TLS 1.3、`Authority` / `ProfileStore` 凭据存储、`ExpectMatcher`、`AsyncControlClient` / `ControlClient` |
| 独立 CLI / MCP | `src-tauri/hypercomctl/` | 命令行客户端与 stdio JSON-RPC 2.0 MCP Server（独立二进制，通过本地 IPC 或远程 TLS 连接宿主；`plugin_cmd.rs` 处理插件工具调用、job 跟踪与流式 Artifact 上传） |
| 宿主控制面中心 | `src-tauri/src/control/{mod,server,dispatch}.rs` | `ControlHub`：托管本地 IPC 监听、可选远端 TLS 1.3 服务、1s 租约与 30s Artifact 过期回收器及命令分派 |
| Artifact 暂存与插件桥 | `src-tauri/src/control/artifacts.rs`、`plugin_bridge.rs` | `ArtifactStore` 磁盘流式暂存与 SHA-256 校验；`PluginControlBridge` 工具注册表、同步/异步 job 派发与远端视图宿主代理 |
| 远端客户端管理 | `src-tauri/src/remote_client/mod.rs` | `RemoteClientManager`：解析/预览邀请、配对与持久化配置、双向连接远端宿主、2s 状态轮询、事件桥接、远端插件工具/视图转发与 Artifact 流式上传 |
| 串口事件总线与租约 | `src-tauri/src/serial/{event_hub,lease,managed_loan}.rs` | `SerialEventHub` 有界事件环形缓冲与广播、`PortLeaseRegistry` 租约注册表、`ManagedPortLoan` 关闭/重开屏障 |
| Tauri 命令桥 | `src-tauri/src/commands/control.rs`、`serial.rs`、`plugin_serial.rs` | 前端协作管理命令、`PortRef` 透明转发、插件工具/视图投影回调、`remote_pick_and_upload_artifact`、`create_projected_plugin_view` 与 `plugin_serial_*` 命令 |
| 前端能力与控制桥 | `src/services/control.ts`、`src/utils/portCapabilities.ts`、`src/utils/pluginControlBridge.ts` | 协作服务封装、端口能力门控、主窗口插件工具目录同步与远端视图代理转发 |
| 前端界面 | `CollaborationSettings.tsx`、`RemoteHostsSection.tsx`、`SortablePortItem.tsx` | 协作设置页、侧边栏远程主机与可投影插件视图分区、借用状态/归还交互 |

## 线协议与传输层

### 帧格式与常量（`hypercom-protocol/src/protocol.rs`）

- 协议版本 `PROTOCOL_VERSION = 1`，默认本地端点名 `DEFAULT_ENDPOINT = "default"`。
- `FrameEnvelope` 采用 **4 字节大端 `u32` 长度前缀 + UTF-8 JSON 载荷**；空帧或超过 `MAX_FRAME_BYTES`（2 MiB）拒绝。
- 请求命令为 `ControlCommand`（`#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]`），响应统一为 `ReplyEnvelope { ok, result?, error? }`，错误结构为 `HostError { code, message }`。
- `MAX_WRITE_BYTES` = 64 KiB、`MAX_EXPECT_BYTES` = 4 KiB、`MAX_EXPECT_MS` = 60,000 ms、`MAX_POLL_MS` = 1,000 ms、`MAX_ARTIFACT_CHUNK_BYTES` = 512 KiB；备注单条上限 `MAX_NOTE_BYTES` = 4096 字节。

### 本地 IPC 与远端 TLS 1.3

- **本地 IPC**（`hypercom-protocol/src/ipc.rs`、`ipc_windows.rs`、`ipc_unix.rs`）：Windows 使用 Named Pipe，Unix 使用 Unix Domain Socket，仅允许同一操作系统用户访问。端点名由 `validate_endpoint_name` 限制为 1–32 个 ASCII 字母/数字/`_`/`-`；宿主可通过环境变量 `HYPERCOM_HOST_ENDPOINT` 覆盖默认端点名。
- **远端 TLS 1.3**（`hypercom-protocol/src/tls.rs`）：仅启用 TLS 1.3，ALPN 固定为 `CONTROL_ALPN = b"hypercom-control/1"`，禁用 TLS 1.3 session tickets 与 early data。客户端通过 `decode_sha256_pin` 校验服务端证书 SHA-256 指纹（`connect_pinned_tls`），不依赖系统 CA。
- **凭据与身份存储**（`hypercom-protocol/src/auth/{mod,store,windows_acl}.rs`）：
  - 宿主状态根默认位于 `Authority::default_state_root()`（使用 `--config` 启动时隔离在配置目录下的 `control-authority/`），保存服务端自签名证书密钥、一次性邀请与已配对客户端凭据。
  - 客户端配对配置由 `ProfileStore` 管理（默认 `ProfileStore::default_dir()`，使用 `--config` 时隔离在配置目录下的 `client-profiles/`）。Windows 使用 DPAPI + 当前用户 ACL 校验，Unix 使用 `0700`/`0600` 文件权限。配对与移除通过 `.lock` 文件预约锁互斥，且不允许静默覆盖已有同名配置。

## `PortRef` 命名空间与角色权限

### 端口引用（`PortRef`）

`PortRef::parse` 区分两类目标：

- **本地端口**：原始标识（如 `COM3`、`/dev/ttyUSB0`、`SIM:Loopback`）。
- **远端端口**：`remote::<profileId>::<portId>`。前端 `src/utils/portCapabilities.ts` 提供对称的 `isRemotePortId` / `parseRemotePortId` / `formatSerialTabTitle` / `getPortCapabilities`。

`commands/serial.rs` 中的 `open_serial_port`、`close_serial_port`、`send_serial_data`、`send_file`、`set_serial_params`、`set_flow_control` 均先经 `PortRef::parse` 解析：`Local` 走本机 `SerialManager`，`Remote` 转发到 `RemoteClientManager` 对应的远端会话（远程客户端侧不支持本地文件路径 `send_file` 与外部工具 `run_port_tool`）。

### 角色与权限矩阵

远端客户端在配对时获得不可伪造的 `RemotePermissions { role, ports, allow_loan, device_plugins, ... }`（由 `RemoteInvite` 携带并在兑换时持久化），由 `Actor::check_access` 在每次 `ControlHub::dispatch_shared_command` 执行前校验：

| `RemoteRole` | 允许的串口操作 | 受限操作 |
|---|---|---|
| `observe` | `ports`、`status`、`poll_events`、`list_loans`、`host_info` | 拒绝写、备注、开关/改参、借用与回收 |
| `write` | 在 `observe` 基础上增加 `send`、`request`、`add_note` | 拒绝 `open` / `close` / `set_params` / `set_flow_control` / 借用与回收 |
| `control` | 在 `write` 基础上增加 `open`、`close`、`set_params`、`set_flow_control`、`reclaim_loan`；当 `allow_loan = true` 时允许 `acquire_loan` / `heartbeat_loan` / `release_loan` | 不得调用远程管理命令；不得通过已连接的远程节点再向第三跳远端代理 |

- `ports` 为空表示允许访问该宿主全部端口，非空时精确匹配白名单端口。
- `device_plugins` 可在任意 `RemoteRole`（`observe` / `write` / `control`）上独立授予，用于开放设备端插件互操作：
  - `ListPluginTools`、`InvokePluginTool`、`PollPluginJob`、`CancelPluginJob` 与远端视图投影命令（`ListRemotePluginViews`、`OpenRemotePluginView`、`SendRemotePluginViewInput`、`PollRemotePluginViewEvents`、`CloseRemotePluginView`）均要求 `Access::DevicePlugins`（`device_plugins = true`）。
  - 工具发现、调用与取消额外通过 `RemoteRole::allows_tool_access(&desc.access)` 校验工具声明的访问级别（`observe` 仅允许 `observe` 工具，`write` 允许 `observe`/`write`，`control` 允许 `observe`/`write`/`control`）；当工具声明 `port_scoped = true` 且 `args.portId` 存在时，按工具 `access` 级别复核 `ports` 白名单。
  - Artifact 流式上传（`ArtifactBegin` / `ArtifactChunk` / `ArtifactCommit` / `ArtifactAbort`）由 `check_artifact_access` 校验：要求 `device_plugins = true` 且角色 ≥ `write`（`Access::Write`）。`OpenRemotePluginView` 绑定端口时还需具备该端口 `Access::Observe`。
- 远程管理命令（`RemoteStatus` / `RemoteStart` / `RemoteStop` / `RemoteCreateInvite` / `RemoteListClients` / `RemoteRevokeClient`）由 `require_local` 限定只能由本地 IPC 调用（或由宿主 GUI 通过 Tauri 命令直接调用），远端连接一律返回 `forbidden`。
- 吊销远端客户端（`ControlHub::revoke_client`）会立即终止其后续请求并释放其持有的 `connection_bound` 租约（前缀 `remote:<clientId>:`）。

## 实时事件总线与期望匹配（`SerialEventHub`）

`src-tauri/src/serial/event_hub.rs` 维护按端口隔离的内存环形缓冲与广播通道，供本地 IPC、远端 TLS 与 `request` 命令共享（不依赖 Tauri WebView）：

- **每端口上限**：`MAX_HISTORY_EVENTS = 4096` 条、估算载荷上限 `MAX_HISTORY_BYTES = 2 MiB`，超限淘汰最旧事件并通过 `gap: true` 告知拉取方；全局广播容量 `BROADCAST_CAPACITY = 4096`。
- **事件类型（`HubEventKind`）**：`rx`、`tx`、`status`、`loan`、`note`，统一携带单调 `seq`、`port_id`、`generation` 与 `timestamp_ms`。
- **写操作镜像与日志**：外部通过 `ControlHub` 执行 `Send` / `Request` 成功写入后，会同时写入宿主 `LogManager`（TX）、发布到 `SerialEventHub`，并通过 `serial:external-tx` 推送到宿主前端；`AddNote` 发布 `note` 并通过 `serial:note` 推送到终端。
- **原子 `request` 语义**（`dispatch.rs::handle_request` + `hypercom-protocol/src/expect.rs`）：先订阅 `event_hub` 并记录当前 `last_seq`，再执行写入，最后在 `timeout_ms` 期限内用 `ExpectMatcher`（`Line` / `Text` / `Bytes`）匹配同一 `generation` 的后续 `rx` 事件，消除「先写后监听」丢快速应答的竞态。

## 串口借用租约（`PortLeaseRegistry`）

`PortLeaseRegistry`（`src-tauri/src/serial/lease.rs`）基于 `ManagedPortLoan::reserve_lease` 实现跨入口的显式串口借用：

- **借用与归还闭环**：`acquire` 校验目标端口可用（不可为 `GIT:` TTY 端口，插件借用还额外拒绝 `remote::` 端口）、可选 `expected_generation` CAS、记录原连接参数、暂停自动重连、释放系统 COM/tty 句柄并等待读写线程退出；`release` / `reclaim_port` 或 TTL 到期由 `ControlHub::start_lease_reaper`（每秒扫描一次）释放租约，并按 `auto_reopen` / `reopen_override` 与连接状态决定是否按原参数重开，返回 `LeaseRecovery { state, error? }`。
- **状态同步**：借用与归还发出 `serial:tool-loan` 与 `serial:note` 事件，并通过 `PortInfo.loan` 随 `list_available_ports` 同步给前端。宿主桌面端可在侧边栏、标签页右键菜单、终端条及设置页「协作与远程」强制回收（`reclaim_port_loan`）。
- **连接绑定清理**：`connection_bound = true` 的租约绑定持有者标识（`remote:<clientId>:` 或 `plugin:<pluginId>:<installGeneration>`），连接断开、客户端吊销或插件禁用/撤权/重载/卸载时自动释放。
- **与既有借用的共存**：旧外部工具 `run_port_tool`（`ManagedPortLoan::reserve_legacy`）与插件流式任务 `shell.start({ serialLoan })`（`ManagedPortLoan::reserve`）继续共享底层 `SerialManager.tool_loans` 互斥表，同一端口同一时刻只允许一个借用持有者。

## 插件工具互操作与异步任务（`PluginControlBridge`）

`src-tauri/src/control/plugin_bridge.rs` 的 `PluginControlBridge` 与主窗口 `src/utils/pluginControlBridge.ts` 协同，将已就绪且已授权 `control:expose` 的插件工具暴露给本地 CLI/MCP 与远端客户端：

- **工具目录同步与发现（`ListPluginTools`）**：主窗口 `startPluginControlBridge` 订阅插件会话与配置快照，将当前已启用、已就绪且具备 `control:expose` 的插件 `manifest.tools` 通过 `control_sync_plugin_tools` 同步到 Rust。本地调用方执行 `ListPluginTools` 时，`ControlHub` 聚合本地工具与所有已连接且授予 `device_plugins` 的远端主机工具（`RemoteClientManager::list_connected_remote_plugin_tools`，带 `remote::<profileId>` 与 `hostLabel`）；远端调用方仅能看到本地按其 `RemoteRole::allows_tool_access` 过滤后的工具列表。
- **同步与异步 Job 调用（`InvokePluginTool`、`PollPluginJob`、`CancelPluginJob`）**：
  - 本地调用方可通过 `target: "remote::<profileId>"` 将调用/轮询/取消转发到远端宿主；远端调用方不可再向第三跳代理。
  - 若请求携带 `artifacts` ID 列表，须工具声明 `accepts_artifacts: true`，宿主从 `ArtifactStore` 解析为本地路径 `ResolvedArtifactDto` 后再派发。
  - Rust 通过 `control:plugin-invoke` 与 `control:plugin-job-cancel` 事件发送到主窗口，由 `pluginControlBridge.ts` 校验安装身份与 `control:expose` 后路由至对应 `PluginSession` Worker 的 `self.plugin.tools`。
  - **同步模式（`mode: "sync"`）**：Worker 执行后经 `control_plugin_reply` 完成一次性等待（默认超时 30s，可在 100ms–300s 间指定 `timeout_ms`）。
  - **异步 Job 模式（`mode: "job"`）**：`start_job` 立即返回 `jobId`，Worker 通过 `control_plugin_job_event` 推送 `progress`、`log`、`done`、`error` 或 `cancelled` 事件到 `PluginJobEntry` 有界队列（上限 `MAX_JOB_EVENTS = 4096`），供 `PollPluginJob` 长轮询（`wait_ms` 上限 `MAX_POLL_MS`）增量消费或 `CancelPluginJob` 中止。
- **退休清理**：插件禁用、卸载、重载、替换安装、撤回 `control:expose` 或撤回网页信任时，`commands/plugin.rs` 调用 `PluginControlBridge::retire_plugin` 移除其注册工具、使在途同步调用失败、取消运行中 job，并关闭相关远端视图代理。

## 流式 Artifact 暂存（`ArtifactStore`）

`src-tauri/src/control/artifacts.rs` 的 `ArtifactStore` 在控制面状态目录 `artifacts/` 下提供基于磁盘的流式文件暂存，供本地 CLI/MCP（`artifact upload` / `upload_artifact`）及远端工作台在调用插件工具前上传固件或镜像：

- **流式分块与校验**：通过 `ArtifactBegin`（经 `sanitize_artifact_name` 清洗文件名，支持可选 `total_bytes` 与 `ttl_ms`）打开 `<uploadId>.part` 临时文件；`ArtifactChunk` 每次写入不超过 `MAX_ARTIFACT_CHUNK_BYTES`（512 KiB），严格校验顺序 `offset` 并增量更新 SHA-256；`ArtifactCommit` 校验 `total_bytes` 与可选 `expected_sha256` 后原子重命名为 `<artifactId>-<name>` 并返回 `ArtifactInfoDto`；中途失败或取消可调用 `ArtifactAbort` 删除 `.part`。
- **无小体积业务配额**：载荷直接流式写入磁盘 `.part` 文件，不对待上传 Artifact 施加额外小文件业务大小上限。
- **TTL 与后台清理**：默认保留时长 `DEFAULT_ARTIFACT_TTL_MS` = 30 分钟（钳制在 1 秒至 24 小时之间）。`ControlHub::start_lease_reaper` 每 30 秒调用 `ArtifactStore::reap_expired`，清理已过期的已提交 Artifact 及闲置超过 30 分钟（`STALE_UPLOAD_IDLE_MS`）的未完成上传；`ControlHub::shutdown` 调用 `cleanup_all` 清空暂存目录。

## 远程插件视图投影（Remote Plugin View Projection）

具备 `device_plugins` 权限的已配对工作台可将设备宿主上的隔离模式（`isolated`）插件视图投影到本地标签页（显式拒绝 `trusted-web` 视图）：

- **会话与事件协议**：工作台通过 `ListRemotePluginViews` 发现设备端已启用且具 `ui:view` 的隔离视图，调用 `OpenRemotePluginView` 在设备端创建代理会话并返回 `RemoteViewSessionDto`（含内联打包资源 `assets`），随后以 `SendRemotePluginViewInput` 发送交互/二进制/选文件结果，以 `PollRemotePluginViewEvents` 长轮询状态与二进制事件，结束时调用 `CloseRemotePluginView`（连接断开或宿主退休插件时自动回收）。
- **远端原生视图挂载**：工作台前端在 `pluginViewRuntime.ts` 收到 `RemoteViewSessionDto` 后，调用 `create_projected_plugin_view`（`src-tauri/src/plugin/view_runtime/mod.rs` 的 `create_projected`）在本地创建 `projected: true` 的原生隔离视图，并将投影事件转化为页面 `state` / `binary-chunk`；设备宿主侧由 `pluginControlBridge.ts` 维护 `remoteProxyViews`，在 `PluginSession` Worker 与 `control_remote_view_event` 之间双向转发 `view.open` / `view.publish` / `view.sendBinary` / `view.message` / `view.close`。
- **远端选文件自动暂存**：当设备端插件在投影视图中调用 `view.pickClientArtifact` 时，工作台侧 `pluginViewRuntime.ts` 调用 `remote_pick_and_upload_artifact` 弹出本地原生文件选择器并将选中文件流式上传至设备端 `ArtifactStore`，再通过 `SendRemotePluginViewInput` 发回 `kind: "artifact-picked"`。设备端 `ControlHub` 分发器调用 `enrich_remote_view_input_payload` 按 `artifactId` 从本地 `ArtifactStore` 查表补全宿主机真实 `path`、`name`、`sizeBytes` 与 `sha256`（若失效则清除 `artifact` 并写入 `error`），再投递给代理，避免暴露或信任远端构造的宿主机路径。

## `hypercomctl` CLI 与 MCP Server

独立可执行程序位于 `src-tauri/hypercomctl/`（通过 `npm run build:cli` 构建，`npm run test:cli` 与 `npm run test:protocol` 验证；`plugin_cmd.rs` 实现插件工具与流式 Artifact 上传）：

- **目标与格式**：通过 `--host NAME`（默认 `default` 或 `$HYPERCOM_HOST_ENDPOINT`）连接本地宿主，或 `--profile NAME` 连接已配对远端宿主（二者互斥）；支持 `--format text|json|ndjson`。
- **退出码**：`0` 成功、`1` 内部/I/O/未知结果、`2` 用法错误、`3` 宿主不可达或指纹/协议不匹配、`4` 业务或权限拒绝、`5` `expect_timeout` / `idle_timeout` / `timeout`。
- **命令集合**（`args.rs`）：`ping`/`info`、`ports`、`status`、`open`、`close`、`set-params`、`flow`、`send`、`request`、`tail`、`note`、`loan`（含直接包裹子命令 `loan <PORT> -- <CMD>` 与 `acquire`/`heartbeat`/`release`/`reclaim`/`list`）、`plugin`（`list`、`call <PLUGIN_ID> <TOOL> [--target local|remote::<PROFILE>] [--args JSON] [--artifact ID]... [--timeout 30s] [--wait]`、`job <JOB_ID> [--target ...] [--after SEQ] [--follow]`、`cancel <JOB_ID> [--target ...]`）、`artifact upload <FILE_PATH> [--target local|remote::<PROFILE>] [--name NAME] [--ttl 30m]`、`remote`（`status`/`start`/`stop`/`invite [--device-plugins]`/`clients`/`revoke`/`pair`/`profiles`/`check`/`forget`）、`mcp`。
- **MCP Server**（`mcp.rs`）：运行在 stdio 的 JSON-RPC 2.0 服务端（协议版本 `2024-11-05`），暴露 **18 个静态工具**：13 个串口/租约工具（`list_ports`、`get_port_status`、`open_port`、`close_port`、`read_recent_rx`、`send_serial`、`request_serial`、`add_terminal_note`、`acquire_serial_loan`、`heartbeat_serial_loan`、`release_serial_loan`、`list_active_leases`、`run_with_serial_loan`）与 5 个插件/Artifact 工具（`list_plugin_tools`、`invoke_plugin_tool`、`poll_plugin_job`、`cancel_plugin_job`、`upload_artifact`）。此外，`tools/list` 与 `tools/call` 会通过 `ListPluginTools` 动态合并本地与已连接远端插件的工具（分别映射为 `plugin_<seg>_<tool>` 与 `remote_<profile>_<seg>_<tool>`，并在 `acceptsArtifacts` 时注入 `artifacts` schema 字段），调用时经 `DynamicToolRoute` 路由到对应 `target` 执行 `InvokePluginTool`。

## 前端协作与远端端口集成

- **命令与事件**：`src/services/control.ts` 封装协作管理、插件工具、Artifact 上传与远程视图投影 Tauri 命令；`src/services/event.ts` 订阅 `serial:tool-loan`、`serial:note`、`serial:external-tx`、`remote:hosts-changed` 以及 `control:plugin-invoke`、`control:plugin-job-cancel`、`control:remote-view-open`/`input`/`close`。
- **远端客户端状态同步**（`src-tauri/src/remote_client/mod.rs`）：连接已配对配置后建立两条 PIN 校验的 TLS 1.3 连接（一条 RPC 转发，一条 `run_sync_loop` 每 2s 刷新端口快照并用 `PollEvents` 长轮询增量事件），将远端 `rx`、`tx`、`status`、`loan`、`note` 映射为带 `remote::<profileId>::<portId>` 前缀的本地事件推送给主窗口。
- **能力门控与界面**（`src/utils/portCapabilities.ts`）：
  - `Sidebar/RemoteHostsSection.tsx` 展示已配对远程主机、连接控制、所属远程端口及可投影的远端插件视图；`SortablePortItem.tsx` 显示角色徽标与「已借出」状态，并为支持回收的端口提供归还菜单。
  - `useSerialPorts.ts` 刷新远端端口时以后端 `remote_status` / `remote_baud_rate` / `remote_generation` / `loan` 为准，保留借用期间暂时脱离枚举的端口。
  - `useSerialReceive.ts` 接收 `serial:external-tx`（计入 TX 流量并在 TRX 终端追加带来源的 `TX` 行）与 `serial:note`（追加 `NOTE` 行）；触发器自动回复对 `remote::` 端口跳过执行，避免远端侧与本地宿主重复发送。
  - `TerminalView.tsx`、`TabBar.tsx`、`OperationPanel.tsx` / `SendSection.tsx` / `ParamsSection.tsx` 根据 `getPortCapabilities` 限制只读/可写远端端口与已借出端口的操作，并在远程横幅或操作区提示原因与回收入口。
  - `ConfigModal/pages/CollaborationSettings.tsx` 归入「扩展与协作」分组，提供本地端点与租约管理、远程 TLS 宿主启停/邀请/吊销、远端配置配对与连接管理。

## 验证边界

- `npm run test:protocol`（`cargo test --manifest-path src-tauri/hypercom-protocol/Cargo.toml`）验证协议帧、ACL/DPAPI/0600 存储、TLS 1.3 指纹校验、邀请兑换与 `ExpectMatcher`。
- `npm run test:cli`（`cargo test --manifest-path src-tauri/hypercomctl/Cargo.toml`）验证 CLI 参数解析、退出码、子进程借用执行与 stdio MCP 工具分发。
- `npm run test:rust` 覆盖 `ControlHub`、`PortLeaseRegistry`、`SerialEventHub` 与命令映射；前端 Vitest（`portCapabilities.test.ts`、`useSerialPorts.test.ts`、`pluginSerialLoan.test.ts`、`useAppStore.test.ts`）覆盖能力推导、远端合并与插件租约。
- `hypercomctl` 暂未纳入桌面发版打包产物（见 [`release.md`](release.md)），跨主机的真实局域网/VPN 连通性与硬件烧录借用流程仍需实机验收。
