# HyperCom 本地、CLI 与远程访问统一设计方案

> **文档状态：设计提案；P1 基础切片已实现，完整远程方案仍未实现。**
> 编制日期：2026-11-17。
> 范围：本地 GUI、办公室远程 GUI、CLI、后续 SDK 的统一访问与管理。
> **当前实现仅为 P1 本机实验切片**：默认关闭的 loopback Host、同连接短租约 CLI、内存操作账本、普通原生发送的 `serial:tx`，以及 CLI 租约与桌面设备操作之间的端口级互斥。实验写入仅开发构建可用，还需 `HYPERCOM_AUTOMATION_UNSAFE_CONTROL=1`，身份仍未认证。`nativeGuiArbitration=true` 对应 `nativeArbitrationScope=desktop-native-vs-local-cli`：桌面原生操作作为一个本机执行类，内部仍使用现有规则，不代表桌面循环、插件和触发器已经获得独立的全事务租约。`hostId` 按配置实例持久化、`serverEpoch` 每次启动刷新；CLI 已支持只读端口状态快照与有界游标续传。该订阅只涵盖采样后发布的端口列表、连接状态及代次，不是 RX/TX 订阅或无损物理事件日志。TypeScript 适配层尚未接线；Windows Named Pipe、全事务执行器、远程 TLS 和独立 Host 尚未交付。

## 0. 结论与推荐决策

**可以实现，而且 CLI 与远程使用应共用一套服务模型，不能各做一条控制旁路。**

产品定位建议为：

> HyperCom 是一个同时面向人工调试与自动化的串口工作台。设备所在电脑运行串口宿主；本地 GUI、远程 GUI、CLI 和 SDK 通过统一接口访问该宿主。宿主统一管理连接、操作权、收发事实、日志及明确托管的任务；客户端保留独立的界面和工作区。

推荐决策如下：

| 编号 | 决策 | 原因 |
|---|---|---|
| D1 | 同一物理串口只由一个宿主持有 | 避免 GUI、CLI、桥接工具争抢 COM 句柄 |
| D2 | 先统一领域服务，再扩展调用入口 | 本地与远程共用业务规则，不原样公开任意 Tauri invoke |
| D3 | 首版服务内嵌现有实验室 HyperCom 进程 | 复用已有串口和日志，不第一步拆 Windows Service |
| D4 | 首版做远程 TRX + 小而完整的 CLI 闭环 | 优先解决办公室不用 RDP 调试设备，而不是先铺满命令 |
| D5 | 从第一天引入主机身份、连接代次、服务启动身份 | 防同名 COM3、服务重启和迟到请求串线 |
| D6 | 多个观察者、一个有效写入者；协作以短事务交接 | 共享读取容易，主动自动化与手动发送必须仲裁 |
| D7 | 物理连接、客户端会话、控制租约、任务四者分离 | 退出 CLI 或办公室断网不应误关实验室串口 |
| D8 | 远程传输默认加密、认证、按端口授权 | 内网、VPN、loopback 都不能替代应用权限 |
| D9 | 不同步整个 GUI，不透明迁移插件、文件和 shell | 设备会话共享不等于远程桌面镜像 |
| D10 | 真正无人值守后置，但服务接口和任务归属提前设计 | 避免伪 headless，也避免后期全部推倒 |

### 首版交付的一句话定义

**实验室打开 HyperCom 并启用共享，办公室 HyperCom 经认证连接后，可以查看端口、取得控制权、打开/关闭、配置串口、手动收发文本和 HEX；CLI 可对同一宿主查询、监听和发送；断网、竞争、发送未知结果均明确可见。**

实验室既有桌面自动化必须受同一仲裁约束，但首版不承诺所有循环、触发和插件已经转成独立后台任务。

---

## 1. 目标场景与非目标

### 1.1 必须解决的场景

1. **本机自动化与手调共存**：脚本只读监控串口，GUI 同时观察和发送；退出脚本不关闭 GUI 的连接。
2. **办公室访问实验室设备**：实验室持有真实串口；办公室运行自己的 HyperCom，不传输整桌面像素。
3. **办公室 CLI 自动化**：同一 CLI 用显式目标切换本机、实验室主机，不要求办公室 GUI 必须运行。
4. **多人或多工具观察**：多个客户端独立接收同一数据流，慢客户端不拖住其他人。
5. **自动化与人工交接**：主动查询、循环、特殊操作不会与人工指令无规则混写。
6. **异常可追溯**：能知道哪台主机、哪个客户端、哪个操作发送了什么，哪些结果确定、哪些仍未知。
7. **后续无人值守**：有明确升级路径让实验室任务不依赖办公室在线，最终也不依赖实验室 GUI。

### 1.2 不应混同的承诺

| 用户感受或诉求 | 本方案的准确含义 |
|---|---|
| 像本地操作 | 基本串口操作和数据显示接近本地体验，不等于网络无延迟 |
| 远程 HyperCom | 访问远端设备会话，不默认同步远端窗口布局、焦点、草稿和任意插件 DOM |
| 共享串口 | 一份物理连接，多份订阅；写入由单一权威协调，不是多个程序各自打开 COM |
| 暂停自动化 | 停止后续自动发送，不等于设备已停止运动、执行或采样 |
| 关闭办公室窗口 | 断开该客户端，不默认关闭实验室设备连接 |
| 后台运行 | 必须区分托盘中的桌面宿主和真正无 GUI 的宿主进程 |
| 发送成功 | 宿主已确认完成其驱动写入过程，不证明设备业务命令执行成功 |

### 1.3 首版非目标

- 替代 Windows 系统管理、软件安装、任意远程桌面操作。
- 让所有未修改的第三方串口软件自动看到一个虚拟 Windows COM。
- 公网穿透、云中继、账号平台、跨组织多租户系统。
- 任意远程 shell、任意磁盘路径浏览或插件权限透传。
- 任意插件界面、登录状态或原生对话框远程同步。
- 硬实时发送、永久无损历史、不可逆设备操作的 exactly-once 保证。
- 首版同时完成全部平台、全部网络协议和全部自动化运行时迁移。

---

## 2. 当前架构证据与改造约束

以下为本轮实际源码与架构文档核对所得，和后续设计建议分开。

| 现状 | 证据与符号 | 设计约束 |
|---|---|---|
| 应用是 Tauri 桌面入口，已有 `--config` 与配置实例锁 | [应用入口](<src-tauri/src/lib.rs>)：`AppState::new`、`acquire_instance_lock`、`run`；[主程序](<src-tauri/src/main.rs>)：`main` | CLI 不应初始化第二套 owner 或并发写同一配置目录 |
| 真实串口已有读写分离、代次、写租约及关闭屏障 | [串口管理](<src-tauri/src/serial/mod.rs>)：`SerialManager`；[串口架构](<docs/architecture/serial.md>) | 保留成熟的驱动生命周期，不为网络重写 I/O |
| 前端服务直接调用本地 Tauri | [串口服务](<src/services/serial.ts>)：`serialService`；[事件服务](<src/services/event.ts>)：`eventService` | 现有 invoke/listen 不是可直接供独立 CLI 使用的网络协议 |
| 端口身份目前是裸 `COM3` | [类型定义](<src/types/index.ts>)：`SerialPort`、`TabItem` | 多主机必须隔离端口身份；标签 UUID 不能代替设备身份 |
| 发送守卫、TX 回显和部分统计在前端 | [发送 hook](<src/hooks/useSerialSend.ts>)：`sendToPort`；[流程运行态](<src/utils/flowRuntime.ts>)：`statuses`、`isFlowRunning` | 本地与远端的最终权限和仲裁必须下沉到共同服务 |
| 原生普通发送无跨客户端控制租约，数据事件只有 RX | [串口命令](<src-tauri/src/commands/serial.rs>)：`send_serial_data`；[串口事件](<src-tauri/src/serial/events.rs>)：`SerialDataEvent` | 需增加权威 TX/操作事件和来源关联，不能让 CLI 绕过 GUI 保护 |
| 循环、触发、重连调度包含前端生命周期状态 | [收发架构](<docs/architecture/transmission.md>)；[连接运行态](<src/utils/serialConnectionRuntime.ts>)：`runReconnectLoop` | 不能只开放 Rust 命令就宣称完整 headless |
| 插件 Worker 在主窗，原生权限绑定主窗及安装身份 | [插件架构](<docs/architecture/plugins.md>)；[插件宿主](<src/utils/pluginHost.ts>)：`PluginSession` | 远程用户身份不能伪装为主窗口或插件身份 |
| GUI 行流会过滤/组行，现有日志不等于原始事件档案 | [接收管线](<src/utils/rxPipeline.ts>)：`RxPipeline.enqueueRxLine`；[日志 writer](<src-tauri/src/logger/writer.rs>)：`write_line` | 远程原始数据在 native 收字节路径分发，完整 capture 另设明确格式 |
| 文件发送使用 native 所在机器的路径 | [串口命令](<src-tauri/src/commands/serial.rs>)：`SendFileArgs`、`send_file`、`run_port_tool` | 办公室文件不能仅传路径让实验室读取 |
| 真正退出应用会收尾串口；隐藏到托盘保留 WebView | [应用入口](<src-tauri/src/lib.rs>)：`request_shutdown`；[关闭命令](<src-tauri/src/commands/system_cmds.rs>)：`complete_editor_close` | 内嵌服务阶段仍依赖实验室宿主进程存活 |
| 生产 CSP 限制 WebView 外连 | [Tauri 配置](<src-tauri/tauri.conf.json>)：`app.security.csp` | 优先让本机 Rust 网络适配器负责远端连接，不用通配 CSP 解决 |

