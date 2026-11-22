# 串口共享与远程工作台提案

**状态：提案，未实现。** 目标是让实验室主机上的同一串口可由本机 GUI、办公室 GUI 和脚本共同使用：人持续观察，脚本发起请求并取得结果，关闭 GUI 不影响主机上的连接、日志和已受理任务。不做浏览器重写、远程桌面或通用 Tauri RPC，也不要求首版无改造接入旧 COM 工具。

## 1. 唯一串口所有者

实验室启动一个以普通用户身份运行的 **HyperCom Host**。Host 是物理串口句柄、连接参数、重连、串口事件、会话与日志的唯一权威。实验室本机 GUI 也迁为 Host 客户端，不保留第二条 `open(COMx)` 路径。办公室继续使用原生 Tauri GUI，由本地 Rust 连接适配器跟 Host 通讯，不把 Tauri `invoke` 搬到网络。独立控制台 `hypercomctl` 与两个 GUI 使用同一个 v1 领域协议；CLI 无需启动 GUI。首版一个远程工作区只连接一台 Host，不混本地或其他 Host 的同名端口；断开时明确离线，不能回落到办公室同名 COM 口。

**源码起点：** [serial/mod.rs](<../../src-tauri/src/serial/mod.rs>) 的 `SerialManager::open_port` / `SerialManager::send_data` 和 [serial.rs](<../../src-tauri/src/commands/serial.rs>) 的 `open_serial_port` / `send_serial_data` 提供串口生命周期与写入路径。[serial/events.rs](<../../src-tauri/src/serial/events.rs>) 的 `emit_rx_event` 同时通知前端并写 RX 日志；抽事件接口不能漏掉原始字节聚行、时间戳和日志，也不能让客户端各写一份主机日志。[useAppStore.ts](<../../src/stores/useAppStore.ts>) 的 `getTabPortId` / `getActivePortId` 已区分标签身份和端口；同理，协议的命名会话 `dut` 不等于物理端口 `COMx`，也不等于 GUI 标签。

## 2. v1 协议与权限

本机建议以**经认证的 loopback WebSocket**起步，GUI/CLI 共用版本化请求、结果、事件和错误模型；此阶段不监听外网。远程监听显式开启，使用 WSS、可撤销设备配对和证书固定；证书更换须显式重新确认，撤销应让现有会话失去权限，而不只拒绝下次登录。过渡可用 SSH 隧道转发已认证的 loopback 协议，保留应用层检查，不开放裸端口。Named pipe 可后置；先验证普通用户环境下 GUI 退出后 Host 仍存活，Windows 服务、登出后存活和跨用户设备权限另行验收。

| 权限 | Host 执行边界 |
| --- | --- |
| **观察** | 枚举获准端口/会话、读快照、订阅 RX/TX 和状态。`attach` / `detach` 只变更订阅，不打开、关闭或重配串口；多人并行读。 |
| **写入** | 普通发送取得短写租约；请求事务、文件发送或 TTY 输入取得独占写段，其他写方可能收到忙碌，观察照常。租约绑定身份、端口、连接代次；取消不应中止无关观察，实际写入结算前不应把租约交给下一位写方。 |
| **控制** | 打开/停止、改波特率、DTR/RTS 影响所有附着者，须显式请求、权限和连接代次检查，并广播结果。配对/授信/任务管理不由读写权限隐式获得。 |

实现拆单时，先用同一组协议夹具验证 GUI 与 CLI：握手协商版本及可用能力；枚举和快照不产生设备副作用；修改请求携带请求标识与目标会话，响应能区分权限不足、端口忙、连接已变化和结果未知。共享状态以 Host 为准，客户端不根据按钮是否点过推测设备状态。约定二进制字节、时间戳和错误的表示，再由双方各自渲染；文本编码或行尾转换不能令两端看到不同的实际收发字节。队列、补流窗口和租约起止条件需在阶段 0 通过尖刺确定，不预设吞吐或延迟承诺。

状态和事件携带 `hostEpoch`、`connectionGeneration` 与单调 `seq`。附着返回与流一致的快照水位，之后订阅水位之后的事件；重连仅在身份相同且水位可用时有界补流，否则发 `gap` 并重新同步。慢读客户端队列有界，不阻塞设备读线程、日志或其他客户端。TX 保留发起者/请求标识，区分已提交、失败和 `unknown`（已知部分写入时报告字节数）；“已提交”不是设备 ACK。连接丢失或回执未知时禁止自动重发，不把旧操作转移到新连接。请求应先登记匹配再写入，并在该代次内等待 RX；串口没有通用应答 ID，自发输出也可能匹配，独占写段不保证严格关联。

```sh
hypercomctl ports
hypercomctl tail dut --format ndjson
hypercomctl request dut --text "AT" --eol crlf --expect-line "OK" --timeout 3s
```

`dut` 由 Host 配置映射到端口；`tail` 的 NDJSON 可供脚本消费；`request` 返回匹配结果或明确的超时、断连、写失败/未知状态，不依赖焦点或标签。只认 Windows `COMx` 的旧工具无法直接接入：需显式临时独占交接（Host 释放句柄并通知观察者中断，归还时换代；交接期间不保证观测第三方字节），或另做虚拟 COM/驱动。RFC 2217/串口 TCP 适用于原本就支持它的工具，不能替代虚拟 COM，也不能以二次打开实现共享。

