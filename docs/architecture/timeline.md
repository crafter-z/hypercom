# 时间联动与只读回放

时间联动同步**采集侧时间锚点**，不是像素、滚动百分比或端口行号，也不提供硬件时钟精密同步。只支持主窗口的 TRX、主动注册时间能力的插件和独立回放标签；TTY 与弹出窗口不参与。

## 模块与身份

- `src/utils/timeline/coordinator.ts` 的 `timelineCoordinator` 是 app-lifetime 权威实例，持有组描述、成员、映射、transport、preview/committed anchor 与导航代次。不会把每帧游标写入 AppConfig 或 Zustand。
- `src/utils/timeline/scheduler.ts` 的 `TimelineScheduler` 维护每目标一条在途和一条最新候选；commit 优先。成员独立完成，不等待最慢成员。
- `src/utils/timeline/trxTimelineAdapter.ts` 的 `createTrxTimelineAdapter` 连接共享终端引擎；实时以真实 portId 选择数据源，回放注入独立 manager/sourceId，不创建假串口。
- `src/utils/terminalNavigation.ts` 的 `TerminalNavigationLifecycle` 只从显式垂直滚动意图取得驾驶权。裸 scroll 只能采样已有手势，不改变 scrollLocked；Ctrl+wheel、横向滚动、焦点与普通行点击都不驱动组。
- `src/components/MainDisplay/TimelineControls.tsx` 提供链条入口、成员管理、常量偏移和事件 T+0 对齐；管理弹窗是窄幅单列（460px）密集布局，当前组条直接给出「移出此视图」与「解散联动组」，不需要展开「高级设置」，仅拖动方式、时间基准/偏移与对齐状态留在高级设置；两个成员时只保留解散（移出会留下单成员组）。工作区宿主只挂载管理弹窗，不额外显示组条或“返回实时”。终端壳只订阅稳定组资格与 Pin 所需的布尔状态；热游标不使行进入 React。

portId 是发送目标，sourceId 是数据来源，tabId 是持久工作区槽位，participantId/generation 是运行实例。组成员引用 tabId；切 Pane 不改变组身份。切换 raw/plugin 时只注册当前有效内容的适配器，不驱动隐藏 raw。instance/document、source/clock、mapping 与 navigation 版本分别校验，不互相替代。

## 时间与定位契约

映射唯一公式：`组时间 = groupTimeMs + 源时间 - sourceTimeMs`，斜率固定为 1。相同来源的 raw/plugin 共用源映射；正偏移把源事件放到更晚的组时间。原始记录不被改写，connectedAt 不是共同零点。

视口默认以中心记录驱动；目标查询不晚于目标时间的最近可见记录，重复时间用稳定 seq 排序。源视图不会因自己的广播被吸附到另一条同毫秒记录。边界夹紧和实际误差只属于成员结果，不反写组时间。结果区分 exact、nearest、before/after-range、no-time、filtered、held、loading、unsupported、unavailable、slow 与 error。

`TerminalTimeIndex` 按 `(time, seq)` 维护有序索引，不在按 seq 排列的记录上假定时间单调做二分。过滤和 frozen 上界参与有效索引；裁剪删除对应索引条目，clear/replace/source 换代使旧请求失效。未知时间保持未知，显示 `—`，不能用 0 或当前时间补造事件时间。

## 对不齐与异常场景兜底

成员快照 `TimelineMemberSnapshot` 的 `state`（active / temporarilyDetached / unavailable）、`status`、`reason`、`pending`、`inFlight` 是引擎与 UI 之间唯一的对不齐信号。