所有跨模块实现应继续遵循 [复用索引](<docs/architecture/code-map.md>)：复用字节编码、HEX、边界、配置 revision CAS、顺序调度、日志入口和连接代次，不平行复制一套实现。

---

## 3. 统一逻辑架构

### 3.1 四个产品角色

- **Host／设备宿主**：运行在设备所在电脑，独占串口，是设备会话的权威。
- **GUI Client／图形客户端**：可位于宿主本机，也可位于办公室；维护自己的显示与工作区。
- **CLI Client／命令行客户端**：独立 console 程序，直接连接目标宿主，不借用办公室 GUI 的当前标签。
- **SDK Client／程序客户端**：后续 Python 等语言封装，与 CLI 使用同一协议。

一台 HyperCom 可以同时承担本地 Host 和多个远端的 GUI Client，但职责和身份必须分开。不能为了访问远端再实例化一套远端的真实串口驱动。

### 3.2 服务内部层次

| 层 | 职责 | 不承担什么 |
|---|---|---|
| Serial Driver | 真实串口、读写句柄、codec、写期限、关闭屏障 | 用户权限、UI 布局 |
| Port Service | 连接状态、实际参数、代次、原生重连策略 | 前端焦点或显示过滤 |
| Operation Arbiter | 准入、有效写入者、租约、短事务、取消、接管屏障 | 网络握手、JSON 排版 |
| Event/Operation Registry | RX/TX/状态事件、有限续传、操作结果与去重 | 永久无损采集承诺 |
| Job Runtime | 已支持的任务类型、执行快照、暂停/停止、任务归属 | 首版替代所有旧前端引擎 |
| Domain API | 版本化查询/控制/订阅契约，统一权限检查 | 任意 Tauri 命令转发 |
| Transport Adapter | 本机 IPC、远端加密连接、身份建立 | 再实现一套业务仲裁 |

### 3.3 第一阶段部署形态

服务内嵌实验室现有 HyperCom 的 Rust 进程，复用串口和日志。实验室 GUI 的本地 invoke 经领域适配进入相同 Core；本机 CLI 经 IPC；办公室 GUI/CLI 经网络适配器。

**本地 GUI 不必为了“形式统一”绕一次网络，但必须经过相同领域准入、控制权和执行路径。**

办公室 GUI 建议继续通过本机 Tauri 服务层操作；本机 Rust client adapter 根据目标选择本地 Core 或远端连接，把远端事件规范化后交给前端。凭据、TLS 校验、连接恢复和二进制网络帧优先留在 Rust 层。该建议不表示 Rust 自动受 CSP 保护，网络协议本身仍必须认证授权。

CLI 可以直接连接实验室 Host，不要求办公室 HyperCom 已启动。连接本机内嵌 Host 时，宿主桌面应用必须已运行；不存在时返回明确错误，或由用户显式启动，不偷偷改变系统服务配置。

### 3.4 最终部署形态

长期把相同 Core 放入独立 `hypercom-host` 用户态进程；GUI 成为可选客户端。只有明确需要无人登录启动、系统级恢复时，再提供 Windows Service 包装。

宿主拆分同时处理配置/日志目录所有权、安装升级、凭据、进程实例锁和退出顺序，不能让旧 GUI 和新 Host 同时抢同一端口或同一数据目录。

### 3.5 统一的是契约，不是整份界面状态

共享：连接、实际参数、收发事实、控制者、任务进度、宿主日志与采集。

默认不共享：窗口布局、主题、缩放、搜索条件、滚动位置、未保存草稿、当前选中标签。

命令集、协议模板等可以作为显式版本化资产导入/导出或发布，但不通过整份客户端配置覆盖远端宿主。

---

## 4. 网络与隧道选择

### 4.1 正式方向

- Windows 本机访问：Named Pipe，并配置当前用户/授权用户 ACL 和会话校验。
- Unix 本机访问：后续 UDS 适配，不阻塞 Windows 首版。
- 远端访问：优先一套 TLS 保护的双向应用连接，建议评估 WSS；控制消息和字节数据使用同一领域模型。
- 企业 VPN：解决跨网可达性，仍保留应用认证和端口权限。
- 已批准的 SSH：可转发 Host 的 loopback TCP 适配器，作为早期验证或部署选项。

**普通 SSH `-L` 转发的是 TCP/Unix socket，不是 Windows Named Pipe。**如果本机默认只有 pipe，SSH 方案需要显式启用 loopback TCP adapter，不能写成“直接转发本机 pipe”。

首版不同时承诺支持所有 transport；推荐先完成 Windows pipe + 一种远端 TLS 适配。SSH/VPN 是部署方式，不是第二套业务协议。

### 4.2 为什么不以裸 TCP 或 RFC2217 作为主方案

裸 TCP 只能传字节，不自带端口枚举、实际参数、操作结果、控制权、日志与任务。

RFC2217 能传输波特率、数据位、校验、控制线等，是未来第三方兼容适配的候选，但它不是 HyperCom 会话管理协议，也不会自动提供本方案的控制租约、请求账本和可靠历史语义。常见 pySerial 实现还明确提示无认证、无加密及网络延迟限制。

因此可以用字节桥做内部连通性实验，但不要把这个实验当成最终“远程 HyperCom 已完成”。

### 4.3 公司网络假设

当前没有验证公司网络拓扑。能用 RDP 不证明能直接访问实验室新增端口：可能存在 RD Gateway、VLAN、防火墙或仅开放 RDP 的策略。

实施前需确认：直接可达的地址/端口、是否允许安装或启动宿主、是否允许入站规则、已有 VPN/SSH 是否获准。方案不默认修改公司防火墙、不建议绕过 IT 策略，也不默认引入第三方公网中继。

---

## 5. 身份模型

| 身份 | 定义 | 解决的问题 |
|---|---|---|
| `hostId` | 宿主持久稳定身份；网络地址与显示别名不是身份 | IP 改变、同名主机、目标混淆 |
| `serverEpoch` | 每次服务启动的新身份 | 宿主重启后代次从头计数造成 ABA |
| `PortRef` | `{hostId, nativePortId}` | 本机 COM3 与多台实验室 COM3 冲突 |
| `PortKey` | 客户端用于 Map/store 的不透明编码 | 不把显示标签拼接串误传给驱动 |
| `connectionGeneration` | 宿主原生连接代次 | 旧发送误作用到关闭重开后的连接 |
| `clientSessionId` | 一次通过认证的客户端会话 | 断网重连及迟到响应隔离 |
| `principalId` | 由可信认证层建立的用户/客户端主体 | 不能信任客户端自称 main/admin |
| `leaseId / fence` | 控制租约及单调隔离令牌 | 旧控制者排队请求在交接后复活 |
| `requestId / operationId` | 客户端请求关联及服务端操作记录 | 去重、结果查询、日志关联 |
| `jobId` | 明确任务实体 | 任务不依附某个窗口标签 |
| `cursor` | 有作用域的事件续传位置 | 重连恢复，不使用 GUI 行号当历史位置 |

