# `src/hooks/`

本目录的 hook 负责 React 与 Tauri 的生命周期连接。模块导出统一从 `index.ts` 引用；需要跨 hook 共享的断线标记在 `disconnectTracking.ts`。

## 导航

| 文件 | 责任与装配位置 |
|---|---|
| `useAppInit.ts` | `App.tsx` 启动装配：加载配置与会话、恢复分组和端口元数据、初始化规则运行态 |
| `useSerialPorts.ts` | 端口轮询和 `mergePorts`（远端端口采用后端状态/波特率/代次/借用信息并保留借用中端口）；`useSimulation.ts` 复用端口映射与合并逻辑 |
| `useSerialConnection.ts` | React 适配与重连监听租约；严格状态机与插件 `serial.open/close` 共用的 per-port lane 在 `src/utils/serialConnectionRuntime.ts`；`closePort()` 是显式断开 UI 入口 |
| `useSerialReceive.ts` | `App.tsx` 唯一的主窗 `serial:data` / `serial:status` / `serial:tool-loan` / `serial:note` / `serial:external-tx` 监听；把 TRX 字节送入 `getRxPipeline()`，TTY 字节送入 `ttyService.feed`；`remote::` 端口跳过本地触发自动回复 |
| `useSerialSend.ts` | `sendToPort()`、TRX 回显、TX 统计、发送历史；TTY 走对应服务路径 |
| `useConfigPersistence.ts` | 普通配置和实体保存的 revision-CAS 队列 |
| `usePopoutBridge.ts` | 主窗与弹窗的 intent、快照、命令编辑 ACK |
| `useSystemStatus.ts` / `useToolOutput.ts` | 系统轮询、工具输出事件 |
| `useAutoUpdate.ts` / `usePowerManagement.ts` | 更新检查、系统防休眠/防关屏 |
| `usePlugins.ts` / `usePluginPanel.ts` / `usePluginUi.ts` | 插件宿主、声明式 UI 和面板订阅 |
| `usePortToolActions.ts` | 侧边栏和标签菜单共用的外部工具动作 |
| `useHotkeys.ts` | 全局快捷键；表单焦点时忽略非 Escape 快捷键 |
| `useSimulation.ts` / `useGitBashSim.ts` | 开发构建中的虚拟端口和 GIT:BASH 模拟终端 |

## 必守规则

- `src/hooks/useSerialReceive.ts` 的 `useSerialReceive` 在主应用只装配一次；正常接收路径不得另加 `serial:data` 监听。终端弹窗是独立 webview，可由 `src/components/Popout/usePortSerialFeed.ts` 监听自己的事件，但仍必须只调用本地 `src/utils/rxPipeline.ts` 的 `getRxPipeline`。
- RX 字节必须经过 app-lifetime 的 `src/utils/rxPipeline.ts` 的 `RxPipeline` 组行和 rAF 批写；不要在事件回调中逐事件 `appendTerminalLine`。管线 cleanup 不调用 `dispose()`，端口断开由 status handler 调 `disconnect(portId)`。
- 发送前调用 `getRxPipeline().flushBeforeSend(portId)`，确保 RX 先于 TX 回显；`src/hooks/useSerialSend.ts` 的 `sendToPort` 是 TRX 发送统一入口。绕过它的文件发送和 TTY 键盘输入，必须补齐流程独占、连接代次和统计规则。
- `src/hooks/useSerialConnection.ts` 的 `useSerialConnection.closePort()` 是显式断开的 UI 入口，内部交给 `src/utils/serialConnectionRuntime.ts` 的 strict runtime；不要绕过 runtime 直接 invoke。插件控制与用户按钮/自动重连共用该 per-port lane。标签关闭只清理前端显示消费者，不代替显式断开。
- `lostPortIds` 只由 `src/hooks/useSerialReceive.ts` 的状态处理器添加；连接、打开、关闭和成功重连可以清除标记。端口轮询使用 `src/hooks/useSerialPorts.ts` 的 `mergePorts`，其状态保留和缺失端口处理以实现和测试为准。
- 配置和实体写入走 `src/hooks/useConfigPersistence.ts` / `src/utils/configWriteQueue.ts` 与 revision CAS；迟到结果不得回退更高 revision 或覆盖新编辑。
- 弹窗是独立 webview，不共享 store；发送 intent 必须回主窗 `src/hooks/useSerialSend.ts` 的 `sendToPort`，命令编辑使用带 requestId 的 ACK。hook 回调需要实时 store 值时使用 `getState()`。
- 轮询 hook 的间隔由调用方参数传入，不在 hook 内隐藏硬编码。

## 常用检查

```bash
npx vitest run src/hooks
npx tsc --noEmit
```

## 反模式

- 重复装配 `useSerialReceive` 或在主窗增加临时 `serial:data` 监听。
- 绕过 `RxPipeline`、绕过 `closePort()` 或直接调用后端发送命令。
- hook 内订阅整 store，或在循环运行期间读取会随输入变化的 selector 值。
- 把弹窗自己的 store 当作主窗状态，或允许旧快照/旧 requestId 覆盖当前会话。
