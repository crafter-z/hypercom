# 跨模块开发约定

本文只记录跨模块的当前约束；模块行为见 [`README.md`](README.md) 与各模块文档，目录局部规则见对应 `AGENTS.md`。引用只写文件与符号名，不写行号。

## 状态与 React

### Zustand selector

组件和 hook 订阅 store 时必须使用 selector；回调/effect 需要最新值时使用 `useXxxStore.getState()`。禁止订阅整 store 或整包 `config`，否则串口事件和流量刷新会造成无关重渲染。

当前 store 模块是 `useAppStore`、`useOperationStore`、`useTerminalStore`、`useRuleStore`、`useSystemStore` 和 `useToastStore`。终端行不在 store，由 `src/utils/terminal/viewportManager.ts` 的 `viewportManager` 和 `src/utils/terminal/TerminalBuffer.ts` 管理；`useTerminalStore` 只保存显示态。字段归属见 [`config.md`](config.md)，写入规则见 `src/stores/AGENTS.md`。

`useAppStore` 不持有 `systemStatus`、`trafficStats`、`simulationMode` 或 `ui`；这些字段归 `useSystemStore`。树遍历由 `src/utils/paneTree.ts` 提供，store 不重复实现。

### React 组件与布局

组件定义在模块级，不在父组件 render 函数内创建组件。终端和 TTY 的纵向 flex 链每层保留 `min-height: 0`，滚动容器才会获得受限高度；具体选择器见 `src/components/MainDisplay/AGENTS.md`。

## 数据与生命周期

### RX/TX hook

`src/hooks/useSerialReceive.ts` 的 `useSerialReceive` 在 `src/App.tsx` 只装配一次：`serial:data` 原始字节进入 `src/utils/rxPipeline.ts` 的 `getRxPipeline`，TTY 端口进入 `src/utils/ttyService.ts` 的 `ttyService`。管线是 webview 生命周期单例，断开使用 `disconnect`，不能在组件卸载时 `dispose`。

`src/hooks/useSerialSend.ts` 的 `sendToPort` 是 TRX TX 的统一入口，负责连接代次、TX 回显、统计和历史。TTY 键盘、TTY 显式命令及文件发送是旁路，必须分别维护代次、流程独占和统计边界；详见 [`transmission.md`](transmission.md) 与 [`tty.md`](tty.md)。

### 工作区身份

`src/types/index.ts` 的 `TabItem.id` 是工作区 UUID，不是端口 ID。串口标签使用 `portId`，插件标签使用 `boundPortId`，回放标签没有发送端口。端口解析只用 `src/stores/useAppStore.ts` 的 `getTabPortId` / `getActivePortId`，未绑定插件和回放不回退到 last-port。

关闭标签不等于断开串口：`src/components/MainDisplay/Pane.tsx` 的 `cleanupClosedTab` 退休对应显示/输入消费者；显式断开走 `src/hooks/useSerialConnection.ts` 的 `useSerialConnection.closePort`。批量关闭范围由 `getClosingTabIds` 与 store 共用。

## Rust 命令与锁

所有 `#[tauri::command]` 返回 `Result<T, CommandError>`，不得使用 `Result<T, String>`。`CommandError` 定义于 `src-tauri/src/commands/mod.rs`，命令必须在 `src-tauri/src/lib.rs` 的 `generate_handler!` 注册；注册漂移由 `src-tauri/src/config/mod.rs` 的 `test_generate_handler_matches_tauri_command_attribute` 守卫。命令实现按 `src-tauri/src/commands/` 域文件组织，完整归属见 `src-tauri/src/commands/AGENTS.md`。

`std::sync::MutexGuard` 不得跨 `.await`：先提取并 clone 所需值，释放锁后再 await。`AppState.log_manager` 是 `Arc<LogManager>`，内部已有细粒度锁，不要再包外层 mutex。日志设置只经 `AppState::apply_runtime_config` 应用。

配置目录由 `src-tauri/src/lib.rs` 的 `acquire_instance_lock` 使用 `config.lock` 做单实例互斥；不要用前端标记或进程内锁替代。

## 单一实现与输入安全

