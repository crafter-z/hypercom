# 跨模块开发约定与陷阱

> 本文承接原根 `AGENTS.md` 中**跨模块**的开发者约定，以及不属于任何单一功能模块的陷阱与平台约束。模块行为细节见 [README.md](README.md) 索引下的各架构文档；目录级文件清单与局部纪律见各子目录 `AGENTS.md`。
>
> **引用纪律**：只写文件与符号名，不写行号。**数字断言**以代码为准：6 个 Zustand store、18 个 hook 文件、13 个命令域文件 / 84 条注册命令、636 个 i18n 键（单侧）、19 个 CSS 文件、47 个 `AppConfig` 字段；计数变化时同步本文与根 [AGENTS.md](../../AGENTS.md)。

## 跨模块开发约定

### Zustand：一律使用 selector

不带 selector 的 store 调用会订阅**整个 store**——每个串口数据事件、每次流量 flush 都会重渲染该组件，表现为输入框失焦、列表卡顿。

```tsx
// 错误：订阅整 store，任何字段变化都重渲染
const { ports, openTab } = useAppStore();

// 正确：只订阅用到的字段
const ports = useAppStore((s) => s.ports);
const openTab = useAppStore((s) => s.openTab);
```

- 状态分在 **6 个 store 模块**：`useAppStore` / `useOperationStore` / `useTerminalStore` / `useRuleStore` / `useSystemStore` / `useToastStore`。字段归属、拆分理由与「新增字段该进哪个 store」见 [config.md](config.md) 的 store 划分表；写纪律见 [src/stores/AGENTS.md](../../src/stores/AGENTS.md)。
- `useAppStore` 不再持有 `systemStatus` / `trafficStats` / `simulationMode` / `ui.*`（已拆到 `useSystemStore`），也不再导出树算法（在 `src/utils/paneTree.ts`）。不要复活 god store。
- 行数据不在 store：终端行缓冲归 `viewportManager` / `TerminalBuffer`，`useTerminalStore` 只存显示态（见 [terminal.md](terminal.md)）。
- 回调/effect 里需要最新值但不订阅时用 `useXStore.getState()`；把 selector 局部变量和 `getState()` 混用是「值不更新」的常见来源。
- 整包对象选择器同样危险：设置页逐字段订阅（如 `useAppStore((s) => s.config.portOrder)`），不要订阅 `s.config` 整个对象——3 秒端口轮询或无关设置变更会带着整页重渲染。

### React 组件必须定义在模块级

在父组件函数体内定义子组件，每次父组件重渲染都会得到新的函数引用，React 视为不同的组件类型：子树被卸载重建，DOM 状态（输入内容、焦点、滚动）全丢。

```tsx
// 错误：每次渲染都新建 Child，输入框丢失焦点
const Parent = () => {
  const Child = (props: Props) => <input {...props} />;
  return <Child />;
};

// 正确：模块级定义
const Child = (props: Props) => <input {...props} />;
const Parent = () => <Child />;
```

`React.memo` / `useCallback` 救不了定义在渲染函数里的组件；需要参数化的子树用模块级组件 + props，渲染函数里返回内联匿名组件同样算反例。

### Flexbox 滚动：整条 min-height: 0 链

flex 列布局的子项默认 `min-height: auto`，不会收缩到内容高度以下；终端滚动容器的任一祖先漏掉 `min-height: 0`，`.terminal-view` 就拿不到受限高度，滚动条不出现（内容把整页撑开或被裁切）。

```css
/* 真实链，顺序不可断 */
.pane-container-inner    { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pane-terminal-wrap      { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.terminal-view-container { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.terminal-view           { flex: 1; min-height: 0; overflow-y: auto; } /* 真正的滚动容器 */
```

TTY 视图同理：父链（`.pane-container-inner > .pane-terminal-wrap`）与 `.tty-view` / `.tty-container` 全链 `min-height: 0`，xterm 内部 `.xterm` 才能靠 `height: 100%` 撑满并滚动。新增分屏/标签包装层时必须补上这一环；相关约束见 [src/components/MainDisplay/AGENTS.md](../../src/components/MainDisplay/AGENTS.md)。

