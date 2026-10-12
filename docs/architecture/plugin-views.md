# 插件隔离 UI 与工作区标签

本模块是当前实现契约。支持在原始串口标签替换内容，或额外创建独立插件标签；独立标签可以绑定端口，也可以是无端口工具页面。作者接口、manifest 和打包说明只维护在[插件开发指南](../plugin-development.md#隔离-ui-与工作区标签)。

## 承载与平台边界

- Windows 使用 `plugin/view_runtime/windows.rs` 的 raw Wry 子 WebView，嵌入主窗口标签内容矩形，不创建额外桌面窗。
- 不经过 Tauri WebviewBuilder，不注入 Tauri 初始化脚本、invoke key、通用命令、事件或 channel-fetch。UI 仅有 host SDK `view` 和专用 IPC；后端由 native Session 闭包确定身份，不接受页面自报 pluginId。
- 每控件独立临时目录/incognito 浏览器上下文，静态资源加载使用本实例随机 HTTPS origin 的原生内存响应，不放行网络 fallback。
- macOS/Linux 当前没有通过原生策略验收的 adapter，创建明确拒绝，不以主窗 iframe 或文本面板代替。原有 Worker/文本面板功能不受此平台门控影响。
- 独立 DOM/来源/存储与原生能力不等于独立 OS 进程，也不是 CPU/堆内存硬配额。

## 原生安全执行点

`plugin/view_runtime/mod.rs` 的 create/update/send/destroy 检查真实来源 WebView 为 main。create 在 plugin_io 中验证启用、installGeneration、声明视图/placement/input、授权、当前端口/mode及资源，随后进入 UI 线程创建控件。状态提交和原生调用不跨 await 持有 config mutex。

资源快照只包含 entry/styles/assets 及宿主 shell/SDK，拒绝 data/、保留命名空间、路径别名、链接/reparse/hardlinks、非普通文件及额度越界。插件脚本为普通 bundle，不直接拼入主窗 React DOM。Native send 只接收 init/state/environment JSON 并转义为 SDK dispatcher 的固定调用，不接受源码 eval。

首文档加载前安装 WebView2 策略：一次宿主初始导航、后续顶层/子 frame 导航拒绝；全请求源拦截并静态响应；下载/新窗口/外部协议/拖入/浏览器权限拒绝；HTML 文件选择通过 acknowledged CDP interception 阻断；网络配置和 CSP 叠加防护。必需 COM/CDP 接口不可用时创建失败，不加载插件代码。

**明确例外**：浏览器真实用户操作的原生复制/剪切可写系统剪贴板，这是用户选择的边界；程序化剪贴板读取及 Worker clipboard API仍分别受原生拒绝/已有权限约束。禁止宣称完全封锁所有剪贴板写入。

安装/升级/卸载/禁用/必要撤权及配置备份恢复先使路由失效，控件销毁与代次提交协调，旧消息不能复活新代码。原生事件只定向 main，页面不能订阅全局串口事件。

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

Windows 每个插件控件拥有独立、无激活的 child HWND 容器，Wry 子 WebView 的父窗口只能是该容器，不能直接使用 Tauri 主窗口。Wry 0.55.1 的 child drop 仍会移除父窗口的 resize/focus subclass；直接挂在主窗口会使关闭、禁用或创建失败后的宿主 WebView 停留在旧尺寸，放大出现黑边、缩小不重排。容器与 WebView 共用可见性，容器按主窗 client 坐标定位并保持在宿主 WebView 上方，WebView 使用容器内 `(0, 0)`；销毁顺序为 WebView → 容器，不重装或替换主窗事件回调。

原生child不参与DOM z-index。`usePluginViewOverlay` 先等待控件隐藏再绘制宿主modal/context menu/通知；嵌套guard共享完成Promise。页面隐藏/拖拽也抑制控件。解除只恢复当前有效可见会话，过期rect不能重现已销毁UI。

隐藏更新失败时，退休页面并等待 native destroy 完成后才允许宿主遮挡层绘制；destroy 同样失败则 handshake 拒绝，不把“已发起销毁”当作“控件已隐藏”。正常关闭仍异步回收，不延长其他健康页面的生命周期。

故障/禁用/必要撤权/代次变化：serial替换回原始，plugin标签保留宿主不可用页/重试/关闭。不展示冻结模型伪装实时。Worker故障处理其所有实例，单UI异常不拖累健康页面。现有桌面弹出入口不支持插件页面，明确提示，不偷偷打开普通终端代替。

## 状态消息与额度

完整快照只有JSON模型。`boundedPluginViewJson` 拒绝ArrayBuffer/TypedArray/Map/Set/非有限数/循环或过深对象，并保留规范化JSON；不测JSON.stringify大小后再复制原始二进制对象。

快照256KiB，native envelope264KiB；每页面一条在途、一条最新候选，全插件待发送1MiB、可见约30次/秒。ACK在UI回调Promise完成后发送。隐藏/宿主遮挡不重置真实数据，但停止显示发送；恢复重发当前模型，不排历史。

environment按值去重并在native SDK合并待处理最新变化，不因resize塞满state后面的队列。标签/实例每插件8、全应用16；UI JS8MiB、资源32MiB；交互16KiB及频率限制；tabs创建/管理令牌桶2/s、突发4；后台关闭键128。限额不宣称能够限制插件私自分配的内存。

## 持久化

serial替换偏好 displayView保存在portMeta，走已有CAS安全元数据保存链。plugin独立标签布局描述在session.json，只恢复restoreOnStartup声明；不保存params/模型/句柄/票据。旧无kind串口快照一次迁移为UUID并重写树引用，之后只运行显式类型路径。

恢复等待权威manifest/代次/启用/授权/placement/mode；缺失/禁用/旧代次只恢复宿主占位，不执行代码或恢复授权。旧安装偏好不能自动指向新代码。

## 验证边界

单测覆盖类型化标签/旧快照迁移、独立输入/trigger租约、JSON边界、动作去重/票据/关闭、串行输入/退休及Rust资源/权限/几何验证。Playwright浏览器mock只证明前端工作区/Worker/终端，不证明native隔离。

Windows 原生回归 `retiring_plugin_children_preserves_host_resize` 需安装 WebView2 Runtime，以 `cargo test --lib --manifest-path src-tauri/Cargo.toml retiring_plugin_children_preserves_host_resize -- --ignored` 显式运行；连续销毁插件 child 后，放大/缩小宿主仍须把 WebView2 bounds 同步为最新 client rect。默认单测跳过该原生环境依赖用例。

2026-10-10 resize 修复另以真实 Windows debug 应用 + Vite 前端、隔离临时配置实跑系统窗口边框拖拽：插件显示、关闭、禁用及重建后均能放大/缩小；最终构建销毁插件后 client/宿主 WebView 同步为 1330×840、1220×769，DOM 根随 viewport 重排。桌面截图确认插件内容可见且贴合内容区，宿主设置弹窗期间容器隐藏。此验证不替代 release 安装包与原生安全发布门。

本次Windows真实debug可执行文件（生产前端资产）已观察到：独立settings保存经Worker写KV；独立table从SIM原始RX解析持续更新，排序/筛选及后台开波形动作可用，关闭原始后仍更新且实例保持。分屏、宿主设置遮挡恢复、无端口页禁用发送、撤权/禁用不关闭串口，以及清理调试scaffold后的替换→返回原始终端均实跑；TTY探针观察到xterm实例及提示屏跨分屏保留。Child诊断观察到无Tauri globals、网络/主窗/本机/未声明资源访问拒绝、popup及程序化clipboard read拒绝、Worker执行及frame拒绝；恶意导航使页面退休为错误，而非打开外站。临时端口/配置已清理。完整发版仍需最终release安装包和支持平台逐项验收，不能把debug探针或部分负向场景当作全部安全证明。

### 2026-10-10 发版前代码审查补充

- 已审查 Worker 启动取消、installGeneration/epoch 身份、当前授权过滤、RPC 超时/stop 后迟到响应、优先 close 与控制/RX 背压；视图 open/ready/retire/retry、固定端口输入租约/断流、状态合并/ACK/隐藏恢复；raw Wry child 销毁顺序、资源只读内存快照、主窗来源与固定绑定发送目标。原同步 `sendToPort` 探针观察到 backend send 先于随后撤权启动；集成新增 TTY ordered lane 后存在真实排队边界，因此通过 beforeSend 在 serial IPC 前重新执行请求/实例授权。backend 资产读写在有界 FIFO gate 后检查当前授权，文件选择在对话框返回后复核安装代次。已开始副作用仍不宣称可撤销。
- 修复监听注册竞态：停止首轮、立即启动第二轮，再完成两次原生 listen 注册的独立运行探针，修复前观测两条注册但 cleanup 只解除第二条，首条泄漏。回归场景要求旧消息不能使新实例退休、两条注册都解除，旧 cleanup 不能停止新 runtime。
- 修复遮挡握手过早完成：可见页面 hide 拒绝、destroy 保持 pending 的独立运行探针，修复前观测 `update-true → update-false → destroy-start → overlay-ready`，未等到实际 destroy。回归场景覆盖 destroy 完成后才 ready，以及 destroy 拒绝时不 ready。observer、pointer/visibility 和 release 的内部更新显式记录拒绝，不产生未处理 Promise；显式 guard.ready 仍保留拒绝语义，不把失败转成 ready。此探针只证明宿主 Promise 顺序，不证明原生 HWND 的隔离或可见性。
- 本轮集成执行975项Vitest、309项Windows Rust（另1项默认跳过）、32项mock IPC Playwright及显式WebView2 child退休resize用例，通过。生产资产/CSP的真实debug应用打开raw Wry工具页并有桌面截图，正常宿主设置遮挡/恢复已观察；故障hide/destroy与队列撤权由行为回归覆盖，未伪称原生故障注入。最终release安装包仍须完整原生安全矩阵和支持平台逐项验收。
