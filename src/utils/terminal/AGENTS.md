# `src/utils/terminal/`

终端显示引擎直接管理行缓冲和 DOM 渲染；React 只负责外壳和交互状态，不逐行渲染。

## 导航

| 文件 | 责任 |
|---|---|
| `TerminalBuffer.ts` | 稳定 `seq` 的环形行缓冲；`append`、`snapshot`、`replaceAll`、`clear`、`setLimits` |
| `TerminalRenderer.ts` | 节点池、固定行高/软换行、过滤结果、选区和同帧跟随的 DOM 渲染 |
| `TerminalWrapLayout.ts` / `TerminalHeightIndex.ts` | 文本软换行的可见区域测量和有界高度索引 |
| `viewportManager.ts` | 端口显示实例、缓冲、增量过滤/搜索、时间索引和 renderer 生命周期 |
| `TerminalSource.ts` | 只读回放来源、稳定序号、时间和物理高度映射 |
| `TerminalTimeIndex.ts` | 按 `(time, seq)` 排序的 AVL 索引 |
| `src/utils/lineText.ts` | 全仓唯一的字节到文本解码器工厂和缓存 |

依赖方向是 `viewportManager` → `TerminalBuffer`、`TerminalRenderer`、`lineFilter`、`lineText`、`terminalSearch`；stores 不得反向 import 本目录。

## 数据流

```text
serial:data → RxPipeline（组行、排队、rAF）
  → appendTerminalLines(portId, lines)
  → TerminalViewportManager.appendLines()
  → buffer / filter / search
  → requestRender → TerminalRenderer.render()
```

TX 回显和工具输出使用 `appendTerminalLine`。日志回放使用独立 `TerminalSource`，不进入实时 RX、发送或触发管线。弹窗通过 `snapshotTerminalLines` / `replaceTerminalLines` 交换快照。

## 必守规则

- `seq` 是渲染键：追加只分配递增序号，裁剪不改变存活行序号，`clear()` 不复用旧序号。
- 过滤结果用 `visibleSeqsOffset` 延迟压缩；新增行在 `appendLines` 增量匹配，条件变化才重建。大规模重建使用模块已有的分块和取消逻辑，不能在滚动或每个 RX 帧全量扫描。
- `setFilter` 的 `hideAsciiNoise` 只改变文本视图可见性，并通过 `src/utils/asciiNoise.ts` 判定；不可把显示开关当成接收或日志门控。
- `followEnabled` 必须同时尊重暂停、锁定、手势和时间组授权。搜索定位先撤销跟随；BROWSE 或不兼容来源不得本地尾随。LIVE seek 的确认使用本次 render 后的实际末行。
- 模块级 `managers` 保存每端口实例。TerminalView 挂载调用 `attachRenderer`，卸载调用 `detachRenderer`；只有关闭标签或 TRX 切换到 TTY 才 `releaseViewportManager`。独立 webview 各自拥有注册表。
- `TerminalRenderer` 维护普通文档流顺序：`headSpacer`、行节点、`tailSpacer`；不要恢复 absolute/translate 排序或移动既有行节点。
- 缓冲只受 `computeBufferLimits()` 的 `maxLines` 约束，来源是 `config.maxDisplayLines`；超限逐行覆盖最旧行，不加字节预算、软兜底或清屏通知。
- 所有字节解码都走 `lineText.ts` 的 `createDecoder` / `decodeBytes`，统一 `ignoreBOM: false`。流式解码器必须按端口独占并保留残字节；禁止新增 `new TextDecoder()` 路径。
- 时间索引在 RX 增量时维护，即使当前没有联动；AVL 序号表只引用节点，不复制时间戳。裁剪、清空和销毁必须释放对应索引。
- 软换行是显示几何，不是数据切行；不把视觉续行写回缓冲或 RX，也不为历史全量同步排版。调整尺寸、字体、编码或过滤后保留 `seq` 与行内偏移。
- `frozen = null` 进入序号/可视索引转换时按实现约定归一化，不直接依赖 JavaScript 的 `null` 比较语义。

## 常用检查

```bash
npx vitest run src/utils/terminal
```

`TerminalRenderer` 的 DOM 测试使用 jsdom；性能观测仅在明确需要时以 `HYPERCOM_TERMINAL_BENCH=1` 运行对应测试。行为变化必须覆盖序号稳定、节点复用、过滤偏移、裁剪和软换行等受影响契约。

## 反模式

- 让 stores 依赖 `viewportManager`，或把行数组放回 Zustand。
- 在 `serial:data` 回调中逐事件写行、直接重建搜索集合或调用 manager `dispose`。
- 通过 `scrollTop` 同步时间组，或把回放行追加进实时缓冲。
- 用新增的解码器、过滤扫描或另一套高度/时间索引替代现有实现。
