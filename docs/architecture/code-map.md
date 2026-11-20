# 符号与模块索引

本文是跨模块复用入口。新增实现前先查这里；同一行为只保留一个生产实现。引用只写文件与符号名，不写行号。

## 前端复用模块

| 能力 | 文件与符号 | 约束 |
|---|---|---|
| 端口/标签解析 | `src/stores/useAppStore.ts`：`getTabPortId`、`getActivePortId`、`findSerialTabByPortId` | `TabItem.id` 是工作区 UUID；serial 用 `portId`，plugin 用 `boundPortId`，replay 无端口；不回退 last-port |
| pane tree | `src/utils/paneTree.ts`：`newPaneId`、`findLeafById`、`findLeafByTabId`、`findParentBranch`、`findBranchById`、`collectLeaves`、`countLeaves`、`pruneTree` | 纯函数；store、拖拽和恢复共用 |
| 配置写入 | `src/utils/configWriteQueue.ts`：`enqueueConfigWrite`；`src/hooks/useConfigPersistence.ts`：`saveConfig` | 串行写入、revision CAS；成功后才推进基线 |
| 联动更新检查 | `src/utils/pluginUpdateService.ts`：`runPluginAutoCheck`、`runPluginManualCheck`、`shouldCheckPluginUpdates`、`pluginUpdateTiming`；`src/utils/updateService.ts`：`runAutoCheck`、`manualCheck`、`shouldAutoCheck`、`updateTiming`；`src/hooks/useAutoUpdate.ts`：`useAutoUpdate`；`src/hooks/useConfigPersistence.ts`：`loadConfig`、`saveConfig` | 插件更新只通知不安装；插件记账独立；后台检查以已提交市场源为准 |
| 实体会话草稿 | `src/utils/entityEditor.ts`；`src/components/ConfigModal/hooks/useEntityPage.ts`：`useEntityPage` | 页面编辑不直接修改已提交运行态 |
| 数值边界 | `src/utils/bounds.ts`：`CONFIG_BOUNDS`；Rust `src-tauri/src/config/mod.rs`：`CONFIG_BOUNDS` | `src/utils/bounds.test.ts` 校验两侧键与范围一致 |
| 文本解码 | `src/utils/lineText.ts`：`createDecoder`、`decodeBytes`、`getLineText` | 唯一 TextDecoder 工厂；`ignoreBOM: false` |
| HEX 输入 | `src/utils/hexUtils.ts`：`isValidHexInput`、`parseHexBytes`、`hexToString`、`stringToHex` | 奇数位/非法字符拒绝；发送、复制、实体校验共用 |
| 字节转 HEX | `src/utils/hexFormat.ts`：`hexByte`、`bytesToSpacedHex` | 唯一格式化实现 |
| 发送与守卫 | `src/hooks/useSerialSend.ts`：`sendToPort`；`src/utils/sendGuard.ts` | TRX 快捷、循环、触发和插件发送共用连接/代次守卫 |
| RX 管线 | `src/utils/rxAssembler.ts`：`RxLineAssembler`；`src/utils/rxPipeline.ts`：`RxPipeline`、`getRxPipeline` | 原始字节组行、rAF 批写、断线/编码切换 flush；主应用只装配一次 |
| TTY I/O | `src/utils/ttyService.ts`：`ttyService` | per-port 解码、队列、键盘 `send`、显式 `sendData`、`disconnect` |
| 终端缓冲/渲染 | `src/utils/terminal/TerminalBuffer.ts`：`TerminalBuffer`；`TerminalRenderer.ts`：`TerminalRenderer`；`viewportManager.ts`：`getViewportManager` | 行缓冲脱离 React；显示、搜索、回放复用同一引擎 |
| 终端搜索/过滤 | `src/utils/terminalSearch.ts`；`src/utils/lineFilter.ts`；`src/utils/terminal/search/`：`TerminalSearchSession`；`src/components/MainDisplay/globalTerminalSearch.ts`：`registerGlobalTerminalSearch` | 普通搜索留 manager 快路径；高级匹配只在 Worker，会话增量/取消；组件不扫描或重复解码 |
| 搜索高级条件入口 | `src/components/MainDisplay/SearchAdvancedOptions.tsx`：`SearchAdvancedOptions`、`countAdvancedSearchOptions` | 本地/全局共用二级浮层，不重复控件、不负责匹配；浮层定位和焦点复用 shared hooks |
| 顺序/流程调度 | `src/utils/sequential.ts`：`runSequential`；`src/utils/flowRuntime.ts`；`src/utils/flowSchedule.ts`：`advanceFlow` | 循环发送和命令步骤共用 |
| 命令执行 | `src/utils/commandExecution.ts`：`executeQuickCommand`、`applyCommandParams`；`src/utils/commandOrder.ts`：`orderedCommands` | 单步与循环都从同一命令快照执行 |
| 规则安全 | `src/utils/cssColor.ts`：`safeCssColor`；`src/utils/safeRegex.ts`：`isSafeRegexPattern`、`tryCreateSafeRegex` | 用户颜色/正则在保存和执行入口均复核 |
| UI 缩放 | `src/utils/uiScale.ts`：`normalizeUiScalePercent`、`applyUiScale` | 每个 WebView 独立调用 `setZoom` |
| 时间联动 | `src/utils/timeline/coordinator.ts`：`timelineCoordinator`；`scheduler.ts`：`TimelineScheduler`；`trxTimelineAdapter.ts`：`createTrxTimelineAdapter` | preview/commit、代次和背压的唯一来源 |
| 只读回放 | `src/utils/replay/ReplayDocument.ts`、`src/utils/replay/replayRuntime.ts` | 回放只读，不写实时 RX、TX 或触发旁路 |
| 插件宿主 | `src/hooks/usePlugins.ts`：`usePluginHost`；`src/utils/pluginHost.ts`；`pluginObserver.ts`；`pluginBytesObserver.ts` | 每次 RPC 复核安装身份、启用态和权限 |
| 插件文件 raw 服务 | [`services/pluginFs.ts`](../../src/services/pluginFs.ts)：`pluginFsService`、`decodePluginFsFrame`；[`pluginHostApi.ts`](../../src/utils/pluginHostApi.ts)：`executeHostApi` | 范围/批量严格 raw ArrayBuffer + HCFR frame，控制元数据允许 JSON；单 range 4 MiB、批量 64 项/8 MiB；分页默认 256/最多 1000，不改变旧全文件 API |
| 插件文件会话与交付 | [`utils/pluginFs.ts`](../../src/utils/pluginFs.ts)：`PluginFsContext`、`attachPluginFsLease`、`releasePluginFsResultWithRetry`、`pluginFsTransferables`；[`pluginHost.ts`](../../src/utils/pluginHost.ts)：`PluginSession`；[`pluginBridge.ts`](../../src/utils/pluginBridge.ts) | 根 Worker epoch 绑定、native 懒 open、signal 显式取消；新 FS 独立 8 槽，取消绕普通槽但有界；postMessage transfer 成功/失败/放弃后释放 native 字节 lease，不等 Worker ACK、不声称全链零拷贝 |
| 插件串口控制 | `src/utils/serialPlugin.ts`：`executePluginSerialOpen`、`executePluginSerialClose`；`src/utils/serialConnectionRuntime.ts`：`openSerialConnection`、`closeSerialConnection`；`src/services/serial.ts`：`pluginSerialOpen`、`pluginSerialClose`、`pluginSerialList`、`pluginSerialStatus` | `serial:control` 独立授权；与用户/重连共用 per-port lane；白名单、安装身份及 connectionGeneration CAS；查询走原生权威摘要，控制无隐式 RPC 期限 |
| 插件最小文件保存 | `src/utils/pluginHostApi.ts`：`executeHostApi`；`src/services/file.ts`：`exportPluginFile`、`savePluginFile` | `fs.exportFile` 需 `fs:export-dir` + 用户所选目录 grant + 相对路径；`fs.saveFile` 需 `fs:save` 且每次原生 Save As；均不隐式授予读取/删除/重命名，不替换旧 `fs:write-dir` 或 `ui.panel.export` |
| 插件命令执行 | `src/utils/pluginShell.ts`：`executePluginShell`；`src-tauri/src/commands/plugin_shell.rs`：`plugin_shell_execute` | `shell:execute` 一次性授权；按 OS 进程语义传递 program/args/cwd/env/stdin，状态变更终止直接子进程 |
| 插件配置快照 | `src/utils/pluginConfigSnapshot.ts`：`syncPluginListSnapshot`、`syncStorePluginConfigs` | 后端 revision 单调；旧快照不可恢复权限 |
| 插件视图二进制 | `src/utils/pluginViewBinary.ts`；`src/utils/pluginViewJson.ts` | 分块、ACK、document/epoch 绑定；不塞实时状态 JSON |
| 插件视图输入 | `src/utils/pluginViewInput.ts`：`pluginViewInput` | 端口输入租约按 bytes/lines/none 管理 |
| 原生视图遮挡 | `src/components/shared/usePluginViewOverlay.ts`；`src/utils/pluginViewOverlay.ts` | 等待原生裁剪/隐藏完成后显示宿主浮层 |
| 编辑关闭审批 | `src/utils/editorLeave.ts`；`src/shared/EditorLeaveDialog.tsx` | 保存/放弃/继续；失败和迟到编辑不得放行关闭 |
| 事件服务 | `src/services/event.ts`；`src/services/eventContract.test.ts` | 事件载荷与 Rust wire 形状在测试中对齐 |

