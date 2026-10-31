# 时间联动与只读回放

时间联动同步**采集侧时间锚点**，不是像素、滚动百分比或端口行号，也不提供硬件时钟精密同步。只支持主窗口的 TRX、主动注册时间能力的插件和独立回放标签；TTY 与弹出窗口不参与。

## 模块与身份

- `src/utils/timeline/coordinator.ts` 的 `timelineCoordinator` 是 app-lifetime 权威实例，持有组描述、成员、映射、transport、preview/committed anchor 与导航代次。不会把每帧游标写入 AppConfig 或 Zustand。
- `src/utils/timeline/scheduler.ts` 的 `TimelineScheduler` 维护每目标一条在途和一条最新候选；commit 优先。成员独立完成，不等待最慢成员。
- `src/utils/timeline/trxTimelineAdapter.ts` 的 `createTrxTimelineAdapter` 连接共享终端引擎；实时以真实 portId 选择数据源，回放注入独立 manager/sourceId，不创建假串口。
- `src/utils/terminalNavigation.ts` 的 `TerminalNavigationLifecycle` 只从显式垂直滚动意图取得驾驶权。裸 scroll 只能采样已有手势，不改变 scrollLocked；Ctrl+wheel、横向滚动、焦点与普通行点击都不驱动组。
- `src/components/MainDisplay/TimelineControls.tsx` 提供链条入口、成员管理、常量偏移和事件 T+0 对齐；工作区宿主只挂载管理弹窗，不额外显示组条或“返回实时”。终端壳只订阅稳定组资格与 Pin 所需的布尔状态；热游标不使行进入 React。

portId 是发送目标，sourceId 是数据来源，tabId 是持久工作区槽位，participantId/generation 是运行实例。组成员引用 tabId；切 Pane 不改变组身份。切换 raw/plugin 时只注册当前有效内容的适配器，不驱动隐藏 raw。instance/document、source/clock、mapping 与 navigation 版本分别校验，不互相替代。

## 时间与定位契约

映射唯一公式：`组时间 = groupTimeMs + 源时间 - sourceTimeMs`，斜率固定为 1。相同来源的 raw/plugin 共用源映射；正偏移把源事件放到更晚的组时间。原始记录不被改写，connectedAt 不是共同零点。

视口默认以中心记录驱动；目标查询不晚于目标时间的最近可见记录，重复时间用稳定 seq 排序。源视图不会因自己的广播被吸附到另一条同毫秒记录。边界夹紧和实际误差只属于成员结果，不反写组时间。结果区分 exact、nearest、before/after-range、no-time、filtered、held、loading、unsupported、unavailable、slow 与 error。

`TerminalTimeIndex` 按 `(time, seq)` 维护有序索引，不在按 seq 排列的记录上假定时间单调做二分。过滤和 frozen 上界参与有效索引；裁剪删除对应索引条目，clear/replace/source 换代使旧请求失效。未知时间保持未知，显示 `—`，不能用 0 或当前时间补造事件时间。

## 模式、驾驶权与调度

- BROWSE：独立浏览与显式时间导航。新建组从发起者当前中心进入浏览；加入已有组不取得驾驶权。
- LIVE：通过终端现有滚动锁定 Pin 显式开启整组跟随，再点 Pin 关闭并进入 BROWSE；不另设“返回实时”入口。使用确认过的宿主参考时钟，不以所有来源最后输出的最小值拖慢组。无输出成员可以显示较早实际记录与差值。回放/混合或非宿主时钟组不能开启 LIVE；运行中加入不兼容来源也会退出 LIVE。
- PLAYBACK：只允许回放来源；用户导航立即暂停。实时与回放混组只浏览，跨时间域必须由用户建立映射。

preview 可丢弃，committed 是最终逻辑目标。每次手势携带 owner、gestureId/navigationEpoch、requestSeq、mappingRevision 和 participant/source 版本。新驾驶者抢占后，旧 release/settle/ACK 不得提交。ACK 表示定位回调与本地 render pass 完成，不代表多个 WebView 已物理同帧呈现。

拖动策略为 auto、continuous、on-release。on-release 时 followers 保持原位，仅更新轻量预览，结束后应用最终目标。auto 对未观测成本或 commit-only 成员保守延期，之后依据近期定位成本和前台帧压力降级；同一手势只降档。预算常量集中于 `TIMELINE_BUDGET`，它们是调度起点，不是已保证的帧率。降级丢弃中间预览，但不能吞最终 commit。

超时只标慢并合作取消，不假装旧 Promise 已被终止；旧回调不结束时仍占一条在途，不能通过无限并发绕过背压。健康成员继续工作。窗口 pointerup/mouseup、cancel、blur、visibility 收尾与静默 settle 合并，最终实际 geometry 在 rAF 读取。平台不能识别原生滚动条意图时，不广播无归因 scroll；可用“按当前位置对齐”可靠提交。

## 本地状态与生命周期

