# 插件隔离 UI 与工作区标签

本模块是当前实现契约。支持在原始串口标签替换内容，或额外创建独立插件标签；独立标签可以绑定端口，也可以是无端口工具页面。作者接口、manifest 和打包说明只维护在[插件开发指南](../plugin-development.md#隔离-ui-与工作区标签)。

## 承载与平台边界

- Windows 使用 `plugin/view_runtime/windows.rs` 的 raw Wry 子 WebView，嵌入主窗口标签内容矩形，不创建额外桌面窗。
- 不经过 Tauri WebviewBuilder，不注入 Tauri 初始化脚本、invoke key、通用命令、事件或 channel-fetch。UI 仅有 host SDK `view` 和专用 IPC；后端由 native Session 闭包确定身份，不接受页面自报 pluginId。
- `isolated` 控件使用独立临时目录/incognito 与随机 HTTPS origin；`trusted-web` 控件使用每插件持久浏览器目录及 pluginId/viewId 的稳定 SHA-256 HTTPS origin。静态资源仍由原生内存响应提供，缺失本地资源不走网络 fallback。
- macOS/Linux 当前没有通过原生策略验收的 adapter，创建明确拒绝，不以主窗 iframe 或文本面板代替。原有 Worker/文本面板功能不受此平台门控影响。
- 独立 DOM/来源/存储与原生能力不等于独立 OS 进程，也不是 CPU/堆内存硬配额。

## 原生安全执行点

`plugin/view_runtime/mod.rs` 的 create/update/send/destroy 检查真实来源 WebView 为 main。create 在 plugin_io 中验证启用、installGeneration、声明视图/placement/input、授权、当前端口/mode及资源，随后进入 UI 线程创建控件。状态提交和原生调用不跨 await 持有 config mutex。

资源快照只包含 entry/styles/assets 及隔离模式的宿主 shell/SDK，拒绝 data/、保留命名空间（`__host/` 不可被插件声明覆盖）、路径别名、链接/reparse/hardlinks、非普通文件及额度越界。插件脚本为普通 bundle，不直接拼入主窗 React DOM。Native send 只接受 `init`/`state`/`environment`/`binary-chunk`/`binary-ack` 五类 JSON：按类型分别限制信封大小并转义为 SDK dispatcher（`__hypercomViewDispatch`）的固定调用，不接受源码 eval；未知类型、缺失文档身份或分片非法直接拒绝。

隔离模式首文档加载前安装 WebView2 策略：一次宿主初始导航、后续顶层/子 frame 导航拒绝；全请求源拦截并静态响应；下载/新窗口/外部协议/拖入/浏览器权限拒绝；HTML 文件选择通过 acknowledged CDP interception 阻断；网络配置和 CSP 叠加防护。必需 COM/CDP 接口不可用时创建失败，不加载插件代码。

**隔离模式明确例外**：浏览器真实用户操作的原生复制/剪切可写系统剪贴板，这是用户选择的边界；隔离页面程序化剪贴板读取及 Worker clipboard API 仍分别受原生拒绝/已有权限约束。可信网页边界见下节。

安装/升级/卸载/禁用/必要撤权及配置备份恢复先使路由失效，控件销毁与代次提交协调，旧消息不能复活新代码。原生事件只定向 main，页面不能订阅全局串口事件。

## 可信网页模式

作者声明与能力说明只维护在[插件开发指南](../plugin-development.md#可信网页模式windows)。`UiView.mode` 缺省 `Isolated`；`TrustedWeb` 要求视图 `entry` 为 `.html`/`.htm`、`styles` 为空并声明 `trusted-web-view@1`。HTML 字节原样返回（不加宿主外壳），SDK 由原生初始化脚本注入本视图虚拟本地 origin 的顶层文档（以 `window === window.top` 与 `location.origin` 判定，不绑定某个精确 URL）；DOMContentLoaded 时原生（仅最新一次被允许的顶层导航）执行 `__hypercomViewDocumentStart` 把本次导航的 `documentId` 交给页内 SDK，页面回传 `ready` 后才算 native ready。插件根 `entry`（Worker 入口）为空（纯网页插件）时整体不建根 Worker；视图声明 `worker:false`（仅允许可信网页且 `input:"none"`）时该视图不依附 Worker，但 manifest 仍声明 `entry` 时根 Worker 照常启动并可供其他视图使用。两类视图都按无 Worker 视图处理：`workerEpoch=0`、不订阅输入、不发布模型、不等待 Worker ACK，`view.open`/`view.document` 也不下发；Worker ready 协议仅用于依附 Worker 的视图。视图自身的 `entry` 仍必填 HTML。

**文档生命周期**：两种模式都使用原生文档身份——隔离模式只有宿主 shell 一次顶层导航，可信模式允许在声明过的同源 HTML 之间导航/刷新（查询串与锚点参与 URL 但不参与资源路径，路径仍过 `validate_view_resource_path`）。顶层导航到外部 http/https（仅真实用户操作）与外部 http/https 的新窗口请求交给系统浏览器且不获得 SDK；脚本发起的顶层跳转只取消、不弹浏览器；其他外部协议与其余新窗口请求直接拒绝；可信模式的 frame 仅可加载 http/https/blob/about，同样不注入 SDK。每次被允许的非纯锚点顶层导航在 `NavigationStarting` 即生成新 `documentId`（UUID）并向主窗广播 `document` 事件，上一文档立即失效：前端清空在途 ACK、候选快照与二进制通道，保留当前模型并在新文档 ready 后重放；原生在 `send` 入口与 UI 线程派发前两次复核 `documentId`，旧文档迟到的 ready/ACK/message/二进制块一律丢弃。页面消息（`ready`/`state-ack`/`ui-message`/`error`/二进制块与确认）必须携带当前 `documentId`，原生 `receive` 丢弃缺失、非 UUID 或不匹配者且不回报错；原生自身事件（`document`/`focus`/`error`）携带当前 `documentId`，`focus`/`error` 在尚无文档时为 null，前端把无文档归属的 `error` 当实例级故障处理。可信文档加载期间不设固定期限；仅在成功的 `NavigationCompleted` 后启动 30 秒 SDK ready 看门狗，ready 到达即取消。最新一次已准许导航随后失败或被取消（含 `OPERATION_CANCELED`）会明确失败并退休，不永久停在 loading；在 `NavigationStarting` 已拒绝的外链不误报为该文档失败。仅锚点变化保留文档身份，但会更新当前 URL，使其后的刷新正确生成新身份。`ProcessFailed` 仍退休页面；普通资源错误与慢子资源加载不直接退休。隔离模式保留 5 秒初始化期限，其页面脚本/资源错误经 SDK 上报并按文档归属退休。

`PluginConfigEntry.trusted_web_granted` 默认 false，仅 `set_plugin_trusted_web` 主窗命令能够授予；启用、`create` 与消息/原生事件都检查实际批准，普通权限不隐含网页信任。升级清除批准；配置导入保持当前批准（不能新增或复活已撤销的信任），且导入时“已启用但缺网页信任”的可信插件会被强制禁用（manifest 不可读同样 fail closed）。撤销同时禁用并退休页面。所有变更复用 plugin_io、expectedGeneration 和 revision 快照。

Windows 可信分支不安装离线/CDP 网络阻断、黑洞代理/DNS、隔离 CSP 或文件选择拦截，但仍关闭 devtools、宿主对象、默认右键菜单、自动填充/密码保存与外部拖入，并取消外部协议与 WebView 内新窗口。仅虚拟本地 origin 的请求被资源拦截（未声明路径 403，不回退网络），其他浏览器流量按标准 CORS/TLS 运行；WebView 内离开入口的顶层导航与 frame 导航按上节白名单取消，真实用户点击的外部顶层链接与外部新窗口改交系统浏览器。Clipboard read 权限只对本视图 origin 的活跃文档放行，粘贴快捷键恢复，其他浏览器权限拒绝。网页不共享主窗权限或 DOM。

`DownloadStarting` 默认取消并获取 deferral：隔离模式立即取消且不弹框；可信模式弹原生另存为，用户选择并成功设置路径后才放行，不显示自动打开下载的浏览器 UI。待选下载及运行下载由各 Control 拥有，退休取消并完成 deferral，迟到对话框不能写文件。Control 析构不能访问其他 thread_local 表，避免退出时表析构顺序导致崩溃；移除控件后在 RefCell 借用之外析构。

持久目录由 `plugin::web_data_dir` 定位至 `<config_dir>/plugin-web-data/<pluginId>/<installGeneration>`，不在插件可写包树；唯一入口校验 UUID 并规范化代次目录段，拒绝路径穿越。普通关闭/同代次重载保留；替换或卸载后重装生成新代次，不向新代码复用旧站点数据。旧代次或遗留 id-only 目录不被新代次打开，也不冒充已成功清理。清除/卸载先退休全部视图，再创建相同环境选项的隐藏维护控件，等待 Profile2.ClearBrowsingDataAll 完成后关闭；不直接删除浏览器仍占用的目录。全部站点数据被清除，空 profile 文件可保留。维护期间 plugin_io 阻止并发创建；若仍有控件引用同一 profile，清除显式失败；清除失败如实返回。

## 视图二进制通道

`view.sendBinary(type, bytes)` / `view.onBinary(cb)` 在 Worker 与 UI 两侧对称（作者 API 与示例见[插件开发指南](../plugin-development.md#ui-sdk)），仅依附 Worker 的视图可用；`worker:false` 或插件根 `entry` 为空的页面没有 Worker 对端，宿主 `view.publish`/`view.sendBinary` 与页内 `sendBinary` 均拒绝。

**分块与信封**：每次传输由发送端生成 `transferId`（≤128 字符），按 `seq` 从 0 递增切块；每块原始字节 ≤8 KiB，base64 后放入 `data`，整条 JSON 信封必须 ≤16 KiB（原生 `binary-chunk`/`binary-ack` 上限 16 KiB，页内 SDK 自身也按 UTF-8 ≤16384 字节拒绝）。`done` 标记末块，`transferType`（≤128 字符）全程一致；空载荷仍发送一块长度为 0 的末块。二进制字节与传输元数据不进入 `state` 快照，`boundedPluginViewJson` 与快照额度都不适用于二进制字节。

**ACK 背压**：发送端同一时刻只保留一块在途，收到对应 `(transferId, seq)` 的 `binary-ack` 后才发下一块；非末块在接收端分片入缓存后立即确认，末块要等完整字节交付插件异步回调并结算后才确认——UI→Worker 方向要等宿主 `postViewBinary` 投递并在 Worker 侧 `view.onBinary` 回调完成（bridge `eventAck`）后返回，Worker→UI 方向要等页内 `view.onBinary` 回调 Promise 完成。失败回 `ok:false` 与 ≤2048 字符错误文本，发送侧以该错误拒绝；接收端按 `seq` 严格顺序、`transferType` 一致重组，乱序、类型变化、base64 非法、单块超 8 KiB 都会回 nack 并丢弃该传输半成品，两个方向的接收端都最多同时保留 4 个未完成传输。宿主→UI 方向由 `ViewBinarySender` 串行化整个传输（一个传输完成才发下一个）；UI→Worker 方向允许并发传输。二进制不消费普通控制/RX 的 `eventBytes`，但受独立传输资源预算约束：单条最多 256 MiB；每个 sender 的在途+排队原始字节最多 256 MiB/4 条。主窗 `ViewBinaryBudget` 对双向、所有视图共享记账，每插件安装代次最多 512 MiB/16 条，全应用最多 1024 MiB（1 GiB）/32 条；在分配拼接副本前先预留其峰值，完整 UI→Worker 缓冲的租约一直持有到 Worker ACK/取消。页内 SDK 为每个独立文档提供双向共享 512 MiB/4 条额度，单条同为 256 MiB。拒绝发生在整块复制前，正常 Worker RPC 接管已克隆缓冲而不再次复制。

**期限与主动回收**：每块/末块异步回调 ACK 最多等待 30 秒；等 ready 的发送队列最长 60 秒；未完成接收无新分片 60 秒时由主动定时器释放半成品并回 nack，不依赖下一次输入触发清理。Worker `view.sendBinary` 另有 10 分钟传输 RPC 资源期限；sender 自 `send` 入口起也有绝对 10 分钟总期限（包含排队，持续 ACK 不延长），到期仅终止对应传输、释放资源并继续健康队列。失败/导航/重载/关闭均释放槽位和幂等租约，迟到 ACK 不得结算新传输。SDK 二进制与 state/environment 使用独立有界 lane，慢二进制回调不阻塞状态 ACK。这些是二进制传输资源边界，不改变文件/HTTP 无业务大小或隐式请求期限的契约；不是插件自行分配内存、用户回调长期保留数据或整个 OS 堆的硬配额。Worker→宿主结构化克隆在宿主准入前发生的瞬时分配也不能被接收端预算追溯阻止。

**取消与迟到拒绝**：传输绑定 `viewInstanceId + documentId`，宿主送入 Worker 前还复核 `workerEpoch`。导航、关闭、Worker 换代或 retire 时，宿主 `cancelViewBinary` 拒绝并释放尚未完成的宿主→Worker 投递及其事件/字节额度，`ViewBinarySender.cancel` 拒绝在途与排队发送，`ViewBinaryReceiver.reset` 丢弃半成品；此后迟到的 `binary-ack` 因 `documentId` 不匹配被忽略，原生 `send` 与 `receive` 也分别拒绝/丢弃旧文档消息。原生 `receive` 对非法或身份不符消息丢弃；二进制按每插件 512 帧/秒、突发 1024 共享桶限制，解码/转发前扣令牌。首次超限每视图仅报告一次可观察错误，使宿主退休视图并取消双向传输，后续超量帧不反复 emit 放大。合规发送的丢 ACK/挂起也由独立 ACK 期限结算，不再无限等待。Worker 桥在投递 `view.binary` 前复核会话当前 `documentId`，不匹配即回失败；`view.document` 是独立控制事件，不受控制字节/条数额度的准入限制；Worker 换代由宿主的 `workerEpoch` 判定退休重建。已经在执行的插件异步逻辑不假装被撤销；`view.sendBinary` 使用独立的 10 分钟 RPC 资源期限，先发生的 ACK 失败、主动 idle 回收、文档取消仍会更早结算并释放槽位。文件/HTTP 的无隐式业务期限不受影响；大块数据仍不进入实时状态 JSON 合并通道。

## 工作区模型

`TabItem` 是 serial/plugin 判别联合，id 为工作区 UUID，portId 不再等于 tabId：

- serial：显式 portId，每端口至多一个原始标签，可选 displayView 改变内容。
- plugin：pluginId/installGeneration/viewId/boundPortId/instanceKey/restoreOnStartup，多个标签可关联同一端口。
- 树和关闭/拖拽/固定操作只使用工作区 ID；串口服务、终端缓冲、统计和发送历史继续以 portId 为键。
- `getTabPortId`/`getActivePortId` 是串口目标唯一解析入口；工具页返回 null，不回退到上次端口。原始清屏/回放/导出通过 `isRawSerialDisplay` 区分，插件页面不误操作隐藏终端。

`pluginViewRuntime` 负责授权、候选视图、唯一键、动作票据、实例、native 生命周期及状态发布。`useAppStore` 只保存轻量标签描述/偏好，不保存模型/控件。同一插件仍一个 PluginSession/Worker，由 Worker SDK按 viewInstanceId 串行派发各会话输入。

## 打开动作与会话

宿主“显示方式”只能替换当前 serial 标签；“在新标签打开”及工具页选择器创建独立 plugin 标签。Worker tabs.* 另需 ui:tabs，只管理自身标签，固定标签由用户关闭。

同插件/代次/view/绑定端口/instanceKey去重；并发重复请求不创建额外模型。open 返回 loading/ready/unavailable 描述，不能将 loading 当作渲染成功。foreground 和 activate 需插件/代次/pane/单次动作票据；端口菜单限定目标端口，侧边栏活动端口只是信息。后台事件不能抢焦点或移动既有页面。

宿主加号/选择器未指定实例键时，优先激活同插件、代次、view、绑定端口的已打开标签（优先当前活动实例），复用 Worker 的实例键；没有匹配才使用 `default` 创建。Worker 显式不同 `instanceKey` 的多实例语义不变。示例 Sensor Workspace 的菜单和表格动作统一使用默认实例键，避免反向打开再次创建页面。

用户关闭后同键后台重开拒绝；关闭记录有界，满额暂停后台新建而不是丢旧关闭意图。用户明确重新打开可解除。打开页面不连接/断开串口，也不自动发送。

Binding 区分 tabSessionId、viewInstanceId、workerEpoch、streamEpoch和installGeneration；`documentId` 不属于 Binding，它是原生按顶层导航生成的文档代次（见[可信网页模式](#可信网页模式)）。关闭重开、切换视图或故障重试创建新实例；隐藏、焦点及分屏移动保留。原生 ready 和 Worker 初始化完成必须同时满足，才显示页面/发布模型；隔离 UI ready、Worker 初始化与可见状态 ACK 各有期限，超时或 ACK 失败产生可观察的错误（可信文档仅在加载成功后启动 30 秒 ready 看门狗，慢加载本身不超时）。

主窗 runtime 的原生监听注册也绑定启动代次：停止后迟到的注册立即解除，旧回调和重复 cleanup 不得操作后续 runtime。React StrictMode 的启动→停止→启动不能留下第二条可用原生消息通道。

## 输入与回收

`pluginViewInput` 按固定端口注册 bytes/lines/none 租约；工具页没有 RX 状态。输入旁路有界，gapBefore与streamEpoch在存活批次之前进入串行解析，重连/模式切换/裁剪/Worker拒绝都会清残帧边界。新会话实时开始，不补历史。

line 租约复用 RxPipeline/RxLineAssembler及协议绑定；没有原始终端仍处理独立 line 输入，不复活 viewportManager 或积压 stock 行队列。字节租约在 serial:data 模式分流前观察，TTY也可用。启用且匹配端口的宿主 trigger rules 也是行消费者，关闭显示不停止既有告警/自动回复。

原始、表格、波形分别持有会话，关闭一个只释放其资源。`releaseUnusedPortState` 保留仍有标签描述/输入消费者的编码/统计/TX历史，最后消费者退休才回收（行消费者判定 `hasPortLineConsumers`）。serial关闭释放 stock viewport/TTY并 discardTerminalQueue，不能向别的视图伪造 disconnected。

Worker close是优先生命周期通道，释放已退休实例事件记账与排队数据，不排在 stalled async 回调后等待。迟到初始化不宣布ready，迟到副作用调用拒绝；已经开始的外部副作用不假装可撤销。

TTY 同端口发送串行排队时，插件请求必须在实际发送开始前同步复核 Worker/请求仍存活、安装代次和当前授权；视图发送还复核原实例/标签/输入资格，绑定目标不变。停止、超时、升级、撤权或关闭发生在排队期间会拒绝尚未开始的发送，已开始的后端 I/O 仍不假装撤销。

## 布局、原始连续性与错误页

`SerialContentHost` 在Pane树外稳定持有TRX/TTY实例，`tabContentPlacement` 提供布局。跨Pane移动不换组件所有者，原始缓冲/xterm保持；选择插件只隐藏原始显示，输入继续，TTY隐藏不fit零尺寸。

`PluginViewSurface` 提供宿主工具条和native内容矩形。原生控件按layoutRevision只处理最新几何，统一CSS px、主WebView zoom与窗口DPI；clip到client范围。几何变化不重新绑定端口或重建Worker。
插件视图宿主入口统一由 `shared/PluginViewPicker.tsx` 提供：主显示区的工具入口、串口标签的显示方式、独立工具标签入口均使用自定义浮层，不使用原生 `<select>`。选择器和共享 `ContextMenu` 通过 portal 挂到 `document.body`，避免标签栏/Pane 的裁剪与原始终端独立宿主的层叠遮挡；portal 事件仍通过共享外点关闭逻辑识别面板内点击。

Windows 每个插件控件拥有独立、无激活的 child HWND 容器，Wry 子 WebView 的父窗口只能是该容器，不能直接使用 Tauri 主窗口。Wry 0.55.1 的 child drop 仍会移除父窗口的 resize/focus subclass；直接挂在主窗口会使关闭、禁用或创建失败后的宿主 WebView 停留在旧尺寸，放大出现黑边、缩小不重排。容器与 WebView 共用可见性，容器按主窗 client 坐标定位并保持在宿主 WebView 上方，WebView 使用容器内 `(0, 0)`；销毁顺序为 WebView → 容器，不重装或替换主窗事件回调。

原生 child 不参与 DOM z-index。菜单/选择器先挂载不可见的可测量面板，由 `usePluginViewOverlay` 提交覆盖矩形并等待原生完成后才显示。`update_plugin_view.occlusions` 至多 64 个 CSS viewport 矩形；Windows 将它们按主 WebView zoom × DPI 转为相对真实容器原点的物理坐标，向外取整并用 `SetWindowRgn` 的差集同时排除绘制和命中。仅菜单覆盖区域让位，未覆盖插件内容继续显示/更新；不使用截图冒充实时视图。布局/位置改变会更新矩形，关闭后移除，嵌套菜单互不清除对方区域。

模态层、通知、页面隐藏及拖拽仍整体抑制控件；嵌套 guard 保留其他层的抑制/裁剪。超过 64 个局部 guard 时退为整体隐藏，不发送越界列表。解除只恢复当前有效可见会话，过期 rect 不能重现已销毁 UI。

隐藏或裁剪更新失败时，退休页面并等待 native destroy 完成后才允许宿主遮挡层绘制；destroy 同样失败则 handshake 拒绝，不把“已发起销毁”当作“已安全让位”。UI hook 保持浮层隐藏、每次打开至多提示一次失败，并提示 Escape 关闭后重试；关闭后的迟到失败不再通知。正常关闭仍异步回收，不延长其他健康页面的生命周期。

故障/禁用/必要撤权/代次变化：serial替换回原始，plugin标签保留宿主不可用页/重试/关闭。不展示冻结模型伪装实时。Worker故障处理其所有实例，单UI异常不拖累健康页面。现有桌面弹出入口不支持插件页面，明确提示，不偷偷打开普通终端代替。

## 状态消息与额度

完整快照只有JSON模型。`boundedPluginViewJson` 先遍历校验 JSON 形状（拒绝 ArrayBuffer/TypedArray/Map/Set、非有限数、访问器、非普通原型、循环、深度 >64、节点 >65536、字符串值/对象键中的孤立 UTF-16 代理项），再序列化一次并按 UTF-8 字节计额，返回规范化副本；二进制容器在遍历阶段即被拒绝，不会先测量再复制大对象。

快照 256 KiB，state 信封 264 KiB；每页面一条在途、一条最新候选，全插件待发送 1 MiB、可见时约 30 次/秒（34 ms 间隔）。状态 ACK 在 UI 回调 Promise 完成后发送；可见且有在途快照时 5 秒未确认即失败。整体隐藏不重置真实数据，但停止显示发送；恢复重发当前模型，不排历史。局部菜单裁剪不把整个页面视为隐藏。

environment 按值去重并在页内 SDK 合并为最新一条，不逐条排队、不占用 16 条待处理消息额度，也不因 resize 塞满 state 后面的队列。标签/实例每插件 8、全应用 16；视图资源单文件 8 MiB、entry/styles/assets 合计 32 MiB；交互载荷 16 KiB 且受约 30 次/秒令牌桶；页面→原生 IPC 单条 16 KiB；普通交互每实例 64 条/秒，ready/state-ack/error 使用独立控制桶（128 条/秒、突发 128），二进制块与确认使用每插件共享桶（512 帧/秒、突发 1024）及 ACK 背压，避免控制 ACK 被交互或慢二进制回调饿死。tabs 创建/管理令牌桶 2/s、突发 4；后台关闭键 128。限额不宣称能够限制插件私自分配的内存。

## 持久化

serial替换偏好 displayView保存在portMeta，走已有CAS安全元数据保存链。plugin独立标签布局描述在session.json，只恢复restoreOnStartup声明；不保存params/模型/句柄/票据。旧无kind串口快照一次迁移为UUID并重写树引用，之后只运行显式类型路径。

恢复等待权威manifest/代次/启用/授权/placement/mode；缺失/禁用/旧代次只恢复宿主占位，不执行代码或恢复授权。旧安装偏好不能自动指向新代码。

## 验证边界

单测覆盖类型化标签/旧快照迁移、独立输入/trigger租约、JSON边界、动作去重/票据/关闭、串行输入/退休及Rust资源/权限/几何验证。视图运行时另有文档代次用例（`document`/`ready` 替换、旧文档 ACK/ready 被忽略、纯网页无 Worker、Worker 重启后存活）与二进制用例（300 KiB 双向逐字节往返、8 KiB 分块计数、导航替换时在途发送被拒绝、迟到确认不影响新文档）；宿主侧单测覆盖 `postViewBinary` 的 bridge ACK 结算、Worker 停止与 `cancelViewBinary` 只拒绝被替换文档的传输；Rust 覆盖 8 KiB 分片信封往返与超限拒绝、可信 origin 稳定性、同源 HTML 导航白名单、缺失 profile 清除不创建目录。Playwright浏览器mock只证明前端工作区/Worker/终端，不证明native隔离。

Windows 原生回归 `retiring_plugin_children_preserves_host_resize` 需安装 WebView2 Runtime，以 `cargo test --lib --manifest-path src-tauri/Cargo.toml retiring_plugin_children_preserves_host_resize -- --ignored` 显式运行；连续销毁插件 child 后，放大/缩小宿主仍须把 WebView2 bounds 同步为最新 client rect。默认单测跳过该原生环境依赖用例。