执行请求至少绑定 Host、serverEpoch、目标 PortRef；涉及已有连接的副作用还绑定 connectionGeneration 和有效控制身份。打开连接使用观察到的端口状态版本/最近代次作为前置条件，不把“还没有活动连接”解释为无需竞争保护。

本机实现将 `hostId` 存在实际配置文件旁的 `<配置文件名>.host-identity.json`，与常规设置导入导出分开；换用另一份配置会使用另一份身份。重启生成新的 `serverEpoch`。身份文件存在但损坏或不可读时，保留文件并禁用实验监听，不用新的 ID 冒充原实例，桌面功能仍可使用。该 ID 用于隔离资源，不等于认证凭据或 USB 设备标识。

到串口驱动边界时只传 nativePortId，例如 COM3，不传 `lab/COM3` 或网络 URL。现有 `PortKind::of` 仍只处理 owner 本机端口类别。

COM3 是 OS 路由名，不是设备永久身份。USB 序列号等可作为后续辅助识别，但重复、缺失或设备替换时需要明确处理，不能自动向可疑新设备重放旧工作。

---

## 6. 运行态必须分开管理

| 对象 | 建议状态或属性 | 退出/断开含义 |
|---|---|---|
| Host 连接 | connecting / online / recovering / offline；snapshotFreshness | 办公室网络状态，不证明实验室串口状态 |
| 物理端口会话 | closed / opening / open / closing / error；generation | 宿主实际持有的串口连接 |
| 客户端订阅 | starting / live / replaying / gap / ended | 只影响该消费者 |
| 控制租约 | requested / granted / revoking / draining / released / expired | 控制资格；过期不默认关闭串口 |
| 操作 | accepted / queued / executing / succeeded / failed / cancelled | 服务端执行进度 |
| 操作结果可信度 | known / unknown / partial | 客户端是否已获知结果，与服务端执行状态不同 |
| 自动化任务 | pending / running / pausing / paused / stopping / completed / failed / interrupted | 任务自身生命周期，不等于设备业务状态 |

网络断开时保留最后已知端口快照并标记陈旧，禁用新的远端控制。不得把 Host 不可达当成“远端没有端口”，喂给现有端口合并逻辑导致端口、历史和配置被清空。

断开 Host、关闭串口、停止任务、停止 Host 是四种不同动作，GUI 和 CLI 必须使用不同文案与命令。

---

## 7. 统一控制权与人机协作

### 7.1 不变量

**每个端口在任一时刻最多有一个有效写入者。**观察者可以有多个。这里的“写”包括发送、改参、DTR/RTS、打开/关闭、文件发送和工具接管等设备副作用。

控制权不能只在 UI 检查。服务端在入队和真正执行前复核：权限、租约/fence、连接代次、任务状态和服务 shutdown 准入。

现有本地 Tauri、TTY、文件、循环、触发、插件入口全部纳入，不允许“本地 GUI 特权绕过”。前端守卫继续提供即时反馈，但不是最终权威。

### 7.2 三种使用模式

| 模式 | 控制权方式 | 人工操作策略 |
|---|---|---|
| 只读观察 | 无写租约；订阅已存在会话 | 不干扰人工；订阅不隐式 open 或改信号 |
| 协作操作 | 每次操作/查询取得短租约，完成释放 | 人工可在事务边界取得控制权 |
| 持续独占 | 明确持有租约，例如 TTY 交互或完整升级事务 | 其他写请求返回忙；接管需要明确权限和交接 |

普通 GUI 打开一个视图，不应永久占住写权。普通发送使用短操作；`query` 的租约覆盖“准备观察—发送—等待匹配响应—收尾”，不是只包一次 write。

主动采样采用短事务：每次采样完成释放，错过的周期不集中补发。一次采样未结束时不堆积下一批采样。需要不中断整个协议流程时，任务必须显式使用独占模式。

### 7.3 人工优先不是任意抢写

- 看日志、切标签、搜索不自动算接管。
- 人工发送遇到协作任务时，可请求“暂停自动发送并操作”；服务暂停该任务的新准入，在当前事务边界交接。
- 暂停或接管他人任务必须有权限，不能因为是 GUI 请求就绕过所有者。
- 普通 CLI 忙时默认明确失败；可显式等待，等待时间有界、可取消，不无限排队。
- 恢复自动化默认显式进行，不猜测“用户几秒没操作就自动恢复”。

聚焦端口造成的隐式 DTR/RTS 重施也属于副作用，必须改为基于权威状态的明确同步或经控制准入，不能让观察者切标签改变实验设备。

### 7.4 任务与租约不能产生双写主

区分“谁拥有任务管理权”和“谁当前有权写端口”。

- **客户端附属执行器**：例如现有 GUI 循环。可以获得父客户端租约的受限委派；寿命不得超过父租约和连接身份。子执行器独占时，父客户端不能持同一凭证插写。
- **Host 托管任务**：显式创建后，由任务实体成为执行所有者，服务维护其控制权；原客户端保留查看/暂停/停止权限，不保留第二份有效写令牌。
- 协作 Host 任务在两次事务之间释放实际写权，下一次按策略重新申请；独占 Host 任务在整个事务期间保持唯一有效写权。
- 从客户端附属任务转为 Host 托管必须是明确、原子的交接，不自动因断网而提升权限。

Host 托管仅表示脱离发起客户端连接，**不自动表示可跨 Host 进程崩溃或重启恢复**。跨重启恢复属于后续单独能力，默认重启后任务为 interrupted，不自动恢复设备副作用。

### 7.5 接管与过期

交接顺序：

1. 验证接管权限与目标版本。
2. 冻结旧 holder，推进 fence，拒绝新准入。
3. 取消未开始请求，停止旧执行器产生新工作。
4. 等待已开始 I/O 到达可收尾边界。
5. 明确完成/失败/部分写入结果后，再授予新 holder。

无法收尾时，不得边等待边允许新控制者写入；显示 draining/failed，提供单独的显式断开或管理员处置。不能回滚已发字节，也不能以“租约到期”假装物理 I/O 已不存在。

租约过期默认保留物理连接与采集，不暗拉 DTR/RTS。设备安全动作如急停必须由设备协议或硬件机制保证，不能把网络租约当安全联锁。

---

## 8. 统一 API 与传输契约

### 8.1 最小领域 API

| 分组 | 拟议操作 | 最小版本 |
|---|---|---|
| Handshake | GetHostInfo、GetCapabilities、Authenticate | V1 |
| Targets/Ports | ListPorts、GetPortSnapshot、WatchPortState | V1 |
| Control | AcquireControl、RenewControl、ReleaseControl、RequestTakeover | V1 |
| Serial | OpenPort、ClosePort、SetParams、SetSignals、Send | V1 |
| Operations | GetOperation、CancelOperation | V1 |
| Events | Subscribe、Unsubscribe、ResumeCursor | V1，有限保留 |
| Query | Expect、Query | V1.1 |
| Jobs | StartJob、GetJob、PauseJob、ResumeJob、StopJob | V2，按能力类型 |
| Capture | StartCapture、GetCapture、StopCapture、ExportCapture | V2 |
| Artifacts | BeginUpload、UploadChunk、CommitArtifact、Download | V2 |
| Configuration | GetScopedConfig、ValidatePatch、ApplyPatchWithRevision | V2 |
| Extensions | ListActions、InvokeDeclaredAction | 后续、显式授权 |

“最小版本”是本提案里程碑，不是当前软件版本号。网络公开面是上述领域操作的受限集合，不通过字符串任意调用现有命令。

### 8.2 版本和能力握手

握手返回：协议主/次版本、hostId、serverEpoch、服务运行形态、支持能力、允许的数据格式、有效消息边界、事件保留策略及当前主体授权范围。

- 主版本不兼容时明确拒绝。
- 缺少具体能力时隐藏/禁用对应控件，并返回 UNSUPPORTED_CAPABILITY。
- CLI 不靠 GUI 版本号猜功能。
- 同一 API 的本地/远程 adapter 使用相同错误码和副作用语义。

### 8.3 请求结构示意

```json
{
  "protocolVersion": 1,
  "requestId": "client-generated-uuid",
  "method": "serial.send",
  "target": { "hostId": "stable-host-id", "nativePortId": "COM3" },
  "precondition": { "serverEpoch": "boot-id", "connectionGeneration": "7" },
  "control": { "leaseId": "lease-id", "fence": "12" },
  "timeoutMs": 3000,
  "params": { "dataBase64": "c3RhdHVzDQo=" }
}
```

