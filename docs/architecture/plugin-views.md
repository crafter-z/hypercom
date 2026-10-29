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

资源快照只包含 entry/styles/assets 及宿主 shell/SDK，拒绝 data/、保留命名空间、路径别名、链接/reparse/hardlinks、非普通文件及额度越界。插件脚本为普通 bundle，不直接拼入主窗 React DOM。Native send 只接收 init/state/environment JSON 并转义为 SDK dispatcher 的固定调用，不接受源码 eval。

隔离模式首文档加载前安装 WebView2 策略：一次宿主初始导航、后续顶层/子 frame 导航拒绝；全请求源拦截并静态响应；下载/新窗口/外部协议/拖入/浏览器权限拒绝；HTML 文件选择通过 acknowledged CDP interception 阻断；网络配置和 CSP 叠加防护。必需 COM/CDP 接口不可用时创建失败，不加载插件代码。

**隔离模式明确例外**：浏览器真实用户操作的原生复制/剪切可写系统剪贴板，这是用户选择的边界；隔离页面程序化剪贴板读取及 Worker clipboard API 仍分别受原生拒绝/已有权限约束。可信网页边界见下节。

安装/升级/卸载/禁用/必要撤权及配置备份恢复先使路由失效，控件销毁与代次提交协调，旧消息不能复活新代码。原生事件只定向 main，页面不能订阅全局串口事件。

## 可信网页模式

