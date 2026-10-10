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

## 输入与回收

`pluginViewInput` 按固定端口注册 bytes/lines/none 租约；工具页没有 RX 状态。输入旁路有界，gapBefore与streamEpoch在存活批次之前进入串行解析，重连/模式切换/裁剪/Worker拒绝都会清残帧边界。新会话实时开始，不补历史。

line 租约复用 RxPipeline/RxLineAssembler及协议绑定；没有原始终端仍处理独立 line 输入，不复活 viewportManager 或积压 stock 行队列。字节租约在 serial:data 模式分流前观察，TTY也可用。启用且匹配端口的宿主 trigger rules 也是行消费者，关闭显示不停止既有告警/自动回复。

原始、表格、波形分别持有会话，关闭一个只释放其资源。`releaseUnusedPortState` 保留仍有标签描述/输入消费者的编码/统计/TX历史，最后消费者退休才回收。serial关闭释放 stock viewport/TTY并 discardTerminalQueue，不能向别的视图伪造 disconnected。

Worker close是优先生命周期通道，释放已退休实例事件记账与排队数据，不排在 stalled async 回调后等待。迟到初始化不宣布ready，迟到副作用调用拒绝；已经开始的外部副作用不假装可撤销。

## 布局、原始连续性与错误页

`SerialContentHost` 在Pane树外稳定持有TRX/TTY实例，`tabContentPlacement` 提供布局。跨Pane移动不换组件所有者，原始缓冲/xterm保持；选择插件只隐藏原始显示，输入继续，TTY隐藏不fit零尺寸。

`PluginViewSurface` 提供宿主工具条和native内容矩形。原生控件按layoutRevision只处理最新几何，统一CSS px、主WebView zoom与窗口DPI；clip到client范围。几何变化不重新绑定端口或重建Worker。

原生child不参与DOM z-index。`usePluginViewOverlay` 先等待控件隐藏再绘制宿主modal/context menu/通知；嵌套guard共享完成Promise。页面隐藏/拖拽也抑制控件。解除只恢复当前有效可见会话，过期rect不能重现已销毁UI。

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

本次Windows真实debug可执行文件（生产前端资产）已观察到：独立settings保存经Worker写KV；独立table从SIM原始RX解析持续更新，排序/筛选及后台开波形动作可用，关闭原始后仍更新且实例保持。分屏、宿主设置遮挡恢复、无端口页禁用发送、撤权/禁用不关闭串口，以及清理调试scaffold后的替换→返回原始终端均实跑；TTY探针观察到xterm实例及提示屏跨分屏保留。Child诊断观察到无Tauri globals、网络/主窗/本机/未声明资源访问拒绝、popup及程序化clipboard read拒绝、Worker执行及frame拒绝；恶意导航使页面退休为错误，而非打开外站。临时端口/配置已清理。完整发版仍需最终release安装包和支持平台逐项验收，不能把debug探针或部分负向场景当作全部安全证明。