这是说明关联关系的草案，不是最终 JSON Schema。principal、可信来源和权限由认证上下文产生，不接受客户端自报后直接采用。长整数在线上可用十进制字符串避免 JS 精度问题。

控制消息可使用版本化 JSON；高频 RX/TX 字节优先使用有界二进制批帧，不把大块数据长期展开为 JSON 数字数组。CLI 对外 NDJSON 可用 base64，这是输出格式选择，不要求 GUI 网络链路也这样编码。

文本/HEX 模式应复用宿主统一 codec 构造实际上交驱动的字节和行尾；客户端预校验只用于提前反馈，不另建一份权威编码逻辑。上述示例表示显式 raw 模式，raw 内容不再追加行尾或进行文本转换。不同输入模式互斥，TX 事件使用实际写入载荷，而不是重新按 UI 输入估算。

### 8.4 错误模型

建议稳定错误类别：INVALID_ARGUMENT、UNAUTHENTICATED、PERMISSION_DENIED、HOST_UNAVAILABLE、PORT_NOT_FOUND、PORT_BUSY、CONTROL_LOST、STALE_SESSION、REQUEST_ID_CONFLICT、DEADLINE_EXCEEDED、CANCELLED、IO_ERROR、OUTCOME_UNKNOWN、CURSOR_EXPIRED、STREAM_GAP、UNSUPPORTED_CAPABILITY、CONFIG_CONFLICT、SHUTTING_DOWN。

错误包含 code、stage、operationId、已知副作用与可诊断文本。`retryable` 不应被解释为“可自动重发设备命令”；必须单独区分可重试连接/查询与可重试物理副作用。

保留现有领域错误映射，不用可读字符串解析代替结构化契约。

---

## 9. 操作结果、取消与去重

### 9.1 四层确认

1. 客户端已生成意图。
2. 宿主已接受操作。
3. 宿主确认写入过程完成，或报告失败/部分写入。
4. 设备协议确认业务结果。

前三级均不能自动等同第四级。UART 驱动写入完成也不能被描述为已经精确测得每一字节到达设备并执行。

GUI 可以先显示 pending 意图，但必须用 operationId 与服务权威结果合并；不能先算一次 TX，权威事件回来后再算一次。其他客户端 TX 也通过同一事件展示。

### 9.2 结果查询与有限去重

- requestId 由客户端生成，在重连期间保持。
- 服务按认证主体 + requestId 建立记录，并验证操作及载荷摘要。
- 相同请求返回原操作状态；同 ID 不同载荷明确拒绝。
- 去重记录有明确保留窗口和容量边界，由能力接口说明。
- 丢 ACK 后先查询原 operation/request；只有服务能证明未接受/未开始时，才按用户策略决定重新执行。
- 超过保留窗口、服务 epoch 改变或崩溃窗口无法判断时，报告结果未知，不换 ID 盲发。

持久化记录也不能让“串口写入”和“账本提交”成为设备侧原子事务。没有设备协议幂等键或状态核验，就不能承诺物理 exactly-once。

### 9.3 部分写入

统一结果需表达已知写入字节数及其可信度。普通发送应保留底层可获得的 partial 计数，不能把所有错误都视为 0 字节。底层无法确定时使用 unknown，而不是编造数量。

日志也应区分成功、失败、部分和未知，不能只在完整成功时记录而把失败期间可能的副作用完全隐藏。

### 9.4 超时和取消

- CLI 的总等待期限可包含连接与网络等待。
- 服务端接收后用自己的单调时钟执行相对预算，包含服务队列、调度和操作等待；不能直接信任客户端墙钟绝对时间。
- 到期先阻止未开始工作、请求取消在途工作；已开始写入不保证可立即中止，继续收尾并可由 operationId 查询。
- Cancel 与 Start 的竞争由服务端原子判定；返回 cancel-requested 不等于 cancelled。
- Ctrl+C 默认取消当前 CLI 操作或退订；不默认关闭端口、停止所有客户端或终止独立 Host 任务。
- 长订阅可持续运行；总时长与无数据超时是不同选项，设备安静不自动视为故障。

---

## 10. 权威事件、重连与历史

### 10.1 事件来源

服务在接收字节、操作开始/结束、连接和租约变化处产生权威事件。至少包含：

- hostId、serverEpoch、nativePortId、connectionGeneration；
- 事件 seq、cursor、类型、时间；
- RX/TX 原始字节或对应二进制 payload；
- 来源、clientSession、operationId、jobId（适用时）；
- replay/live 标识及 gap 信息。

时间使用实验室接收/处理时刻，不用办公室到达时间替换；它不是硬件每字节采样时间。单 Host 的持续时间由单调时钟计算；多 Host 时间联动必须明确时钟映射与误差，不默认达到硬件同步。

TX-started 应能先于相关响应的观察表达发送意图；TX-completed 可能晚于快速 RX 到达。不要靠客户端时间戳排序把真实事件重排成看似完美的因果关系。

### 10.2 原子快照与订阅

订阅准备返回一致的状态快照和水位线，再衔接该水位之后的事件；或者在服务端先登记订阅再发送匹配快照。不能先普通查询、再另起监听而留下丢事件窗口。

权威快照包括连接、实际参数、控制者、任务、重连状态，而不只是枚举得到的端口名称。

### 10.3 断网恢复

1. UI 标记 transport offline / snapshot stale，禁用远端控制。
2. 不因此关闭实验室端口，不复位信号线。
3. 重连认证，校验 hostId 和 serverEpoch。
4. 同 epoch 且 cursor 仍有效时补历史；否则报告 gap 并重取快照。
5. 重新取得控制资格；旧租约、旧排队发送不自动复活。
6. 查询未决操作，再决定用户下一步；不盲目重发。

服务重启时，旧客户端身份、连接代次组合和租约一律失效。客户端不能仅比较 generation 数字恰好相同就认为还是原连接。

### 10.4 重放不得产生副作用

补播数据只用于显示、记录恢复和明确声明的离线分析，不再次进入自动回复、循环触发或插件自动发送通道。

现有前端自动化若仍作为 attached executor，需要单独的 live-only 输入起点；断网缺口默认暂停该执行器并给出原因，而不是带着缺失上下文继续操作。

客户端统计去重；服务接收统计不因增加订阅者或重放而翻倍。

### 10.5 背压和历史边界

- 每客户端独立有界队列，字节流溢出明确报告 gap 或断开慢消费者。
- 慢办公室网络不得阻塞串口 reader、其他客户端或放大为无限内存。
- 控制/取消消息有独立调度优先级，不能被大段采集下载长时间淹没。
- 首版只保证有限内存续传；断网超过保留窗口会有缺口。
- 宿主日志、原始 capture 和订阅环形缓冲是三种不同机制。当前格式化日志不能自动补成精确原始事件。

---

## 11. 自动化运行位置与能力矩阵

### 11.1 三种执行位置

| 类型 | 运行位置 | 客户端断开 | Host 重启 |
|---|---|---|---|
| 外部脚本/SDK 调度 | 脚本所在电脑 | 脚本自理；旧控制请求不得续发 | 旧会话失效，不自动重发 |
| desktop-attached | 指定主 WebView，例如现有循环/触发/Worker | 依赖该执行器、会话与权限；不承诺继续 | 停止或 interrupted |
| host-owned | Host 的明确任务运行时 | 按创建时策略继续或停止 | 默认 interrupted；恢复另行支持 |

任务显示执行位置，例如“实验室 A / desktop-attached”或“实验室 A / host-owned”，不能只显示含糊的“后台”。

### 11.2 迁移能力矩阵

| 能力 | 当前事实 | V1 设计目标 | 后续目标 |
|---|---|---|---|
| 串口读写/连接 | Rust 实现，部分控制依赖前端 | Core 权威并接入所有本地来源 | 独立 Host 可直接运行 |
| 日常串口日志 | Rust 生命周期管理 | 实验室继续按宿主配置记录 | 原始 capture、下载与索引 |
| 自动重连 | 前端调度 + 原生单次尝试 | 不复制多个 supervisor；明确 attached 限制 | 原生单一 supervisor |
| 旧命令集循环 | React 生命周期 | 本地兼容且受 Core 仲裁；不提供伪后台远程启动 | 提取执行器、固定快照任务 |
| 行触发自动回复 | 前端行管线 | 仅指定执行器；旁观客户端不复制执行 | 服务 live 流上唯一执行 |
| 插件 Worker | 主窗 Worker | 不透明迁移，不自动在远端安装或执行 | opt-in 宿主动作/运行时 |
| TTY | 客户端 xterm 与键盘队列 | 远程 V1 暂不承诺；本地保留并受仲裁 | 独占终端输入、应答与重连验收 |
| 无人登录运行 | 无现成入口 | 不支持 | 独立 native Host + 服务部署 |