- `TimelineCoordinator.publish` 只在该成员 `state === 'active'` 时展开上一次定位结果：不可用、时钟不兼容或暂离的成员不会继续上报陈旧的 status / actualTimeMs / deltaMs；`pending`、`inFlight`、`preview` 仍照常反映调度状态。重新可用时由 `realign` 立即按当前组目标重发，旧结果被新 ACK 覆盖。
- 早于/晚于保留范围由 `TerminalTimeIndex.lookup` 夹紧到首/末记录并给出 before-range / after-range；全无可靠时间为 no-time，目标被本地过滤为 filtered，索引重建中为 loading。协调器据此算出 `deltaMs`，偏差只写在成员结果里，不反写组时间。
- `held`（选区保护、暂停冻结、LIVE 尾随）只暂缓一次定位并立即结算，不会占住调度在途槽；恢复路径是渲染时重投 `heldTimelineRequest`、document `selectionchange` 与 `TerminalView` 的 `localViewKey` 变更 realign。
- 时间索引重建期：`TerminalViewportManager.waitForTimeIndex` 用**停滞**预算（`TERMINAL_TIME_INDEX_WAIT_TIMEOUT_MS`，随 `indexBuildProgress` 续期）而不是墙钟上限——分块重建靠被浏览器夹到 ~4ms 的嵌套定时器推进，健康重建可能合法地跑很多秒；只有「无进展」持续一个预算才以 `unsupported` 结算，commit 分支在被重建取消后最多再等一次，既不永久挂起等待者，也不无限重试。
- 时钟世代：`updateSourceGeneration` 只在 epoch 真正变化时把来源加入 `unconfirmedSources`；来源重新报告已确认的 epoch（该来源 mapping 的 `clockEpoch`，否则 `referenceClock.epoch`）时清除闩锁，瞬时 epoch 丢失可自愈，真不同 epoch 仍要求显式映射（`compatible` 为 false → state unavailable、reason mapping-required）。
- 组不硬对齐不兼容来源：`supportsLive` 只接受全部 live + 宿主时钟；`setMode` 对跨时间域抛错，`stopUnsupportedLive` 在注册参与者或加成员时退出 LIVE；`updateCapabilities` 只在 `canDrive` 转 false 时失效驾驶租约。
- 退化组不留幽灵：`removeMember` 移除最后一个成员后直接删除该组，`restoreState` 跳过全槽位失效或空成员列表的组，`exportState` 因此不再携带不可达的组（不再占用组序号与默认配色）。
- UI 侧由 `TimelineControls` 承担可见兜底：成员行按 tone 标出未对齐状态与实际时间/差值（时钟域不同或不可用只显示中性的「暂不可用」，不展开机器原因），组条汇总「N 个视图未对齐／对齐中…」；整组不可用时在面板主体给出提示。时钟基准不一致按行为兜底处理——不弹提示、不硬对齐，`reason` 与「各自当前位置为 T+0」/常量偏移仍留在「高级设置」。

## 模式、驾驶权与调度

- BROWSE：独立浏览与显式时间导航。UI 新建组沿用发起者原有 Pin 意图：原本已跟随且成员兼容 LIVE 时保留实时跟随，否则从当前中心进入浏览；程序化创建与会话恢复仍默认浏览。加入已有组不取得驾驶权。
- LIVE：通过终端现有滚动锁定 Pin 显式开启整组跟随，再点 Pin 关闭并进入 BROWSE；不另设“返回实时”入口。使用确认过的宿主参考时钟，不以所有来源最后输出的最小值拖慢组。无输出成员可以显示较早实际记录与差值。回放/混合或非宿主时钟组不能开启 LIVE；运行中加入不兼容来源也会退出 LIVE。
- PLAYBACK：只允许回放来源；用户导航立即暂停。实时与回放混组只浏览，跨时间域必须由用户建立映射。

preview 可丢弃，committed 是最终逻辑目标。每次手势携带 owner、gestureId/navigationEpoch、requestSeq、mappingRevision 和 participant/source 版本。新驾驶者抢占后，旧 release/settle/ACK 不得提交。ACK 表示定位回调与本地 render pass 完成，不代表多个 WebView 已物理同帧呈现。