## 状态模块

| store | 文件 | 责任 |
|---|---|---|
| `useAppStore` | `src/stores/useAppStore.ts` | ports、tabs、paneTree、config、groups、端口元数据 |
| `useOperationStore` | `src/stores/useOperationStore.ts` | serial 参数、发送输入、快捷/循环操作态 |
| `useTerminalStore` | `src/stores/useTerminalStore.ts` | 显示配置和连接显示态，不存行数组 |
| `useRuleStore` | `src/stores/useRuleStore.ts` | 已提交的 highlight/protocol/command/tool/trigger 运行态 |
| `useSystemStore` | `src/stores/useSystemStore.ts` | systemStatus、trafficStats、simulationMode、ui |
| `useToastStore` | `src/stores/useToastStore.ts` | 宿主通知与 `pushPlugin` 插件通知 |
| 释放守卫 | `src/stores/releaseTerminalState.ts` | `releaseUnusedPortState`：最后显示/行消费者退休后回收端口显示态、统计和 TX 历史 |

## Rust 后端符号

| 能力 | 文件与符号 | 约束 |
|---|---|---|
| 命令错误 | `src-tauri/src/commands/mod.rs`：`CommandError` | 所有 Tauri 命令返回 `Result<T, CommandError>` |
| 命令注册 | `src-tauri/src/lib.rs`：`generate_handler!` | 新命令必须注册；`test_generate_handler_matches_tauri_command_attribute` 守卫注册集合 |
| 配置模型 | `src-tauri/src/config/mod.rs`：`AppConfig`、`Entities`、`ConfigManager` | `AppConfig` 44 个字段；`entities` 是 flatten，含 9 个实体数组；`CONFIG_BOUNDS` 是 Rust 边界来源 |
| 运行期配置 | `src-tauri/src/lib.rs`：`AppState::apply_runtime_config` | 启动和 `set_config` 共用日志/诊断设置应用入口 |
| 串口类别 | `src-tauri/src/serial/mod.rs`：`PortKind::of`、`check_virtual_enabled` | Real/Sim/Tty 分派及虚拟端口门控唯一入口 |
| 真实串口句柄 | `src-tauri/src/serial/ports_real.rs`：`SerialPortHandle`、`open_real_port` | 读写 clone 分离；写入按连接代次和写租约守卫 |
| TX 编码/期限 | `src-tauri/src/serial/codec.rs`：`parse_hex_string`、`build_tx_bytes`、`write_all_with_deadline` | 入参到实际上线字节的唯一后端实现 |
| 本机 CLI 契约 | [`automation/wire.rs`](../../src-tauri/src/automation/wire.rs)：`Request`、`Response`、`FrameReader`；[`cli.rs`](../../src-tauri/src/cli.rs)：`Client` | CLI 与 loopback Host 共用 Rust envelope 和有界帧，写入同连接使用短租约；现有 TS 适配层未接线 |
| 设备准入 | [`lib.rs`](../../src-tauri/src/lib.rs)：`AppState::admit_native_port` / `admit_native_ports`；[`automation/runtime.rs`](../../src-tauri/src/automation/runtime.rs)：`DeviceAuthority`、`LocalAutomationHandler` | 桌面设备操作与本机 CLI 租约共用端口级仲裁；持许可的一方收尾前不交接。桌面组内仍沿用已有顺序规则，实验入口默认关闭且不得对外开放 |
| TTY 模拟 | `src-tauri/src/serial/tty_sim.rs`：`TtySimPortHandle`、`find_bash`、`spawn_bash` | GIT:BASH 调试能力；PTY 子进程生命周期由后端管理 |
| 日志设置 | `src-tauri/src/logger/settings.rs`：`LogSettings::from_config`；`logger/manager.rs`：`LogManager::apply_settings` | `AppState.log_manager` 是 `Arc<LogManager>`，不包外层 mutex |
| 日志迁移 | `src-tauri/src/logger/manager.rs`：`LogManager::migrate_directory`；`logger/migration.rs`：`PreparedLogMigration` | 活动 writer 刷盘、交接和路径登记由同一入口完成 |
| 诊断日志 | `src-tauri/src/diaglog.rs`：`DiagLogger` | 前后端诊断日志统一落盘、轮转和清空 |
| 系统能力 | `src-tauri/src/system.rs`：`win32_backend`、`child_process_backend`；`commands/system_cmds.rs`：`dev_only`、`is_debug_build` | 平台电源抑制与调试能力门控的集中入口 |
| 插件事务 | `src-tauri/src/plugin/transaction.rs` | 安装/升级/卸载 journal、原子替换与中断恢复 |
| 插件文件 IO 调度 | [`io_scheduler.rs`](../../src-tauri/src/plugin/io_scheduler.rs)：`IoOwner`、`IoPriority`、`IoLimits`、`IoScheduler::acquire_with_cost`、`IoPermit::finish_io` | 跨 session 聚合插件预算，memory reservation 与后台 IO cost 分账；owner 公平轮转/优先级/aging、有界队列与显式取消；闲置 token 债务保留至补满且无活动/排队/字节 lease 才回收，不能重开 session 重置插件账；实际 IO 结束才释放并发，字节保留至宿主交付后的 release（不等 Worker ACK）；soft IO budgets 不是文件总大小或 JS/OS 总内存限额 |
| 插件窗口与目录游标 | [`plugin_fs.rs`](../../src-tauri/src/commands/plugin_fs.rs)：`PluginFsRegistry`、`blocking_open`、`plugin_fs_read_ranges`、`plugin_fs_list_directory_page`；[`fs_access.rs`](../../src-tauri/src/plugin/fs_access.rs)：`sanitize_directory_rel`、`open_regular_file`、`open_directory_range_file`、`read_open_range`、`DirectoryCursor`、`DirectoryStream` | 主窗、安装身份/权限/session/grant 复核；逐组件句柄安全打开、有界 seek/read、跨页保留目录句柄；page 1 MiB 元数据估算/128 层栈，cursor 非快照、不排序且会过期；新 raw 命令拒绝 postMessage fallback |
| 兼容目录 raw 读取 | [`file.rs`](../../src-tauri/src/commands/file.rs)：`plugin_read_directory_file_raw`；[`fs_access.rs`](../../src-tauri/src/plugin/fs_access.rs)：`open_legacy_directory_file`；[`file.ts`](../../src/services/file.ts)：`fileService.readPluginDirectoryBytes`；[`pluginBinary.ts`](../../src/services/pluginBinary.ts)：`decodeLegacyDirectoryFrame`、`isPluginRawUnsupported` | HCFD 展示 path 与 raw 字节分离，旧 text/binary 返回形状及最终普通硬链接可读语义保留；unsupported 才回退 base64，内容无新增大小上限；新范围仍拒硬链接，不改变 fs.openDialog 或 view.sendBinary |
| 兼容资产 IO | [`plugin.rs`](../../src-tauri/src/commands/plugin.rs)：`read_asset_payload`、`read_plugin_asset_raw`、`legacy_file_authority`、`PreparedAssetWrite`、`asset_write_queue`；[`plugin.ts`](../../src/services/plugin.ts)：`pluginService.readPluginAssetBytes` | 旧全文件无业务大小上限，binary 仅 raw unsupported 回退；短 gate 仅取读取准入快照，打开/读取/编码在锁外且 permit 随实际阻塞任务持有；temp 锁外写/fsync 后短 gate 复核提交，同插件写串行；生命周期事务仍串行 |
| 插件市场协议 | `src-tauri/src/plugin/marketplace.rs`：`parse_index`、`parse_description`、`metadata_matches`；`src-tauri/src/commands/plugin_marketplace.rs`：`fetch_plugin_marketplace`、`check_plugin_updates`、`install_marketplace_plugin` | 索引只保存 metadata URL；描述携带 manifest/downloadUrl；远程安装复用插件事务并绑定期望 id/version/generation |
| 原生插件视图 | `src-tauri/src/plugin/view_runtime/`：`mod.rs`、`resources.rs`、`windows.rs`、`sdk.js` | 身份、资源、Windows Wry child 和视图 SDK 分层 |
| 更新网络 | `src-tauri/src/update_network.rs`、`src-tauri/src/commands/update.rs` | 代理策略与更新检查/下载/安装命令分离 |

## 相关局部指南

- `src/hooks/AGENTS.md`：hook 清单和生命周期
- `src/stores/AGENTS.md`：store 写入纪律
- `src/utils/terminal/AGENTS.md`：终端引擎约定
- `src-tauri/src/commands/AGENTS.md`：命令域与错误/锁规则
- `src/components/MainDisplay/AGENTS.md`：显示区与布局约束
- `src/components/ConfigModal/AGENTS.md`：配置编辑器约束
- `src/components/OperationPanel/AGENTS.md`：发送区约束

(End of file)