### 11.3 Query 与测试能力

`expect` 仅观察；`query` 在服务端建立观察边界后发送，持有短事务直到匹配/失败/超时。匹配必须能跨 RX chunk，chunk 不是协议帧。

通用文本/HEX 匹配只证明出现了符合条件的数据。存在回显、异步上报或多设备协议时，使用协议适配器中的帧与事务号关联，不能把任意 OK 当成因果证明。

精密周期和低延迟闭环应尽量靠近设备运行；普通 Windows 用户态任务仍不是硬实时。复杂业务逻辑优先使用 Python/pytest 等现成生态，不首版自造通用脚本语言。

---

## 12. 配置、文件、日志和插件归属

### 12.1 配置分域

| 域 | 例子 | 权威位置 |
|---|---|---|
| Client preferences | 主题、字体、布局、搜索、显示过滤、目标别名 | 每个客户端本机 |
| Host settings | 共享端口、网络绑定、日志目录、连接策略 | 实验室 Host |
| Automation catalog | 已发布命令集、规则、设备预设版本 | 显式指定的本地或 Host 资产库 |
| Runtime snapshots | 任务启动快照、运行进度、租约 | Host 内存/任务记录 |
| Secrets/grants | 配对凭据、私钥、插件授权、目录 grant | 各自安全存储，不自动复制 |

延续现有配置队列与 revision CAS，按作用域提交。远端配置编辑后续使用字段/实体级 patch 与期望 revision；不得整份上传办公室配置，覆盖实验室日志路径、安装权限或工具程序。

当前配置迁移保留旧本地语义；旧裸端口引用明确绑定 local Host。不能把现有插件白名单中的 COM3 自动扩展为所有远端 COM3。

### 12.2 文件操作

文件参数必须区分位置：

- 客户端路径：只由客户端读取，用于上传或本地导出。
- Host artifact：服务授权的、不透明资源 ID。
- Host 内部路径：仅宿主配置和内部实现使用，不因知道字符串就获得访问能力。

后续发送文件建议流程：办公室选择文件 → 分块上传到受控 staging → 完整性校验与提交不可变 artifact → 申请控制权 → Host 文件发送任务。

日志下载反向进行：选择授权日志/采集资源 → 分块下载 → 办公室本地 Save As。不能在实验室弹一个看不到的文件选择器却让办公室 CLI 永久等待。

文件暂存的容量、并发、清理和取消策略单独定义；这些是新远程接口的资源管理，不擅自改变现有插件文件 API 的既有能力契约。

### 12.3 外部工具

需要本地 COM/USB/驱动的烧录器应在实验室执行，调用已配置 toolId 和明确 artifact，而不是允许远端提交任意 shell command。

工具接管可能需要关闭串口，因此采集存在明确间隙，不能承诺全程连续监听。工具结束后的恢复与失败均由 Host 记录。远程工具不进入 V1。

### 12.4 插件

分开客户端 UI/分析插件与 Host 自动化扩展。必须显示执行在哪台机器、由哪个运行时承载、具有什么权限。

现有 installGeneration、启用状态、权限快照和目录授权继续有效，但不会自动变成远程 shell、文件或宿主管理权限。不能把办公室 Worker 的 fs/shell 调用无声地移到实验室执行。

未来插件可显式声明结构化动作和模型，用统一 API 调用；不传 DOM、不自动复制 trusted-web 登录态、不把两个同版本插件副本当成同一个运行实例。

### 12.5 TTY 专项边界

远程 TTY 不等于远程 Windows shell，而是远端串口字节的终端呈现。多个终端模拟器可能对查询自动应答，因此不仅键盘，终端自动应答和尺寸变化也必须有唯一有效控制者。

只读终端不得偷偷回写查询应答；新加入客户端没有完整历史时，不保证恢复相同全屏状态。后续需定义独占输入、有限回放/快照、屏幕恢复提示、失租丢弃旧按键和必要应答策略，再宣称支持 vim/top 等交互。V1 先完成 TRX。

---

## 13. GUI 统一管理体验

### 13.1 资源组织

侧边栏按 Host 分组：本机、实验室 A、实验室 B。每个 Host 显示连接状态、运行形态、权限摘要；其下显示端口。

端口标签必须可辨别来源，例如“实验室 A · COM3”，但内部使用结构化身份。每个 Host 的列表失败只影响该 Host，不把其他主机状态合并或清空。

### 13.2 统一管理页

| 区域 | 展示与操作 |
|---|---|
| 连接 | Host 地址/身份、证书指纹、协议版本、连接质量、重新连接 |
| 会话 | 实际串口参数、连接代次、已订阅客户端、控制者 |
| 自动化 | 运行位置、任务快照、阶段、暂停/停止/接管 |
| 记录 | TX/RX 来源、操作结果、丢失区间、日志与采集资源 |
| 权限 | 已配对客户端、端口范围、撤销与管理审计 |

不是每个区域都在 V1 全量实现，但信息模型从首版一致。

### 13.3 关键交互

- 首次连接：明确确认实验室 Host 身份/证书，授予所需权限。
- 只读连接：看流不打开设备、不改 DTR/RTS、不自动启动回复规则。
- 发送：pending → 宿主确认/失败/未知；显示来源和目标。
- 冲突：显示控制者与用途，提供等待、暂停协作任务、申请接管，而非假发送。
- 网络断开：保留画面并标注“与实验室失联，设备状态未知/最后已知”；禁用写入。
- 重连：展示恢复范围或缺口，不自动恢复旧发送队列。
- 退出办公室 GUI：仅 detach；若有 attached 执行器，明确说明将停止。
- 退出实验室内嵌 Host：显示远端客户端和任务影响，遵循原有编辑保存审批与统一 shutdown。

TTY 的来源记录使用独立侧栏/事件，不向终端字节流插入说明文字。

---

## 14. CLI 与 SDK 统一设计

### 14.1 目标选择

全局 `--target local|<alias>` 指定宿主，默认 local。自动化脚本建议总是显式指定。目标配置保存地址与已验证 hostId，凭据使用安全存储引用，不放在 URL、日志或默认输出里。

端口必须显式指定，不使用 GUI 当前标签、最近发送端口或当前发送框。

### 14.2 命令族与阶段

| 命令族 | 主要能力 | 阶段 |
|---|---|---|
| `target` | 列表、添加地址、配对、验证身份、移除本地配置 | V1 |
| `host` | 状态、能力、客户端摘要；停止宿主另设管理权限 | V1 查询，管理后续 |
| `ports` | 枚举、状态、打开/关闭、参数与信号 | V1 |
| `control` | 控制状态、受控交接；短租约由写命令管理 | V1 |
| `monitor` | RX/TX/状态订阅、NDJSON、有限续传 | V1 |
| `send` | 文本/HEX/原始输入、明确行尾、写入结果 | V1 |
| `operation` | 查询原请求结果、请求取消 | V1 |
| `expect` / `query` | 等待/发送并等待、有限匹配器 | V1.1 |
| `commands` / `jobs` | 已保存快照、运行、进度、暂停/恢复/停止 | V2 |
| `capture` / `logs` / `replay` | 采集、导出、下载、离线解析 | V2 |
| `profiles` / `config` | 按作用域校验、差异、CAS 更新 | V2 |
| `test` | 用例断言、失败上下文、JUnit/JSON | V2 或 SDK 配套 |
| `tools` / `plugins` | 远端已声明工具与动作 | 后续显式授权 |
| `doctor` / `completion` | 身份、版本、网络与权限诊断、补全 | V1 起逐步完善 |

CLI `host` 针对服务；未来 `ui show` 只操作明确的客户端 UI，不把停止办公室窗口和停止实验室 Host 合并为同一个模糊命令。