作者声明与能力说明只维护在[插件开发指南](../plugin-development.md#可信网页模式windows)。`UiView.mode` 缺省 `Isolated`；`TrustedWeb` 需要 HTML 入口和 `trusted-web-view@1`。HTML 字节原样返回，SDK 通过原生初始化脚本注入本地 origin 的顶层文档（非某个精确 URL），DOMContentLoaded 后由原生下发本次导航的 `documentId` 并宣布 native ready。入口 `entry` 可省略（纯网页插件）或视图声明 `worker:false`，此时 `workerEpoch=0`，不建 Worker、不订阅输入、不发布模型、不等待 Worker ACK；Worker ready 协议仅用于依附 Worker 的视图。

**文档生命周期**：允许相同时源内导航/刷新到声明过的 HTML（查询串与锚点参与 URL 但不参与资源路径）；外部 http/https 用户链接与新窗口交给系统浏览器且不获得 SDK，其他协议拒绝，iframe 不注入 SDK。每次顶层导航都使上一文档失效：原生在导航开始时即更换 `documentId`，前端清空在途 ACK、重放当前保留模型，并拒绝旧文档迟到的 ready/ACK/message/二进制块。普通资源错误与慢加载不退休页面，原生进程故障或文档加载失败才报告失败。

**二进制通道**：`view.sendBinary(type, bytes)` / `view.onBinary(cb)` 在 Worker 与 UI 两侧对称，8 KiB 原始字节/块 base64 编码进现有 16 KiB 原生信封，逐块 ACK（异步回调完成后确认），总大小不设业务上限。传输绑定 `viewInstanceId + documentId + workerEpoch`：导航、关闭、换代会拒绝未完成发送、清空接收端半成品，并让迟到的确认无法影响新页面；已在执行的插件异步逻辑不假装被撤销。大块数据不进入实时状态 JSON 合并通道，`boundedPluginViewJson` 仍只用于模型快照。

`PluginConfigEntry.trusted_web_granted` 默认 false，仅 `set_plugin_trusted_web` 主窗命令能够授予。启用与 create/消息均检查实际批准；普通权限不隐含网页信任。升级清除批准，配置恢复保持当前批准但不能新增或复活撤销的信任；撤销同时禁用并退休页面。所有变更复用 plugin_io、expectedGeneration 和 revision 快照。

Windows 可信分支不安装离线/CDP 网络阻断、黑洞代理/DNS、隔离 CSP 或文件选择拦截。仅虚拟本地 origin 被资源拦截，其他浏览器流量按标准 CORS/TLS 运行；Clipboard read 权限限当前存活可信来源，粘贴快捷键恢复，其他浏览器权限拒绝。新窗口/外部协议与离开入口的顶层导航仍拒绝，frames 不注入 SDK。网页不共享主窗权限或 DOM。

`DownloadStarting` 默认取消并获取 deferral，异步原生另存为完成后才设置用户选择路径并放行；不显示自动打开下载的浏览器 UI。待选下载及运行下载由各 Control 拥有，退休取消并完成 deferral，迟到对话框不能写文件。Control 析构不能访问其他 thread_local 表，避免退出时表析构顺序导致崩溃；移除控件后在 RefCell 借用之外析构。

持久目录由 `plugin::web_data_dir` 定位至 `<config_dir>/plugin-web-data/<pluginId>`，不在插件可写包树。升级保留，普通关闭不删除。清除/卸载先退休全部视图，再创建相同环境选项的隐藏维护控件，等待 Profile2.ClearBrowsingDataAll 完成后关闭；不直接删除浏览器仍占用的目录。全部站点数据被清除，空 profile 文件可保留。维护期间 plugin_io 阻止并发创建，清除失败如实返回。

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

Binding 区分 tabSessionId、viewInstanceId、workerEpoch、streamEpoch和installGeneration。关闭重开、切换视图或故障重试创建新实例；隐藏、焦点及分屏移动保留。原生 ready 和 Worker 初始化完成必须同时满足，才显示页面/发布模型；各自期限和 ACK失败产生可观察的错误。

主窗 runtime 的原生监听注册也绑定启动代次：停止后迟到的注册立即解除，旧回调和重复 cleanup 不得操作后续 runtime。React StrictMode 的启动→停止→启动不能留下第二条可用原生消息通道。

## 输入与回收

`pluginViewInput` 按固定端口注册 bytes/lines/none 租约；工具页没有 RX 状态。输入旁路有界，gapBefore与streamEpoch在存活批次之前进入串行解析，重连/模式切换/裁剪/Worker拒绝都会清残帧边界。新会话实时开始，不补历史。

line 租约复用 RxPipeline/RxLineAssembler及协议绑定；没有原始终端仍处理独立 line 输入，不复活 viewportManager 或积压 stock 行队列。字节租约在 serial:data 模式分流前观察，TTY也可用。启用且匹配端口的宿主 trigger rules 也是行消费者，关闭显示不停止既有告警/自动回复。

原始、表格、波形分别持有会话，关闭一个只释放其资源。`releaseUnusedPortState` 保留仍有标签描述/输入消费者的编码/统计/TX历史，最后消费者退休才回收。serial关闭释放 stock viewport/TTY并 discardTerminalQueue，不能向别的视图伪造 disconnected。

Worker close是优先生命周期通道，释放已退休实例事件记账与排队数据，不排在 stalled async 回调后等待。迟到初始化不宣布ready，迟到副作用调用拒绝；已经开始的外部副作用不假装可撤销。

TTY 同端口发送串行排队时，插件请求必须在实际发送开始前同步复核 Worker/请求仍存活、安装代次和当前授权；视图发送还复核原实例/标签/输入资格，绑定目标不变。停止、超时、升级、撤权或关闭发生在排队期间会拒绝尚未开始的发送，已开始的后端 I/O 仍不假装撤销。

## 布局、原始连续性与错误页

`SerialContentHost` 在Pane树外稳定持有TRX/TTY实例，`tabContentPlacement` 提供布局。跨Pane移动不换组件所有者，原始缓冲/xterm保持；选择插件只隐藏原始显示，输入继续，TTY隐藏不fit零尺寸。

`PluginViewSurface` 提供宿主工具条和native内容矩形。原生控件按layoutRevision只处理最新几何，统一CSS px、主WebView zoom与窗口DPI；clip到client范围。几何变化不重新绑定端口或重建Worker。
插件视图宿主入口统一由 `shared/PluginViewPicker.tsx` 提供：主显示区的工具入口、串口标签的显示方式、独立工具标签入口均使用自定义浮层，不使用原生 `<select>`。选择器和共享 `ContextMenu` 通过 portal 挂到 `document.body`，避免标签栏/Pane 的裁剪与原始终端独立宿主的层叠遮挡；portal 事件仍通过共享外点关闭逻辑识别面板内点击。

Windows 每个插件控件拥有独立、无激活的 child HWND 容器，Wry 子 WebView 的父窗口只能是该容器，不能直接使用 Tauri 主窗口。Wry 0.55.1 的 child drop 仍会移除父窗口的 resize/focus subclass；直接挂在主窗口会使关闭、禁用或创建失败后的宿主 WebView 停留在旧尺寸，放大出现黑边、缩小不重排。容器与 WebView 共用可见性，容器按主窗 client 坐标定位并保持在宿主 WebView 上方，WebView 使用容器内 `(0, 0)`；销毁顺序为 WebView → 容器，不重装或替换主窗事件回调。

原生 child 不参与 DOM z-index。菜单/选择器先挂载不可见的可测量面板，由 `usePluginViewOverlay` 提交覆盖矩形并等待原生完成后才显示。`update_plugin_view.occlusions` 至多 64 个 CSS viewport 矩形；Windows 将它们按主 WebView zoom × DPI 转为相对真实容器原点的物理坐标，向外取整并用 `SetWindowRgn` 的差集同时排除绘制和命中。仅菜单覆盖区域让位，未覆盖插件内容继续显示/更新；不使用截图冒充实时视图。布局/位置改变会更新矩形，关闭后移除，嵌套菜单互不清除对方区域。

模态层、通知、页面隐藏及拖拽仍整体抑制控件；嵌套 guard 保留其他层的抑制/裁剪。超过 64 个局部 guard 时退为整体隐藏，不发送越界列表。解除只恢复当前有效可见会话，过期 rect 不能重现已销毁 UI。

隐藏或裁剪更新失败时，退休页面并等待 native destroy 完成后才允许宿主遮挡层绘制；destroy 同样失败则 handshake 拒绝，不把“已发起销毁”当作“已安全让位”。正常关闭仍异步回收，不延长其他健康页面的生命周期。

故障/禁用/必要撤权/代次变化：serial替换回原始，plugin标签保留宿主不可用页/重试/关闭。不展示冻结模型伪装实时。Worker故障处理其所有实例，单UI异常不拖累健康页面。现有桌面弹出入口不支持插件页面，明确提示，不偷偷打开普通终端代替。

## 状态消息与额度

完整快照只有JSON模型。`boundedPluginViewJson` 拒绝ArrayBuffer/TypedArray/Map/Set/非有限数/循环或过深对象，并保留规范化JSON；不测JSON.stringify大小后再复制原始二进制对象。

快照256KiB，native envelope264KiB；每页面一条在途、一条最新候选，全插件待发送1MiB、可见约30次/秒。ACK在UI回调Promise完成后发送。整体隐藏不重置真实数据，但停止显示发送；恢复重发当前模型，不排历史。局部菜单裁剪不把整个页面视为隐藏。

environment按值去重并在native SDK合并待处理最新变化，不因resize塞满state后面的队列。标签/实例每插件8、全应用16；UI JS8MiB、资源32MiB；交互16KiB及频率限制；tabs创建/管理令牌桶2/s、突发4；后台关闭键128。限额不宣称能够限制插件私自分配的内存。

## 持久化

serial替换偏好 displayView保存在portMeta，走已有CAS安全元数据保存链。plugin独立标签布局描述在session.json，只恢复restoreOnStartup声明；不保存params/模型/句柄/票据。旧无kind串口快照一次迁移为UUID并重写树引用，之后只运行显式类型路径。

恢复等待权威manifest/代次/启用/授权/placement/mode；缺失/禁用/旧代次只恢复宿主占位，不执行代码或恢复授权。旧安装偏好不能自动指向新代码。

## 验证边界

单测覆盖类型化标签/旧快照迁移、独立输入/trigger租约、JSON边界、动作去重/票据/关闭、串行输入/退休及Rust资源/权限/几何验证。Playwright浏览器mock只证明前端工作区/Worker/终端，不证明native隔离。

Windows 原生回归 `retiring_plugin_children_preserves_host_resize` 需安装 WebView2 Runtime，以 `cargo test --lib --manifest-path src-tauri/Cargo.toml retiring_plugin_children_preserves_host_resize -- --ignored` 显式运行；连续销毁插件 child 后，放大/缩小宿主仍须把 WebView2 bounds 同步为最新 client rect。默认单测跳过该原生环境依赖用例。

2026-10-10 resize 修复另以真实 Windows debug 应用 + Vite 前端、隔离临时配置实跑系统窗口边框拖拽：插件显示、关闭、禁用及重建后均能放大/缩小；最终构建销毁插件后 client/宿主 WebView 同步为 1330×840、1220×769，DOM 根随 viewport 重排。桌面截图确认插件内容可见且贴合内容区，宿主设置弹窗期间容器隐藏。此验证不替代 release 安装包与原生安全发布门。

2026-10-19 菜单与入口回归以真实 Windows debug 二进制、Vite 前端和隔离临时配置在独立测试桌面运行，未切换用户桌面或注入桌面输入。`PrintWindow` 截图确认 settings 标签右键菜单与剩余插件内容同时可见；原生容器保持 visible，菜单区域不在 HWND region 中，未覆盖区域仍在。宿主加号与侧边栏按钮聚焦同一 settings UUID；普通 COM1 标签加号列出 table/settings/wave，并成功显示绑定 COM1 的原生 Sensor table，端口保持 disconnected。构建、1009 项 Vitest、311 项 Rust（另 1 项跳过）及 34 项 mock IPC Playwright 通过；此验证不替代完整原生安全发布门。

本次Windows真实debug可执行文件（生产前端资产）已观察到：独立settings保存经Worker写KV；独立table从SIM原始RX解析持续更新，排序/筛选及后台开波形动作可用，关闭原始后仍更新且实例保持。分屏、宿主设置遮挡恢复、无端口页禁用发送、撤权/禁用不关闭串口，以及清理调试scaffold后的替换→返回原始终端均实跑；TTY探针观察到xterm实例及提示屏跨分屏保留。Child诊断观察到无Tauri globals、网络/主窗/本机/未声明资源访问拒绝、popup及程序化clipboard read拒绝、Worker执行及frame拒绝；恶意导航使页面退休为错误，而非打开外站。临时端口/配置已清理。完整发版仍需最终release安装包和支持平台逐项验收，不能把debug探针或部分负向场景当作全部安全证明。

### 2026-10-10 发版前代码审查补充

- 已审查 Worker 启动取消、installGeneration/epoch 身份、当前授权过滤、RPC 超时/stop 后迟到响应、优先 close 与控制/RX 背压；视图 open/ready/retire/retry、固定端口输入租约/断流、状态合并/ACK/隐藏恢复；raw Wry child 销毁顺序、资源只读内存快照、主窗来源与固定绑定发送目标。原同步 `sendToPort` 探针观察到 backend send 先于随后撤权启动；集成新增 TTY ordered lane 后存在真实排队边界，因此通过 beforeSend 在 serial IPC 前重新执行请求/实例授权。backend 资产读写在有界 FIFO gate 后检查当前授权，文件选择在对话框返回后复核安装代次。已开始副作用仍不宣称可撤销。
- 修复监听注册竞态：停止首轮、立即启动第二轮，再完成两次原生 listen 注册的独立运行探针，修复前观测两条注册但 cleanup 只解除第二条，首条泄漏。回归场景要求旧消息不能使新实例退休、两条注册都解除，旧 cleanup 不能停止新 runtime。
- 修复遮挡握手过早完成：可见页面 hide 拒绝、destroy 保持 pending 的独立运行探针，修复前观测 `update-true → update-false → destroy-start → overlay-ready`，未等到实际 destroy。回归场景覆盖 destroy 完成后才 ready，以及 destroy 拒绝时不 ready。observer、pointer/visibility 和 release 的内部更新显式记录拒绝，不产生未处理 Promise；显式 guard.ready 仍保留拒绝语义，不把失败转成 ready。此探针只证明宿主 Promise 顺序，不证明原生 HWND 的隔离或可见性。
- 本轮集成执行975项Vitest、309项Windows Rust（另1项默认跳过）、32项mock IPC Playwright及显式WebView2 child退休resize用例，通过。生产资产/CSP的真实debug应用打开raw Wry工具页并有桌面截图，正常宿主设置遮挡/恢复已观察；故障hide/destroy与队列撤权由行为回归覆盖，未伪称原生故障注入。最终release安装包仍须完整原生安全矩阵和支持平台逐项验收。

### 2026-10-29 可信网页原生验收

Windows debug 二进制使用生产前端资产、独立配置与测试桌面实跑：独立确认/取消、未批准启用拒绝、HTML/模块/查询参数、localhost 8723 HTTP/SSE 与 8724 WebSocket、真实日志选择器、Clipboard API 读写、Blob 另存为与取消、重启 localStorage/IndexedDB 保留、同插件双原生控件、升级撤信任且保数据、旧代次授权拒绝、清数据及卸载重装后为空、撤信任后迟到下载不落盘。隔离视图仍拒绝 localhost 请求。发现并修复下载表 thread_local 析构依赖；可信和隔离控件存活时退出已观察进程码 0。该记录不代替最终安装包、真实模型端点或其他平台验收。

### 2026-10-29 插件能力放宽原生验收

Windows debug 二进制（生产前端资产）与独立配置、测试桌面、本机自带 HTTP 服务：普通 Worker 插件完成 17 MiB + 1 字节二进制私有写入/读回、5 MiB KV、空文件与空剪贴板；HTTP 完整响应 2 097 408 字节、1 MiB + 1 字节二进制请求/响应回声、`manual`/`error` 重定向、默认跟随重定向后 URL 正确、16 秒慢响应（无隐式 15 秒上限）、SSE 首块 3 ms 且逐事件到达、pending 连接 abort、迭代器 pending abort、提前 break 取消、显式 `timeout` 生效；`urlWhitelist` 非空时拒绝跳转出白名单。启动后未处理拒绝保留 Worker 内存状态（计数 41→42）。重载已安装代码后日志标记从 A 变为 B，安装代次/权限/网页信任与 17 MiB 数据保持不变且视图重建；同版本安装先被拒绝（`plugin_replace_confirmation_required`），显式替换后新代次、禁用、清权且数据保留。完全省略 `entry` 的纯 HTML 插件可打开，声明的第二页本地导航、刷新、localStorage 与 SDK 均正常；Worker 依附的可信页完成 1 MiB + 17 字节 UI→Worker→UI 双向二进制往返（逐字节校验）；隔离视图仍渲染 Worker 模型并拒绝网络。依赖视图与二进制传输存活时退出进程码 0。该记录不替代最终安装包、跨平台或无限内存/真实模型端点验收。