### Rust：不得跨 `.await` 持有 MutexGuard

`std::sync::MutexGuard` 是 `!Send`，而 Tauri 的 async 命令要求 future 为 `Send`；持锁跨 `.await` 既编译不过，也把同步锁带进了异步调度。模式是「提取 + clone + drop 锁，再 await」：

```rust
// 错误
let mgr = state.serial_manager.lock().unwrap();
some_async_fn_using(&mgr).await;

// 正确
let cfg = {
    let mgr = state.config_manager.lock().unwrap();
    mgr.get_config().clone()   // 取出需要的值，作用域结束即释放 guard
};
some_async_fn(&cfg).await;
```

`AppState.log_manager` 是刻意例外：它是 `Arc<LogManager>`（无外层 Mutex），写路径 `&self` + 内部细粒度锁，克隆 `Arc` 就是 `'static` 句柄——**不要**再给它包一层锁。更多反例与 `commands/log.rs` 的示范写法见 [src-tauri/src/commands/AGENTS.md](../../src-tauri/src/commands/AGENTS.md)。

### Hooks：useSerialReceive 与 useSerialSend 的生命周期拆分

旧的 `useSerialData` 同时承担「事件监听」和「发送动作」，而两者生命周期完全不同：监听必须全应用只注册一次，发送动作由多个组件按需调用。混在一个 hook 里会导致重复注册 `serial:data`（每行追加两次），或让发送侧被挂载/卸载牵着走。拆分后：

- **`useSerialReceive()`**：拥有 `serial:data` 事件监听与端口状态处理，**只在 `App.tsx` 调用一次**。字节交给 `getRxPipeline()`（字节级组行 + rAF 批写），TTY 端口直喂 `ttyService.feed`；断线时走 `pipeline.disconnect(portId)` + `ttyService.disconnect(portId)`。不订阅任何 store selector。
- **`useSerialSend()`**：返回发送动作；真正发送在模块级 `sendToPort()`，拥有后端调用、TX 回显、流量统计与发送历史，弹出窗也复用它；TTY 分支跳过本地回显与 `flushNow`。

两者写终端状态都走 `getState()`，避免每行数据触发 hook 宿主重渲染。18 个 hook 文件的清单、调用点、生命周期与反模式（含弹窗 webview 的唯一合法 `serial:data` 例外）见 [src/hooks/AGENTS.md](../../src/hooks/AGENTS.md)。新增 hook 时一个 hook 只拥有一个生命周期并从 `src/hooks/index.ts` 导出；不要复活 `useSerialData` 式合并 hook。

### Rust 命令：CommandError 与 commands/ 拆分

所有 Tauri 命令返回 `Result<T, CommandError>`，**不得返回 `Result<T, String>`**。`CommandError` 定义在 `src-tauri/src/commands/mod.rs`，是 `thiserror` 枚举（`Serial` / `Config` / `Log` / `System` / `Lock` / `Io` / `Other`），手动实现 `serde::Serialize`，前端经 `invoke` 收到格式化字符串。变体定义、触发条件与前端消费路径见 [errors.md](errors.md)。

命令按域拆在 **13 个文件**（`serial.rs` / `config.rs` / `storage.rs` / `plugin.rs` / `plugin_http.rs` / `log.rs` / `file.rs` / `diag.rs` / `popout.rs` / `system_cmds.rs` / `simulation.rs` / `tty_sim.rs` / `update.rs`）；`mod.rs` 只留 `CommandError` 与 `pub use <domain>::*;` 汇总，`wire_shape.rs` 是纯测试契约模块。`src-tauri/src/lib.rs` 的 `generate_handler!` 注册 **84 条命令**，`config/mod.rs` 的 `test_generate_handler_matches_tauri_command_attribute` 解析两侧源文本，漏注册/多注册即红。

新增命令的固定步骤：

1. 在对应域文件实现 `#[tauri::command]`，返回 `Result<T, CommandError>`；
2. 错误用 `map_err(|e| CommandError::<匹配领域>(e.to_string()))` 收敛，只有确实无领域的错误才落到 `Other`；
3. 在 `lib.rs` 的 `generate_handler!` 登记（漂移守卫会核对）；
4. 前端在 `src/services/tauri.ts` 的对应域 service 中转发 `invoke`，不要在组件里裸调。