短命 CLI 的 `send/open/configure` 在一次连接内申请、执行并释放短租约，不要求用户先运行一个立刻退出的 `control acquire` 再凭空保留控制权。Acquire/Renew/Release API 供持久 GUI/SDK 会话及同次 CLI 操作使用；V1 不提供脱离客户端连接的隐式长期占用。跨命令的持续控制会话若后续需要，应另有显式会话生命周期、续约和取消，不把可写租约偷偷存成永久凭据。

### 14.3 使用示例（完整命令面仍在后续阶段）

本机实验入口默认关闭。启动桌面 Host 前显式设置 `HYPERCOM_AUTOMATION_LOOPBACK=1`，才开放只读的 `status`、`ports list` 和 `ports watch`。只有使用开发构建做本机隔离写入测试时再设 `HYPERCOM_AUTOMATION_UNSAFE_CONTROL=1`；正式构建忽略该变量，只能显式启用只读。实验入口没有应用级认证，**不得跨机转发，也不适合与本地 GUI 控制真实设备并行使用**。CLI 只允许本机端点，`monitor` 仍不支持。

```powershell
# 在启动桌面 Host 的终端：
$env:HYPERCOM_AUTOMATION_LOOPBACK = '1'
# 下面这一行仅供本机隔离写入测试；只读测试保留注释：
# $env:HYPERCOM_AUTOMATION_UNSAFE_CONTROL = '1'
# 设置变量后，从此终端启动桌面 Host。

# 在另一终端、同一仓库根目录（默认端口 39071）：
cargo run --manifest-path src-tauri/Cargo.toml --bin hypercom-cli -- status
cargo run --manifest-path src-tauri/Cargo.toml --bin hypercom-cli -- ports list
cargo run --manifest-path src-tauri/Cargo.toml --bin hypercom-cli -- ports watch --once
# 持续观察已发布的端口状态变化（Ctrl+C 退出）：
cargo run --manifest-path src-tauri/Cargo.toml --bin hypercom-cli -- ports watch
# 发送前在开发版桌面 Host 中启用并打开模拟端口；CLI 不会隐式打开端口。
cargo run --manifest-path src-tauri/Cargo.toml --bin hypercom-cli -- send --port SIM:Loopback --text ping --ending crlf
cargo run --manifest-path src-tauri/Cargo.toml --bin hypercom-cli -- operation get --request-id REQUEST_ID
```

`ports watch` 输出逐行 JSON：不带游标时先给 `snapshot`（其 `ports` 与 `cursor` 在同一次状态发布下读取），随后给 `changes`；带 `--cursor TOKEN` 时只续传其后的状态变化。`--once` 只取一页。游标是 Host 与 epoch 作用域内的透明传递值，不可拼接或跨实例重用。`CURSOR_EXPIRED`（例如 Host 已重启）或 `STREAM_GAP`（历史已淘汰）要求显式开始新快照，不自动跳过。状态源是合并采样，不保证记录两个采样之间的物理变化，不读取或监听 RX/TX，也不取得写租约。

`send` 在同一连接解析当前代次并取得、释放短租约。不能将租约跨 CLI 进程使用。CLI 和桌面命令竞争同一个端口时不隐式抢占：CLI 收到 `PORT_BUSY`，被阻止的桌面命令返回忙碌错误，不执行串口副作用。文件传输、受管外部工具和关闭收尾均计入桌面工作；控制到期或断连后，尚未进入写入的旧 CLI 请求也不能复活。CLI 暂不支持 TTY 租约。

`send` 只有得到成功的操作记录才退出 `0`；部分写入、失败和结果未知退出非零。已发送请求未收到有效回执时保留原 `requestId`，可向同一运行中的 Host 查询，不能据此自动重发。`operation get` 退出 `0` 表示成功取得记录，不表示原操作成功。

开发验收使用 `npm run test:cli`：构建实际 CLI 二进制，连接真实 loopback listener 和假串口后端；不启动桌面应用，不需要硬件。不替代真实串口、Windows 双机或发行包验收。

后续完整命令面仍按下列契约演进：

```powershell
# 本机与实验室使用同一语法
hypercom-cli --target local ports list --json
hypercom-cli --target lab ports list --json

# 监听已存在的会话，不隐式打开端口或占写权
hypercom-cli --target lab monitor --port COM3 --format ndjson

# 短期控制操作；忙时明确失败，不偷用另一客户端租约
hypercom-cli --target lab send --port COM3 --text "status" --ending crlf --json

# 查询原操作，避免断网后盲目重发
hypercom-cli --target lab operation get --request-id REQUEST_UUID --json

# 后续：服务端建立观察窗口并执行查询
hypercom-cli --target lab query --port COM3 --text "status" --ending crlf --until-text "OK" --timeout 2s --json

# 后续：显式创建 Host 托管任务，只有已支持的任务类型可用
hypercom-cli --target lab jobs run --command-set smoke-test --port COM3 --execution host --detach --json
```

`--detach` 只允许真正由 Host 托管的能力；不把仍依赖 CLI 进程或 WebView 的任务伪装成后台任务。

### 14.4 输出与交互

- 单次命令：人类表格或显式 JSON；流：文本/HEX/raw/NDJSON。
- 机器模式 stdout 只放结果，stderr 放诊断。
- 默认不输出颜色控制码污染重定向结果；不要求解析本地化文案。
- 错误码稳定，退出码区分参数、认证/权限、忙、超时、I/O、取消、未知结果。
- 原始二进制输出不混入状态文字；元信息走独立格式或 stderr。
- 非交互模式不弹隐藏对话框；需要配对/确认而未提供授权时明确失败。
- `--text`、`--hex`、原始文件/标准输入互斥；HEX 严格校验，不补零，不追加文本行尾。
- `--stdin` 不无意等同 shell exec；raw TTY 和普通 send 分开设计。

### 14.5 SDK 和生态

先提供薄 Python SDK：连接、订阅、query、任务管理和结构化错误，直接复用协议，不重新实现控制权与重试规则。通过 pytest 示例连接编译、烧录后的验证与报告。

优先建设：GUI 复制 CLI 命令、导出操作快照、测试失败附事件位置、GUI 打开对应采集。后续可做设备专用插件动作、协议解码和 AI 工具适配，但它们都受同一服务权限，不另开“万能执行”入口。

---

## 15. 安全模型

### 15.1 启用和认证

- 共享默认关闭，宿主显式启用并选择暴露端口和绑定接口。
- 远端 TLS 验证服务端身份；私有部署可用明确确认的证书指纹或企业证书，不默认跳过验证。
- 首次配对需宿主侧批准或其他受控凭据发放；后续凭据可撤销、可轮换，可按部署要求过期。
- 高风险权限不由“已连接到内网”自动获得。
- 本机 pipe/UDS 也校验 OS 主体和应用会话，防任意本地进程匿名调用。
- SSH/VPN 保护网络通路，仍需应用身份和端口范围；loopback 不自动等于可信调用者。

### 15.2 权限分层

| 能力 | 示例权限 | 备注 |
|---|---|---|
| 查询与观察 | ports.read、events.read、logs.read | 日志与历史也可能敏感，不全局广播给未授权用户 |
| 发送 | serial.send | 仍需有效控制租约 |
| 连接和改参 | serial.control | open/close/signals 都可能影响设备 |
| 交接 | control.takeover | 与普通 send 分离，可只允许宿主管理员 |
| 任务 | jobs.start、jobs.manage-own、jobs.manage-all | 托管任务需明确执行授权与范围 |
| 宿主管理 | host.manage、config.manage | 首版远端默认不开放全量管理 |
| 文件/工具/插件 | 独立细分能力 | 不继承现有插件 shell 或主窗权限 |

权限按 Host、端口范围和动作检查，入队与执行前均复核。客户端只可获得授权范围的快照、事件与重放。既有合法读取获得的数据不能通过撤权“收回”，但撤权应停止后续交付和副作用准入。

Host 托管任务的继续权限基于创建授权和服务策略，不因为断网自动提升；主体或任务权限被撤销时按策略停止新副作用。需要将任务交给服务主体长期维护时必须显式转交，而不是隐式保留失效凭据。

### 15.3 审计

记录认证、授权变化、控制交接、参数/信号变更、操作结果、任务启动停止和 Host shutdown。来源由宿主赋值；客户端显示名仅作为标签，不是可认证身份。

诊断日志不得默认包含凭据、私钥、完整认证 URL。设备字节是否保留由采集/日志权限和配置决定，不把所有敏感串口内容无条件写入全局诊断日志。

### 15.4 不开放的捷径