- 数值边界：前端 `src/utils/bounds.ts` 的 `CONFIG_BOUNDS` 与 Rust `src-tauri/src/config/mod.rs` 的 `CONFIG_BOUNDS` 必须一致，`src/utils/bounds.test.ts` 负责跨语言守卫。
- 文本解码：`src/utils/lineText.ts` 的 `createDecoder` / `decodeBytes` / `getLineText` 是唯一入口，使用 `ignoreBOM: false`；普通 RX 行保存 `rawData`，渲染时按编码惰性解码。
- HEX：输入校验和解析使用 `src/utils/hexUtils.ts` 的 `isValidHexInput` / `parseHexBytes`；字节格式化使用 `src/utils/hexFormat.ts` 的 `hexByte` / `bytesToSpacedHex`。奇数位或非法字符是错误态，不补零。
- 互斥选择：`src/components/shared/SegmentedControl.tsx`；弹窗键盘、Tab 循环和焦点恢复：`src/components/shared/useDialogLifecycle.ts`；顺序调度：`src/utils/sequential.ts` 与 `src/utils/flowSchedule.ts`。
- HTML 颜色：用户颜色先经 `src/utils/cssColor.ts` 的 `safeCssColor`，再进入 `innerHTML` 的 style；禁止组件各自实现颜色正则。
- 用户正则：高亮、触发器和实体校验共用 `src/utils/safeRegex.ts` 的 `isSafeRegexPattern` / `tryCreateSafeRegex`；入口和执行路径都要复核。
- 事件形状：`serial:data` 的 `data` 是 Rust `Vec<u8>` 序列化的字节数组，前端行保存为 `Uint8Array`；映射字节使用 `Array.from`。`serial:file_progress` 的 `FileProgressPayload` 通过 serde `rename_all = "camelCase"` 发送 `portId`、`transferId`、`sentBytes`、`totalBytes`、`done`。

## 配置、编辑和国际化

配置写入由 `src/utils/configWriteQueue.ts` 的 `enqueueConfigWrite` 串行执行 revision CAS；会话草稿由 `src/utils/entityEditor.ts` 和 `useEntityPage({ kind })` 管理，保存成功才推进 `useRuleStore` 运行态。失败、冲突或迟到响应不得覆盖新草稿。编辑器关闭经 `src/utils/editorLeave.ts`、`src/components/shared/EditorLeaveDialog.tsx` 和 `complete_editor_close` 审批。

`src/i18n.ts` 的 zh-CN 与 en-US 各有 **856 个键**；两侧集合、顺序和插值占位符必须一致，`src/i18n.test.ts` 守卫这些条件。协议词、编码名和单位按代码中的原文使用，不另造翻译键。

`src/styles/` 当前有 **28 个 CSS 文件**。其中 19 个由 `src/styles.css` 全局入口按顺序导入，其余由组件按需导入；`base.css` 必须最先加载。新增样式沿用现有入口，不把组件样式堆进 `base.css`。

保存普通配置使用 `src/hooks/useConfigPersistence.ts` 的 `saveConfig`；实体页不直接修改已提交规则数组。`src-tauri/src/config/mod.rs` 的 `AppConfig` 有 44 个字段，其中 `entities` 是 `#[serde(flatten)]` 的 `Entities`（9 个实体数组）；字段变化时以源码与测试为准。

## 平台能力

平台电源抑制集中于 `src-tauri/src/system.rs` 的 `win32_backend` / `child_process_backend`，状态由 `DESIRED_STATE` 统一应用；调用入口是 `src-tauri/src/commands/system_cmds.rs` 的 `prevent_sleep` / `prevent_screen_off`。

主窗口与弹出窗使用自绘标题栏：`src-tauri/tauri.conf.json` 关闭 decorations，React 侧由 `src/components/TitleBar/TitleBar.tsx` 控制窗口操作；弹出窗沿用 `src-tauri/src/commands/popout.rs` 的同一约束。

## 提交与验证

提交格式为 `type(scope): description`；`type` 使用 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`，scope 使用实际受影响域。

按改动范围运行 `npm run build`、`npm run test:run`、`npx tsc --noEmit`、`cargo test --manifest-path src-tauri/Cargo.toml --lib`、Clippy 和 release-profile 检查。Playwright 使用 mock IPC；它不证明真实 UART、原生 WebView/CSP 或最终安装包行为。质量门与平台验收边界见 [`release.md`](release.md)。

## 相关文档

- 架构总索引：[`README.md`](README.md)
- 配置与状态：[`config.md`](config.md)
- 终端与收发：[`terminal.md`](terminal.md)、[`transmission.md`](transmission.md)、[`tty.md`](tty.md)
- 工作区与插件：[`workspace.md`](workspace.md)、[`plugins.md`](plugins.md)、[`plugin-views.md`](plugin-views.md)
- 错误与复用索引：[`errors.md`](errors.md)、[`code-map.md`](code-map.md)

(End of file)