完整命令清单与各域职责见 [src-tauri/src/commands/AGENTS.md](../../src-tauri/src/commands/AGENTS.md)。

### i18n：双语同源，测试守卫

`src/i18n.ts` 用 i18next + react-i18next，键是**扁平 dotted key**（`keySeparator: false`），`zh-CN` 与 `en-US` 各 **636 个键**。`main.tsx` 顶层副作用 `import './i18n'` 初始化；语言切换由 `useAppStore.subscribe` diff `config.language` 后调 `i18n.changeLanguage`，全界面实时切换。

- 组件内用 `useTranslation()` + `t('namespace.key')` / `t('namespace.key', { var })`；类组件（如 `App.tsx` 的 `AppErrorBoundary`）不能用 hook，只能 `import i18n from './i18n'` 后 `i18n.t('key')`——它不会随语言切换重渲染，仅错误边界这类边缘场景可接受。
- 新增文案先查 `src/i18n.ts` 是否已有 key；不够用时在 `zh-CN` 与 `en-US` **两侧同时新增、位置保持镜像**。`src/i18n.test.ts` 断言两侧键集合相等、书写顺序一致、无重复键、文案非空、插值占位符一致——任一侧漏加或错位都会红。
- **不翻译的字符串**：协议词汇 `None` / `Even` / `Odd` / `Mark` / `Space` / `Xon` / `Xoff` / `RTS` / `CTS`，编码名 `ASCII` / `UTF-8` / `GBK` / `ISO-8859-1`，单位 `ms` / `px` / `MB`，缩写 `SIM` / `VCP` / `HEX` / `DTR` / `RTS`——这些在 `i18n.ts` 中没有对应 key，不要给它们造翻译。
- 后端错误消息是英文原文，**没有**按变体拆分的翻译键；只有确实面向用户的失败文案才走 `notifyError(e, '<key>')` 的显式 fallback（见 [errors.md](errors.md)）。界面不得残留硬编码中文。

### 提交信息约定

```
type(scope): description
```

- `type`：`feat` | `fix` | `docs` | `style` | `refactor` | `perf` | `test` | `chore`
- `scope`：常用 `ui` | `backend` | `store` | `hooks` | `docs`（历史提交也使用 `config` / `test` 等按域细分的 scope）
- `description`：英文、小写开头、祈使句、不加句号；一个提交只做一类逻辑变更。

仓库内的真实示例：`feat(ui): reload installed plugin code and confirm replacements`、`fix(ui): repair window drag and popout close`、`docs: document plugin network, storage, reload and view transport`。提交前 `npx tsc --noEmit` 与 `cargo check` 必须通过，CI 另跑 `cargo test --lib --manifest-path src-tauri/Cargo.toml`（质量门见 `.github/workflows/ci.yml`）。

## 跨模块陷阱

下列条目不属于任何单一模块文档。与模块文档重叠处只保留跨模块部分（形状、命名、守卫），语义细节一律给链接。

### 不可信 CSS 颜色必须过 `safeCssColor`

高亮规则与协议模板的颜色来自用户输入/导入文件，渲染器会把它们插进 `innerHTML` 的 `style="color:…"`；引号、尖括号、`;`、`url()` 等可以逃出属性造成存储型 XSS。**唯一入口**是 `src/utils/cssColor.ts` 的 `safeCssColor()`：trim + 长度上限 64，只接受十六进制、命名色与纯数字参数的 `rgb()/rgba()/hsl()/hsla()`，其余返回 `null`（调用方省略该 style）。`highlightEngine` 与 `protocolRenderer` 共用它；**禁止**在渲染器里各自写正则或直接插值。

### `serial:data` 的字节形状与 `Array.from`

`serial:data` 线上 `data` 是字节数组（Rust `Vec<u8>` → JSON `number[]`）；前端 `TerminalLine.rawData` 是 **`Uint8Array`**（RX 行与 TX 行同型）。逐字节处理时 `Uint8Array` 没有 `.map()`，必须 `Array.from(...)` 再映射（`protocolRenderer` 的 field coverage 即因此改写）；解码唯一入口是 `src/utils/lineText.ts`（`createDecoder` / `decodeBytes` / `getLineText`，`ignoreBOM: false`），RX 行只存 `rawData`、读取时按当前编码惰性解码。数据通路细节见 [terminal.md](terminal.md)。