不转发任意 invoke、不复用 Tauri invoke key 作为网络令牌、不接受 `window=main` 冒充权限、不允许任意远端路径和 shell、不为方便连接放宽为公网匿名访问。

---

## 16. 部署、退出与版本升级

### 16.1 内嵌桌面 Host

- 实验室电脑需开机、设备连接、用户会话内 HyperCom 已运行。
- 可隐藏到托盘，不需要办公室持续开 RDP。
- 宿主真正退出或用户注销导致进程结束时，服务和串口会收尾；不宣称无 GUI 常驻。
- RDP 断开、锁屏、注销、系统睡眠是不同情况，需要真实 Windows 环境验收；现有 WebView 自动化的定时可靠性不能由“进程还在”推定。
- 办公室网络丢失不应终止宿主；客户端退出只清理其订阅/附属控制。

### 16.2 独立用户态 Host

后续使用独立 native 进程管理设备，GUI 关闭仅 detach。Host 独占数据目录；旧 GUI 配置与日志迁移有备份和明确接管，不并发双写。

服务生命周期管理包括 ready、draining、stopping；停止时关闭新准入、停止新任务调度、取消并收尾在途工作、关闭串口、刷新日志后退出，保留既有锁外 I/O 和统一 shutdown 原则。

### 16.3 Windows Service

仅在无人登录/开机常驻需求确定后实现。服务不依赖交互式 WebView、文件选择器或桌面插件；账号、目录 ACL、日志路径、电源策略、恢复和升级都需要单独部署设计。

Windows 服务在 Session 0，与普通交互桌面隔离。不能把现有 Tauri GUI 直接藏起来当 Windows Service。

### 16.4 升级

- 协议能力协商决定兼容性，GUI 不支持的能力明确禁用。
- Host 升级默认不在活动独占操作中自动进行。
- 升级前进入 draining，并告知客户端；重启后产生新 serverEpoch。
- 客户端不能因网络恢复就自动重发旧控制命令或恢复危险任务。
- 首版不提供办公室远程更新/关闭实验室系统的通用管理能力。

---

## 17. 分期实施与迁移路线

### P0：设计冻结与双机验证准备

产出：领域契约草案、权限/身份模型、事件及未知结果定义、首版能力矩阵、真实双机验收计划。

确认网络可达与 IT 许可；定义至少一台真实实验室 Host、办公室客户端和可安全测试的串口设备。此阶段不需要完整 daemon 或插件运行时。

### P1：统一原生权威与最小本地 CLI

范围：

- PortRef/PortKey 本地兼容迁移，服务 epoch。
- 领域服务门面、权威快照、TX/RX/操作事件。
- 本地全部副作用接入控制仲裁，包括旧文件/TTY/插件/触发旁路。
- operationId、查询、取消、partial/unknown、有限去重。
- Windows pipe 与 CLI status/list/watch/send。
- 现有前端自动化作为受控 attached executor 保持兼容，不复制第二套执行器。

退出条件：CLI 和本地 GUI 已真正共享同一 Core；不允许本地旧入口绕过租约；同名端口身份迁移有测试。

当前分支已完成本机实验命令、原生操作级互斥、按配置实例持久化的 Host 身份及采样端口状态续传。桌面增强流程和其他前端执行器的事务级委派、`PortKey` 迁移、正式本机 IPC 和权威 RX/TX／操作事件订阅仍是 P1 退出项。不要把状态采样当作原始采集，不要把旧 GUI 的写前回显当作权威 TX，也不要把任意外部程序自行访问串口当成可由本 Host 仲裁。

### P2：首个完整远程闭环（V1）

范围：

- 一个远端 TLS adapter、配对/权限/撤销。
- 办公室 Host 资源树、远程 TRX、权威参数回写。
- 枚举、状态、开关、参数、DTR/RTS、文本/HEX 收发。
- 多观察者、短事务、明确独占和受控接管。
- 状态快照+有限续传、gap、断网 stale、原操作查询。
- CLI 用相同 `--target` 操作实验室，不要求办公室 GUI 在线。
- 实验室保留原有日志策略，不把现有日志称为完整无损 capture。

退出条件：真实 Windows 双机、不使用 RDP，完成正常调试、竞争、丢 ACK、断网恢复和宿主退出验收。

**P1 期间即可做远端链路的小型验证，不等整个 CLI 功能生态完成才第一次连两台电脑。**对外启用远程控制前，原生仲裁和权限边界必须完成。

### P3：自动化与数据生态（V1.1 / V2）

按价值逐项交付：

1. 服务端 expect/query 与明确的协议匹配边界。
2. 原生单一重连 supervisor。
3. 命令集固定快照、有限 Host 任务与控制交接。
4. 自动回复执行唯一性与 live-only 输入。
5. 原始 capture、日志/采集下载、失败现场定位。
6. Python SDK、pytest/JUnit 示例、GUI 复制 CLI。
7. 文件 artifact 上传与发送任务。
8. 远程 TTY 专项验收。

每迁移一种执行器，都更新 capabilities 和运行位置，不一次承诺全部后台等价。

### P4：独立 Host 与无人值守

提取 native Host、用户态进程管理、GUI detach、数据目录迁移、安装升级；之后按需求支持 Windows Service。旧桌面插件和依赖 UI 的功能明确保留 desktop-only，而非为了服务化强行模拟浏览器环境。

### P5：扩展生态

远端预设工具、协议动作插件、受控第三方 RFC2217 网关、多实验室组织管理等。每一项独立审查权限、运行位置和故障语义，不为首版预建云平台。

### 迁移涉及的主要接缝

| 接缝 | 当前入口 | 目标变化 |
|---|---|---|
| 端口身份 | [类型定义](<src/types/index.ts>)、[工作区 store](<src/stores/useAppStore.ts>) | 原生名与客户端 PortKey 分离，配置引用迁移 |
| 调用与订阅 | [串口服务](<src/services/serial.ts>)、[事件服务](<src/services/event.ts>) | 目标路由和领域事件适配 |
| 原生权威 | [应用入口](<src-tauri/src/lib.rs>)、[串口命令](<src-tauri/src/commands/serial.rs>) | Core 准入、租约、操作账本，Tauri 作为入口之一 |
| 事件事实 | [串口事件](<src-tauri/src/serial/events.rs>) | 权威 RX/TX、seq/epoch、非阻塞订阅分发 |
| UI 发送 | [发送 hook](<src/hooks/useSerialSend.ts>) | pending 与权威结果合并、保留 UX 不再独占安全边界 |
| 自动化 | [收发架构](<docs/architecture/transmission.md>)、[连接运行态](<src/utils/serialConnectionRuntime.ts>) | 指定执行器与后续下沉，不重复运行 |
| 配置与资产 | [配置架构](<docs/architecture/config.md>)、[插件架构](<docs/architecture/plugins.md>) | 作用域与版本，权限不隐式跨机 |
| 退出部署 | [关闭命令](<src-tauri/src/commands/system_cmds.rs>)、[主程序](<src-tauri/src/main.rs>) | 内嵌阶段明确限制，独立阶段区分 detach/stop |

---

## 18. 难度判断与成本控制

### 18.1 相对难度

| 工作 | 判断 |
|---|---|
| 固定参数的字节网络转发实验 | 较低，但不是可交付的统一方案 |
| 身份、原生仲裁、权威事件和未知结果 | 中高，是主要架构工作 |
| 统一契约后的基本 CLI | 中等，解析参数本身不是难点 |
| 两台 Windows 间实用远程 TRX | 中高，需要网络故障和真实硬件验证 |
| Host 任务、原始采集与可靠恢复 | 中高，逐项建设 |
| 全部旧功能远程等价、任意插件同步、系统服务 | 高，不适合作为一个首版承诺 |

这不是“加一个 WebSocket 就完成”的小改动，但也不需要重写全部 UI 和驱动。最有价值的复用是现有串口生命周期、codec、日志、显示引擎及配置保存约束。

当前未形成实现拆分和实机性能基线，不给出伪精确人日。实施估算应按 P1/P2 的模块接缝、测试覆盖和原型结果进行，不能用字节桥原型的工时代表完整产品。

### 18.2 性能预期

常见串口的带宽通常不是局域网首要瓶颈。例如 115200 baud、8N1 理论有效载荷约 11.5 KB/s（不含额外网络封装，双向需分别计算）。这只是量级估算，不是已测性能。