**除了共享，CLI 还适合做什么？** 首版可用 `request` 的退出码判断 CI 冒烟成败；失败时可附 `tail` 取得的 Host 时间戳和限定区间的 RX/TX。第三方解析器可直接从 stdout 读 NDJSON，stderr 单独输出诊断，多数不需要 SDK。后续可探索 stdout 的原始 RX 字节模式，以及只读 `status` / `doctor`，用于查询当前写租约持有者、设备连接代次和事件缺口。这些是规划用途，不是现有命令或 SDK。

## 3. 配置、自动化与插件迁移

- **配置归属：** 主机保存端口绑定/连接默认值、命名会话、共享日志和 Host 自动化；办公室保存客户端配对配置、工作区、视图和显示偏好。不跨网读写整份桌面配置。办公室文件需显式上传，或使用所连 Host 颁发的有范围能力句柄，不能把办公室路径交给 Host 当成本地路径。
- **单一自动化负责者：** [useSerialReceive.ts](<../../src/hooks/useSerialReceive.ts>) 的 `useSerialReceive` 执行 RX 触发，[useCyclicSend.ts](<../../src/components/OperationPanel/hooks/useCyclicSend.ts>) 的 `useCyclicSend` 随 GUI 生命周期，[flowRuntime.ts](<../../src/utils/flowRuntime.ts>) 的 `isFlowRunning` 等守卫实现进程内独占。多个 GUI 订阅同一 RX 不应各自运行 trigger、流程或有副作用插件。迁移前仅指定一个负责者，或远程禁用这些能力；迁入后由 Host 任务持有租约。现有 [OperationPanel.tsx](<../../src/components/OperationPanel/OperationPanel.tsx>) `OperationPanel` 的参数同步 effect 会在聚焦已连真实端口后防抖重推 DTR/RTS；远程观察端须禁用该自动 effect，Host 仍须独立拒绝未授权控制。
- **区分三类命令：** [commandExecution.ts](<../../src/utils/commandExecution.ts>) 的 `executeQuickCommand` 是单步串口发送/参数步骤，循环延时语义仍复用 [flowSchedule.ts](<../../src/utils/flowSchedule.ts>) 的 `advanceFlow`；[serial.rs](<../../src-tauri/src/commands/serial.rs>) 的 `run_port_tool` 匹配已保存配置，执行关闭端口→运行→重开，不接受任意远端命令行；[plugin_shell.rs](<../../src-tauri/src/commands/plugin_shell.rs>) 的 `plugin_shell_execute` 是高权限本机执行，不是 v1 远程能力。办公室本地批准 `shell:execute` 不会投射到实验室；取消也不能假定回滚副作用或终止进程树。
- **插件先显示、后副作用：** 先复用办公室侧原生插件视图和展示类 Worker；无已验收原生载体的平台不降级为主窗 iframe。[view_runtime/mod.rs](<../../src-tauri/src/plugin/view_runtime/mod.rs>) 的 `create` 和 [pluginHost.ts](<../../src/utils/pluginHost.ts>) 的 `PluginSession` 继续区分原生文档身份、Worker 代次和安装授权。后续 Host 能力需有独立授权、任务所有者和撤销点；不转发任意插件 RPC，也不把网页消息、网络来源或办公室 UI 动作票据当作 Host 授权。旧插件不能安全复用时明确标为不可用，不静默扩权。

## 4. 拆单顺序与最低验收

| 阶段 | 内容与退出条件 |
| --- | --- |
| **0 · 单端口尖刺** | 先定 v1 生命周期、身份/代次、写租约、错误与恢复契约。可并行做虚拟线/夹具、真机 DTR/RTS 及拔插、用户会话边界探查；同时核对串口事件抽离后的主机日志。真机证明只有 Host 打开端口、慢观察不拖慢其他客户端、旧代次请求被拒。 |
| **1 · 本机 GUI + CLI** | 基于阶段 0 让二者接同一 Host。用 `dut` 实测 GUI 看 RX/TX、CLI 获得匹配结果、关闭 GUI 后 Host 继续收发并保留日志。再附着不重开；争用事务写段只阻塞或拒绝其他写方；断在写后回执前得 `unknown`，不重发。 |
| **2 · 办公室原生 GUI** | 沿用已通过本机验收的协议；配对/证书设计、连接适配和离线占位可先并行，开放远程前须通过认证、撤销与权限测试。验证观察员附着/切标签不改 DTR/RTS，越权控制被 Host 拒绝；断线恢复可补流或报 `gap`，不改用办公室 COM；未迁功能明确降级。 |
| **3 · Host 作业与进阶插件** | 在权限模型与 v1 端口语义稳定后加自动化所有者、任务生命周期和审计/诊断。多 GUI 不重复触发；撤权/换代不继续启动旧任务、不交付旧回执；上传/句柄与路径越界测试通过。COM 桥仅在确认第三方兼容需求后单独评估。 |

发布前另做三组对照：同端口单客户端与并发客户端的 RX/TX、日志完整性和断线恢复；只读、可写、可控制配对在同一 Host 上的正反例（包括在线撤销、错误证书与连接已更换）；GUI 退出、Host 重启及用户登出分别对任务和恢复的影响。重启后不能把上一代的任务或补流水位误认成仍然有效，也不能在没有明确持久化语义的情况下宣称任务可续跑。对依赖串口触发器和桌面脚本的工作台，明确列出已迁、需单一负责者和暂不可用三类，而不是远程连上就当作功能等价。

优先记录连接/租约变更、慢订阅 `gap`、任务归属和不确定结果，不默认把串口内容、认证材料或进程输出写入诊断日志。现有 mock IPC 测试适合回归界面和协议映射，不能替代两端真实客户端、串口设备和原生 WebView 验收。