拖动策略为 auto、continuous、on-release。on-release 时 followers 保持原位，仅更新轻量预览，结束后应用最终目标。continuous 是显式连续意图：支持预览的成员在滚动期间持续定位，帧压力不得把它改成松开后定位；慢 ACK/超时只降低预览频率，仍受单在途与最新候选背压约束，不额外并发。auto 对未观测定位延迟或 commit-only 成员保守延期，之后按近期定位 ACK 延迟和前台帧压力降级，允许退到 on-release；同一手势只降档。commit-only 成员不因选择 continuous 而被强行调用预览，隐藏成员与后台窗口也不例外放行。手动切换策略清理旧档位与待发预览，并按新策略处理当前最新目标，不抢驾驶权。ACK 延迟包含等待 render/rAF，以预览周期（`1000 / TIMELINE_BUDGET.previewHz`）判断是否跟得上，不能与仅约束同步批处理的 `batchMs` 比较。预算常量集中于 `TIMELINE_BUDGET`，它们是调度起点，不是已保证的帧率。降级丢弃中间预览，但不能吞最终 commit。

超时只标慢并合作取消，不假装旧 Promise 已被终止；旧回调不结束时仍占一条在途，不能通过无限并发绕过背压。健康成员继续工作。窗口 pointerup/mouseup、cancel、blur、visibility 收尾与静默 settle 合并，最终实际 geometry 在 rAF 读取。平台不能识别原生滚动条意图时，不广播无归因 scroll；可用“按当前位置对齐”可靠提交。

## 本地状态与生命周期

组成员资格不复用 scrollLocked；现有 Pin 在组内控制组 transport，亮态只取 `mode === 'live'`，不取成员残留的独立 scrollLocked。协调器通过 `setLiveFollow` 同步授权/撤销同参考有效偏移的 TRX 原生尾随，RX 每帧直接钉最新可见末行；普通浏览和存在相对时间偏移的成员继续按组时间 seek，不得用本地末行覆盖映射。来源/时钟不支持 LIVE 时 Pin 禁用并说明原因，其余组内 Pin 可用。Pin 切换先取消本地待 settle 手势，再按协调器当前状态切换并使旧导航代次失效；独立 Pin 则同步写 manager lock 后更新本地配置。退出保持当前位置并关闭独立跟随。成员手动滚到尾部或关闭搜索不自动返回 LIVE；点击“滚动到底部”则与点亮 Pin 共用显式跟随路径，取消旧手势并开启整组 LIVE，已 LIVE 时保持开启，不把成员强行跳到本地末行覆盖时间映射。不兼容 LIVE 的组仍只进行一次跳底与浏览定位。搜索栏的打开、输入与关闭不改变跟随或播放状态；显式命中导航先进入浏览再定位并广播，关闭搜索不自动复锁。过滤/编码/HEX/暂停仅本地改变，然后按当前组目标重定位。

有效选区延迟外部定位，清除后仅应用最新目标。暂停保留 frozen 上界，RX 仍继续。隐藏成员不积压历史目标，恢复只定位最新目标。TTY、未适配插件和弹出内容保留组成员描述但标不可用。关闭标签退休成员与 lane，不断串口、不停后端日志。

## 独立多轨回放

`ReplayTabItem` 是独立 kind，`getTabPortId`/`getActivePortId` 对它返回 null。`ReplayDocument` 实现共享只读 `TerminalSource`；`TerminalView` 注入 manager 与本地显示配置，复用渲染、搜索、高亮和复制，不向实时 ring/RX/trigger/plugin 输入旁路追加历史，不统计流量或发送串口。

专用宿主命令 `pick_replay_sources`、`read_replay_source_chunk`、`release_replay_sources` 由主窗口原生选择器授予只读句柄，后续只收 grant/source 身份，不收任意路径。旧 `read_text_file` 的日志根目录限制没有放宽。分块读取要求严格顺序 offset，逐块校验元数据，并将实际交付流 SHA256 与初始指纹、EOF 重新读取文件的指纹双重比对；文件修改或消失均拒绝。恢复只保存来源描述，原生重选后路径、大小和指纹须与原描述匹配才重新授权。