### `serial:file_progress` 是 camelCase wire

Rust 的 `FileProgressPayload` 带 `#[serde(rename_all = "camelCase")]`，线上字段是 `{portId, transferId, sentBytes, totalBytes, done}`——与其它多数 snake_case 事件不同，改字段必须同时改 TS interface。`src/services/eventContract.test.ts` 从 Rust 与 TS 两侧源文本解析结构体/接口，断言 `rename_all = "camelCase"` 与逐字段 camelCase 同名，`tsc` 看不到的命名漂移由它守卫。字段语义见 [transmission.md](transmission.md)。

### 配置目录单实例锁：`config.lock`

`AppState::new`（`src-tauri/src/lib.rs` 的 `acquire_instance_lock`）在 `config.json` 同目录打开 `config.lock`（`with_extension("lock")`，写入 PID）：Windows 以不共享方式打开（`share_mode(0)`），Unix 用 `flock(LOCK_EX | LOCK_NB)`；拿不到锁的第二个实例初始化失败并退出。原因：并发实例会争 `config.json` / `session.json` 的固定临时文件名与逐进程 revision CAS，互相覆盖。不要用进程内锁或前端标记替代它。

### 文件对话框由宿主拥有

`commands/file.rs` 的 `pick_text_file_and_read` / `pick_text_file_and_write` 与 `commands/log.rs` 的 `pick_and_save_log` 都在 Rust 侧弹原生对话框；前端只传 `title` / `defaultFileName` / `filters`，**不传任意路径**。`read_text_file` 仅用于日志回放且限定在配置的日志根内。插件侧唯一入口是 `plugin_pick_files`（验证启用与 `fs:open` 授权）。新增导入/导出沿用宿主对话框，不要让前端拼路径交给后端直接读写（命令归属见 [errors.md](errors.md)、[plugins.md](plugins.md)）。

### 数值输入用 draft 提交（`NumericInput` + `clampNumber`）

`src/components/shared/NumericInput.tsx` 在输入期间保留原始草稿串，只在 **blur / Enter** 时调 `clampNumber` 提交；禁止在 `onChange` 里逐键 clamp——min=8 的字段输入 `24` 会被夹成 `2 → 8 → 84`，中间值永远到不了。数值范围来自前端镜像 `src/utils/bounds.ts` 的 `CONFIG_BOUNDS`；页面局部范围成对声明，避免参数与 `min`/`max` 属性漂移（见 [src/components/ConfigModal/AGENTS.md](../../src/components/ConfigModal/AGENTS.md)）。

### `src/styles/` 拆分与 `src/styles.css` 入口

样式按组件/页面拆在 `src/styles/`，当前 **19 个 CSS 文件**（`base.css` + 18 个组件/页面样式）；仓库根的 `src/styles.css` 只是 `@import` 入口，不是主样式表，且 `base.css` 必须最先导入（设计 token / CSS 变量才可用）。新增样式建独立文件并在入口登记；不要把组件样式堆进 `base.css` 或 `app.css`。

### 插件路径组件统一校验

`plugin::validate_path_component`（`src-tauri/src/plugin/mod.rs`）是 ZIP 解压、`sanitize_plugin_rel_path`（入口/资产/数据路径）共用的**单段**校验：拒绝空段、尾随点/空格、`:`、`~`、控制字符与 Windows 设备名（`CON` / `PRN` / `AUX` / `NUL` / `COM1`–`COM9` / `LPT1`–`LPT9`）。只检查 `..` 不够——盘符、UNC 与别名路径都要按段校验；插件 id 另由 `validate_plugin_id` 校验反向域名标签（同样拒绝 Windows 设备名）。宿主侧完整路径策略见 [plugins.md](plugins.md)。

### `tauri.conf.json` 关闭系统装饰 + 自绘 TitleBar

