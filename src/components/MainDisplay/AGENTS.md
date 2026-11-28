# `src/components/MainDisplay/`

主显示区按 `paneTree` 递归渲染分屏；叶子显示标签栏和内容。串口内容由 `SerialContentHost` 在树外常驻挂载，避免切换标签或跨 Pane 移动时销毁终端实例。

## 导航

| 文件 | 责任 |
|---|---|
| `MainDisplay.tsx` | paneTree、拖拽上下文、`ResizeHandle` 和 `TimelineWorkspace` 的宿主 |
| `Pane.tsx` | 叶子外壳、TabBar、关闭清理、插件视图测量和端口批量操作 |
| `SerialContentHost.tsx` | 常驻的 TRX/TTY 内容实例 |
| `TabBar.tsx` | 标签排序、跨 Pane 拖动、分屏按钮、弹出状态、远端/借用标记及回收入口 |
| `TerminalView.tsx` | `TerminalViewportManager` 的薄壳、过滤/搜索/选择/滚动交互、远端角色状态条与借用归还横幅 |
| `TerminalFilterBar.tsx` / `TerminalSearchBar.tsx` | 显示控制与一级搜索输入 |
| `SearchAdvancedOptions.tsx` | 本地/全局共用的高级选项二级浮层、条件计数与重置；不负责匹配扫描 |
| `GlobalTerminalSearchPanel.tsx` / `globalTerminalSearch.ts` | 当前 WebView 的多来源搜索面板与显式来源注册表 |
| `TtyView.tsx` | xterm 实例、fit、键盘发送和窗口调整 |
| `ReplayView.tsx` / `hooks/useLogReplay.ts` | 独立只读回放标签和原生回放授权 |
| `TimelineControls.tsx` | 时间组管理、组模式和时间偏移 |
| `ResizeHandle.tsx` / `hooks/useTabDragEnd.ts` | 分屏尺寸和标签拖拽动作 |
| `PluginViewSurface.tsx` / `PluginTabLauncher.tsx` | 插件视图承载和标签启动 |

## 必守规则

- 分屏树操作使用 `src/stores/useAppStore.ts` 的 `splitPane`、`closeTab`、`resizeChildren`、`moveTabToPane`；`focusedPaneId` 始终是叶子 ID，不要恢复扁平 `panes` 查找。
- `Pane.cleanupClosedTab` 必须先释放插件/回放/终端显示资源，再执行 store 关闭；批量关闭的集合来自 `src/stores/useAppStore.ts` 的 `getClosingTabIds(tabId, scope)`。关闭标签不关闭串口，显式断开才调用 `src/hooks/useSerialConnection.ts` 的 `useSerialConnection.closePort()`。
- `TerminalFilterBar` 通过 `src/stores/useTerminalStore.ts` 的 `useTerminalStore.getState()` 写每端口显示设置；编码变化先调用 `src/utils/rxPipeline.ts` 的 `getRxPipeline().flushAndReset(portId)`，再切换编码。`TerminalView` 不把显示设置写入 `src/stores/useOperationStore.ts`。
- `TerminalView` 只装配 renderer 外壳，行节点由 `src/utils/terminal/TerminalRenderer.ts` 直接管理。不要把行数组传进 React state，也不要通过 DOM 高度直接修复分屏尺寸。
- 滚动锁是显式意图：Pin、跳转、用户手势 settle、拖选和时间组退出才可写 `scrollLocked`。搜索定位先解除独立跟随；BROWSE、相对偏移或不兼容来源不得本地尾随；时间组 LIVE 的授权由协调器完成。
- 搜索只在打开且有查询时维护：普通本地匹配归 `viewportManager`，高级/多来源匹配归 `src/utils/terminal/search/` 的共享 Worker 会话；组件不扫描行。TerminalView 消费本地快捷键，Ctrl/Cmd+Shift+F 交给 MainDisplay 的全局入口，模态框保留键盘所有权。
- 回放使用独立 `TerminalSource` 和本地时钟，不要求活动串口，不追加实时缓冲，也没有发送端口。
- TTY 由 `TtyView` 持有 xterm 实例；非活动标签隐藏但保留会话，恢复可见时重新 fit。TTY 弹窗能力按 `tty.popoutUnsupported` 处理。
- 所有纵向 flex 容器保留 `min-height: 0`；组件定义在模块级，避免重渲染导致 DOM/输入焦点重建。

## 常用检查

```bash
npx vitest run src/components/MainDisplay
npx vitest run src/utils/terminal
npx tsc --noEmit
```

## 反模式

- 手改 `paneTree`、按全局 `tabs` 顺序重建 Pane 标签或重新筛选批量关闭集合。
- 在 `TerminalView` 中用 `onScroll` 推断并写回锁，或同步两个时间组的 `scrollTop`。
- 让 React 逐行渲染、在序列化状态中传大块终端/插件二进制，或绕过 `TerminalViewportManager`。
- 关闭标签时省略 `cleanupClosedTab`，或把终端显示设置写入 OperationPanel/`useOperationStore`。