组成员资格不复用 scrollLocked；现有 Pin 在组内控制组 transport，亮态只取 `mode === 'live'`，不取成员残留的独立 scrollLocked。来源/时钟不支持 LIVE 时 Pin 禁用并说明原因，其余组内 Pin 可用。Pin 切换先取消本地待 settle 手势，再按协调器当前状态切换并使旧导航代次失效；独立 Pin 则同步写 manager lock 后更新本地配置。退出保持当前位置并关闭独立跟随。成员滚到尾部、跳到底部或关闭搜索都不自动返回 LIVE。搜索打开进入浏览，输入不广播，命中导航才驱动。过滤/编码/HEX/暂停仅本地改变，然后按当前组目标重定位。

有效选区延迟外部定位，清除后仅应用最新目标。暂停保留 frozen 上界，RX 仍继续。隐藏成员不积压历史目标，恢复只定位最新目标。TTY、未适配插件和弹出内容保留组成员描述但标不可用。关闭标签退休成员与 lane，不断串口、不停后端日志。

## 独立多轨回放

`ReplayTabItem` 是独立 kind，`getTabPortId`/`getActivePortId` 对它返回 null。`ReplayDocument` 实现共享只读 `TerminalSource`；`TerminalView` 注入 manager 与本地显示配置，复用渲染、搜索、高亮和复制，不向实时 ring/RX/trigger/plugin 输入旁路追加历史，不统计流量或发送串口。

专用宿主命令 `pick_replay_sources`、`read_replay_source_chunk`、`release_replay_sources` 由主窗口原生选择器授予只读句柄，后续只收 grant/source 身份，不收任意路径。旧 `read_text_file` 的日志根目录限制没有放宽。分块读取要求严格顺序 offset，逐块校验元数据，并将实际交付流 SHA256 与初始指纹、EOF 重新读取文件的指纹双重比对；文件修改或消失均拒绝。恢复只保存来源描述，原生重选后路径、大小和指纹须与原描述匹配才重新授权。

首版支持 UTF-8 文本和 HEX 文本：最多 16 文件、单文件 32 MiB、会话总文件 64 MiB、500,000 记录、192 MiB 解码内存。超限拒绝并提示，不静默截断。完整导入历史不受实时 maxDisplayLines 裁剪；不承诺无限文件或分页。导入按分块执行并可取消；原始 binary/GBK 不在首版支持范围。

用户确认轨道、分片顺序、格式和记录机 UTC 偏移；不从同名文件自动合并会话，也不从 ctime/mtime/文件名推导事件时间。未知时间行保留顺序与上下文，全无可靠时间的轨道只独立查看。回拨分段需要明确选择时段后才参加联动。

播放是“完整历史 + 游标移动”，不是发送或逐行 append。`ReplayClock` 以单调时钟结算游标，换速先结算旧速度，保留真实长间隔；组范围用轨道并集，不被最短轨道截断。来源描述和组描述随会话保存，恢复默认浏览/暂停，不持久化运行句柄、preview、owner、ACK 队列或日志模型。

## 验证与操作边界

单元测试覆盖版本/背压/乱序/过滤/冻结/只读数据源和时钟；Playwright 的真实 Chromium 几何测试覆盖百万行首中尾与字体/缩放极值。`TerminalPerformance.test.ts` 需显式设置 `HYPERCOM_TERMINAL_BENCH=1`，输出索引与 jsdom CPU 样本，不把它当作物理帧率。

Windows/WebView2 原生测试在独立临时 profile/隐藏 HWND 中运行。`workerless_timeline_native_webview2_smoke` 覆盖真实 SDK/IPC、慢状态回调隔离、文档/能力换代；`renderer_geometry_native_webview2_smoke` 从受控 Vite 同源加载实际 TerminalBuffer/TerminalRenderer，不复制算法，验证百万行、行高 12/72、原生 zoom 0.8/2 下原生 scrollbar 及首中尾 seek 的单调性、实际末行可见和 DOM 有界，CSS zoom 固定为 1。

运行三个显式原生门禁（另一个终端运行当前 checkout 的 `npm.cmd run dev -- --host 127.0.0.1`；结束后关闭该测试服务）：

```powershell
$env:HYPERCOM_GEOMETRY_URL = 'http://127.0.0.1:1420/'
cargo test --lib --manifest-path src-tauri/Cargo.toml plugin::view_runtime -- --ignored --nocapture --test-threads=1
```

正式 Playwright 回归应停止开发服务，使用 `$env:CI='1'; npm.cmd run e2e -- --workers=2` 让测试启动全新受控 Vite，避免复用经过源码 HMR 的模块图，使测试侧动态导入与 UI 持有不同的 app-lifetime 单例。

默认库测试跳过这些需要原生环境/受控 URL 的用例。原生几何通过不等于已测得任意多视图并发 RX 的前台 FPS，原生通道通过也不等于完整 Tauri 授权、文件选择器交互或全部平台隔离已被证明；不承诺任意百万行、多插件组合 60fps。