首版支持 UTF-8 文本和 HEX 文本：最多 16 文件、单文件 32 MiB、会话总文件 64 MiB、500,000 记录、192 MiB 解码内存。超限拒绝并提示，不静默截断。完整导入历史不受实时 maxDisplayLines 裁剪；不承诺无限文件或分页。导入按分块执行并可取消；原始 binary/GBK 不在首版支持范围。

用户确认轨道、分片顺序、格式和记录机 UTC 偏移；不从同名文件自动合并会话，也不从 ctime/mtime/文件名推导事件时间。未知时间行保留顺序与上下文，全无可靠时间的轨道只独立查看。回拨分段需要明确选择时段后才参加联动。

播放是“完整历史 + 游标移动”，不是发送或逐行 append。`ReplayClock` 以单调时钟结算游标，换速先结算旧速度，保留真实长间隔；组范围用轨道并集，不被最短轨道截断。来源描述和组描述随会话保存，恢复默认浏览/暂停，不持久化运行句柄、preview、owner、ACK 队列或日志模型。

## 验证与操作边界

TRX 来源的 `clockEpoch` 目前没有生产者：`TerminalBuffer` 未实现 `getClockEpoch`，`trxTimelineAdapter.refreshSource` 因此恒得 undefined，真实时钟回拨不会触发生成世代门禁；回放侧由 `ReplayDocument.segments` 与显式分段选择覆盖。跨时间域仍按显式 mapping 处理，不靠隐式推断。

单元测试覆盖版本/背压/乱序/过滤/冻结/只读数据源和时钟；Playwright 的真实 Chromium 几何测试覆盖百万行首中尾与字体/缩放极值。联动输入回归显式保留原生滚动条，通过真实 thumb 拖动和 wheel 输入，在持续帧压力下验证松开前的多次定位与 on-release 原位保持；设置 `HYPERCOM_E2E_CHANNEL=msedge` 可用本机 Edge 复核同组输入测试，但不能据此声称已覆盖 Tauri WebView2 宿主。`TerminalPerformance.test.ts` 需显式设置 `HYPERCOM_TERMINAL_BENCH=1`，输出索引与 jsdom CPU 样本，不把它当作物理帧率。

Windows/WebView2 原生测试在独立临时 profile/隐藏 HWND 中运行。`workerless_timeline_native_webview2_smoke` 覆盖真实 SDK/IPC、慢状态回调隔离、文档/能力换代；`renderer_geometry_native_webview2_smoke` 从受控 Vite 同源加载实际 TerminalBuffer/TerminalRenderer，不复制算法，验证百万行、行高 12/72、原生 zoom 0.8/2 下原生 scrollbar 及首中尾 seek 的单调性、实际末行可见和 DOM 有界，CSS zoom 固定为 1。

运行三个显式原生门禁（另一个终端运行当前 checkout 的 `npm.cmd run dev -- --host 127.0.0.1`；结束后关闭该测试服务）：

```powershell
$env:HYPERCOM_GEOMETRY_URL = 'http://127.0.0.1:1420/'
cargo test --lib --manifest-path src-tauri/Cargo.toml plugin::view_runtime -- --ignored --nocapture --test-threads=1
```

正式 Playwright 回归应停止开发服务，使用 `$env:CI='1'; npm.cmd run e2e -- --workers=2` 让测试启动全新受控 Vite，避免复用经过源码 HMR 的模块图，使测试侧动态导入与 UI 持有不同的 app-lifetime 单例。

默认库测试跳过这些需要原生环境/受控 URL 的用例。原生几何通过不等于已测得任意多视图并发 RX 的前台 FPS，原生通道通过也不等于完整 Tauri 授权、文件选择器交互或全部平台隔离已被证明；不承诺任意百万行、多插件组合 60fps。
