# `src/components/OperationPanel/`

操作区由 `OperationPanel` 顶部工具条、`SendSection` 发送区和 `ParamsSection` 参数区组成。面板高度写入 `useSystemStore.ui.operationPanelHeight`，由 `OperationPanelResizeHandle` 调整。

## 导航

| 路径 | 责任 |
|---|---|
| `OperationPanel.tsx` | 连接、清屏、回放、日志、字号和流程状态入口；流程状态徽标在模块级 `FlowRunningBadge` |
| `SendSection.tsx` | 命令集选择、循环开关、快捷发送、文本/HEX 输入、文件发送和发送选项 |
| `components/QuickSendStrip.tsx` | 命令快捷条、溢出项和弹窗入口 |
| `components/LineEndingSelect.tsx` | 复用 `sendUtils` 的行尾值和标签 |
| `components/SendFileControls.tsx` / `hooks/useFileSend.ts` | 文件发送、取消、进度、TX 增量统计和成功提示 |
| `ParamsSection.tsx` | 串口参数、预设和 TRX/TTY 模式切换 |
| `hooks/useSequentialSend.ts` | `createSendLoop` 与 React 绑定；主窗循环和弹窗文本循环共用 |
| `hooks/useCyclicSend.ts` | 按命令集运行发送/参数步骤和流程状态 |
| `hooks/useHexCompose.ts` / `hooks/useQuickStripLayout.ts` / `hooks/useSendHistoryRecall.ts` | HEX 输入、快捷条布局和发送历史回填 |

## 必守规则

- 串口参数字段使用 `useOperationStore` 的无前缀名称；显示格式、编码、滚动锁和时间戳属于 `useTerminalStore`，普通 Enter 设置属于 `useAppStore.config`。
- TRX 的快捷发送、循环、触发、插件和弹窗发送统一走 `sendToPort`；入口保持端口可发送、连接代次、RX-before-TX、回显、TX 统计和历史契约。TTY 显式命令走 `ttyService.sendData`，键盘走 `ttyService.send`，不做本地 TX 回显但仍保持有序写入、代次、流程独占和统计边界。
- 发送前必须 `getRxPipeline().flushBeforeSend(portId)`，不能让排队 RX 越过 TX 回显。文件发送和 TTY 键盘绕过 `sendToPort` 时必须自行执行同一流程独占守卫。
- 远端端口（`remote::`）与已借出端口的功能门控统一由 `src/utils/portCapabilities.ts` 与端口字段推导：`observe` 禁用发送与本地控制，`write` 允许发送但禁用打开/关闭/改参/DTR/RTS，远端端口禁用本地文件发送，已借出端口暂停写入与控制。
- `useCyclicSend` 在启动时固定目标端口、已提交命令集、排序结果和重复策略；焦点、草稿或中途保存不改当前运行。步骤等待由 `delay` 表达，轮末使用 `loopDelay`，重复次数来自命令集；不要新建全局间隔字段或独立定时器链。
- 增强流程（含非 `send` 步骤）运行时通过 `src/utils/flowRuntime.ts` 独占端口；流程执行发送使用 `origin: 'flow'`，用户发送、文件和 TTY 输入必须拒绝被占用端口。停止时保留独占直到在飞操作结束。
- HEX 输入和转换只使用 `src/utils/hexUtils.ts`、`src/utils/hexFormat.ts` 与 `src/utils/sendUtils.ts` 适配；忽略空白后必须偶数位且全为十六进制字符，非法输入显示错误并禁止发送，不补零。HEX 模式不追加文本行尾，切回文本时保留非法原文。
- `ParamsSection` 模式切换必须按固定端口执行，先按旧模式冲刷 `src/utils/rxPipeline.ts` 的 `getRxPipeline().flushAndReset`，再切模式并清理对应显示/TTY 状态；预设读写走 `src/services/storage.ts` 的 `storageService`。
- 文件按钮在 `isSendablePort` 失败或流程占用时不得打开选择器；进度按增量计入 TX，只有收到完成且发送量有效时提示成功。
- `QuickSendStrip` 的可见行与测量行共用同一 pill；所有区段组件在模块级定义。面板子项必须保持自然高度，短面板通过区段滚动，不用固定 CSS 高度覆盖状态。

## 常用检查

```bash
npx vitest run src/components/OperationPanel
npx vitest run src/components/OperationPanel/hooks/useSequentialSend.test.ts
npx tsc --noEmit
```

## 反模式

- 在 `OperationPanel` 函数体内声明区段组件，或无 selector 订阅整个规则 store。
- 在发送区直接调用 Tauri `invoke` 或后端发送命令，或新增独立循环调度。
- 用焦点变化重新定位已运行循环，或从草稿读取运行中命令。
- 把显示字段放回 `useOperationStore`，或在 HEX 下宽松解析/补零。
- 文件发送绕过发送前守卫、取消/进度边界或 TX 增量统计。