需要重点控制的是网络 RTT/抖动、消息批量、慢消费者、每字节 JSON 开销，以及把高频查询循环放在办公室导致的往返等待。时序敏感操作应在 Host 侧完成，但普通 OS 调度仍不提供硬实时保证。

### 18.3 明确不做的过度设计

- 不先造通用分布式调度器和永久事件数据库。
- 不同时实现 HTTP、gRPC、WSS、RFC2217、SSH 内置客户端等全部传输。
- 不要求所有本地操作必须经过网络回环。
- 不用网络共享目录让两台 GUI 共同编辑同一配置文件。
- 不把所有插件改成远程微服务。
- 不为了无人值守去绕开 Windows 会话隔离或隐藏 UI 依赖。

---

## 19. 验收矩阵

下表是交付门槛，不是本轮已执行的测试。现有 mock IPC/Playwright 不等价真实 Windows 双机、串口驱动和发行包验收。

| 场景 | 必须结果 | 阶段 |
|---|---|---|
| 本机、实验室 A/B 都有 COM3 | 状态、发送、配置、历史和权限不串线 | P1/P2 |
| 两个 GUI 加 CLI 同时观察 | 每个独立接收，不互相消费字节 | P2 |
| 一个慢客户端 | 有界积压、明确 gap，不拖住串口与其他客户端 | P1/P2 |
| 本地旧发送/TTY/文件/插件绕路 | 同样受 Core 控制，无第二有效写入者 | P1 |
| 短 query 与人工发送竞争 | 不插入响应窗口，按事务边界交接 | P3 |
| 租约过期但旧请求在队列 | 执行前拒绝，不因已排队而放行 | P1 |
| 接管时正在写入 | 新 holder 等待收尾，不交错在途字节 | P1/P2 |
| 网络在请求到达前断开 | 不虚报成功；无法确定时保留未知语义 | P2 |
| 写入完成但 ACK 丢失 | 查询原请求，不换 ID 自动重发 | P2 |
| 部分写入失败 | 可知部分明确报告，不假设 0 字节 | P1/P2 |
| 同 requestId 不同载荷 | 明确冲突拒绝 | P1 |
| Host 在写入与记账之间崩溃 | 不承诺 exactly-once，未知状态可见 | P2 |
| Host 重启后 generation 恰相同 | serverEpoch 使旧操作与租约失效 | P1/P2 |
| USB 拔插/同名端口重开 | 旧请求不能写入新连接 | P1/P2 |
| 网络断开 | 不暗关串口、不拉 DTR/RTS、不清空远端资源身份 | P2 |
| snapshot 与 live 数据并发 | 无静默窗口丢失；客户端可去重 | P1/P2 |
| 重连补播/重复事件 | 不重复计数，不再次触发自动发送 | P2/P3 |
| 权限撤销/过期凭据 | 停止新准入及后续未授权数据交付 | P2 |
| 未授权用户知道端口或 artifact ID | 仍无法读取、发送或下载 | P2/P3 |
| 只读客户端切标签/改显示 | 不隐式改设备参数或信号 | P2 |
| 办公室窗口/CLI 退出 | 只 detach 自身；不停止 Host 或其他任务 | P2 |
| 实验室内嵌宿主退出 | 明确通知并统一排空，不假装后台仍运行 | P2 |
| Host 托管任务发起者掉线 | 按任务创建策略继续/停止，写权不双主 | P3 |
| 服务重启后旧 Host 任务 | 默认 interrupted，不自动恢复危险动作 | P3/P4 |
| 两端修改配置 | revision 冲突可见，不整份覆盖另一个作用域 | P3 |
| 办公室路径传到实验室 | 拒绝混用；发送通过明确 artifact | P3 |
| 两个 TTY 模拟器 | 只有有效控制者可输入/自动应答 | P3 |
| 锁屏/RDP 断开/注销/睡眠 | 逐项验证并公布能力边界 | P2/P4 |
| 发行包升级与重连 | 能力协商、epoch 更新、无盲重发 | P2/P4 |

测试层次：纯逻辑状态机与属性测试、mock driver 部分写入/阻塞注入、协议兼容测试、双客户端并发集成、真实 Windows WebView 与真实串口、安装包部署/退出/升级。高吞吐和大文件不应只在开发模式验证。

---

## 20. 尚待确认的条件与建议默认值

这些条件影响实施优先级，但不妨碍统一契约设计。没有用户确认的内容均为建议默认，不是既定需求。

| 待确认项 | 建议默认 |
|---|---|
| 公司网络能否直接访问实验室新端口 | 先按受控 LAN/企业 VPN 设计，实施前核验，不做穿透 |
| 实验室是否允许保留登录用户会话和托盘进程 | V1 允许；无人登录诉求触发 P4 提前评估 |
| 是否必须接续实验室当前插件/循环 | V1 共享设备会话，不镜像任意插件；attached 状态明确 |
| 监控是主动查询还是被动日志 | 两者接口都预留，V1 先原始监听/发送，query 为紧随能力 |
| 是否需要完整串口 TTY | V1 TRX，TTY 单列验收，不无条件承诺 |
| 断开办公室是否继续任务 | 只有显式 Host 托管任务可继续；普通 attached 停止新发送 |
| 人工与自动化冲突时如何处理 | 协作任务在边界暂停，显式恢复；独占任务需授权接管 |
| 历史保留与零丢失要求 | V1 有限内存+gap；持久原始采集另行启用 |
| 是否要第三方程序看到虚拟 COM | 默认不做，后续独立兼容项目 |
| 是否多人共享设备 | 身份模型支持；V1 不做组织平台，权限按 Host/端口授予 |

### 最终推荐

**现在就把 CLI 和远程访问当成同一个“设备服务化”项目设计；先交付统一原生权威与远程 TRX 的纵向闭环，再扩展自动化生态，最后按真实需求拆出独立 Host。**

这样 CLI 不是 GUI 的临时外挂，远程也不是另一套控制系统；二者共享身份、操作权、数据和错误语义，后续 SDK、测试与插件扩展才有稳定基础。

---

## 21. 外部资料与结论来源

以下资料用于核实平台/协议事实，不代表 HyperCom 已实现对应功能；上文分层、命令面与里程碑为本方案设计判断。

1. [Microsoft：Communications Resource Handles](https://learn.microsoft.com/en-us/windows/win32/devio/communications-resource-handles) — Windows 通信资源独占打开要求。
2. [Tauri：CLI 插件](https://v2.tauri.app/plugin/cli/) — 参数解析与 Windows GUI 生产程序控制台输出限制；不是持续远程 API。
3. [Tauri：Single Instance](https://v2.tauri.app/plugin/single-instance/) — 单实例和参数交付，不自动提供订阅服务。
4. [Microsoft：Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) — 管道 ACL 与登录会话隔离。
5. [RFC2217 原文](https://www.rfc-editor.org/rfc/rfc2217.txt) — Telnet COM 控制选项及波特率、控制线命令；不是完整应用会话协议。
6. [pySerial URL handlers](https://pyserial.readthedocs.io/en/latest/url_handlers.html)、[pySerial API](https://pyserial.readthedocs.io/en/latest/pyserial_api.html) — raw socket/RFC2217 能力差异、认证加密与网络延迟限制。
7. [Windows OpenSSH 安装与首次使用](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse) — 组件、服务与防火墙部署要求，不是零部署能力。
8. [OpenSSH ssh 手册](https://man.openbsd.org/ssh)、[sshd_config 手册](https://man.openbsd.org/sshd_config) — 安全通道端口转发、AllowTcpForwarding/PermitOpen；Windows 部署仍须验证实际配置与版本。
9. [Tauri CSP](https://v2.tauri.app/security/csp/) — WebView 内容/连接约束，不是自建网络服务的身份认证替代。
10. [Microsoft：Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services) — Windows Service 与交互桌面边界。
11. [Saleae Automation API](https://saleae.github.io/logic2-automation/) — 公共 API 与 Python 封装的生态参考，不据此要求采用相同传输。
12. [sigrok-cli](https://sigrok.org/wiki/Sigrok-cli) — 采集、解析、导出可组合性的产品参考。

本方案结合两路源码研究及一轮统一契约独立审查，子 agent 均按用户要求使用 `wang/gpt-6.1-sol`。没有进行真实网络、硬件、性能或安装包验证；相关内容已明确列为后续验收项。