主窗配置 `"decorations": false`，窗口控制由自绘 `TitleBar`（`src/components/TitleBar/TitleBar.tsx`）经 `@tauri-apps/api/window` 的 `getCurrentWindow()` 执行 `minimize` / `toggleMaximize` / `close` / `setTitle`，拖拽靠 `data-tauri-drag-region`；弹出窗创建时同样 `decorations(false)` 并使用 `.popout-titlebar` 自绘标题栏（`commands/popout.rs`）。改回系统装饰会与自绘标题栏重叠、出现双份按钮；新增窗口沿用自绘标题栏。

### tsconfig 严格性

`tsconfig.json` 开启 `strict`、`noUnusedLocals`、`noUnusedParameters`：未使用的局部变量与函数参数是**编译错误**，不是警告。重构删除代码时同步删 import / 参数 / 类型，否则 `npx tsc --noEmit` 与 CI 直接红。

## 平台能力说明

### 跨平台电源管理（防息屏 / 防休眠）

实现集中在 `src-tauri/src/system.rs`，是**唯一**的平台适配层：

- 共享「期望状态 → 整体应用」骨架：`DESIRED_STATE: Mutex<(prevent_sleep, prevent_screen_off)>`，每次只更新一半，然后把**完整状态**交给当前平台后端。三个平台的底层 API 都按整体状态语义生效（Windows `SetThreadExecutionState` 每次调用替换线程执行状态；`caffeinate` / `systemd-inhibit` 的参数描述完整抑制集合），分开应用会互相抵消（最后一次调用生效）。
- 平台差异只在两个后端模块：`win32_backend`（专用线程调用 Win32 `SetThreadExecutionState` FFI）与 `child_process_backend`（重启持有抑制的子进程，macOS `caffeinate` / Linux `systemd-inhibit`）。
- 调用方：前端开关路径只经 `commands/system_cmds.rs` 的 `prevent_sleep` / `prevent_screen_off`（`usePowerManagement` 把 `config.preventSleep` / `config.preventScreenOff` 镜像到 OS）；退出时 `lib.rs` 的关闭协调器调用 `shutdown_power_inhibitor` 释放抑制，`POWER_SHUTTING_DOWN` 防止迟到的前端 effect 重新创建抑制。
- 新增平台或能力时在 `system.rs` 增加后端模块并复用同一状态机；**不要**另写 FFI、另起一套状态机，也不要从其它命令文件直接调 `crate::system::*`。

## 相关文档

| 主题 | 文档 |
|---|---|
| 架构文档索引 | [README.md](README.md) |
| 配置、状态与 store 划分 | [config.md](config.md) |
| 串口管理 | [serial.md](serial.md) |
| 数据收发（RX/TX/循环/快捷/触发） | [transmission.md](transmission.md) |
| TRX 终端显示 | [terminal.md](terminal.md) |
| TTY 终端 | [tty.md](tty.md) |
| 日志与诊断日志 | [logging.md](logging.md) |
| 工作区、标签页、通知 | [workspace.md](workspace.md) |
| 错误处理（CommandError） | [errors.md](errors.md) |
| 插件宿主内部架构 / 插件隔离视图 | [plugins.md](plugins.md) / [plugin-views.md](plugin-views.md) |

目录级约定（各模块内部文件清单与局部纪律）：

- [src/hooks/AGENTS.md](../../src/hooks/AGENTS.md) — 18 个 hook 的清单、生命周期、反模式
- [src/stores/AGENTS.md](../../src/stores/AGENTS.md) — store 写纪律
- [src-tauri/src/commands/AGENTS.md](../../src-tauri/src/commands/AGENTS.md) — 命令域清单、CommandError 用法、锁纪律反例
- [src/utils/terminal/AGENTS.md](../../src/utils/terminal/AGENTS.md) — 终端引擎（方案B）目录约定
- [src/components/MainDisplay/AGENTS.md](../../src/components/MainDisplay/AGENTS.md)、[src/components/ConfigModal/AGENTS.md](../../src/components/ConfigModal/AGENTS.md)、[src/components/OperationPanel/AGENTS.md](../../src/components/OperationPanel/AGENTS.md) — 组件层约定

根工程说明与构建/质量门见 [../../AGENTS.md](../../AGENTS.md)。
