# 10 — Flexible Workspace（柔性工作区 · 通用弹出体系）

> 最后更新：2026-08-01 · 状态：设计已确认，进入实现

## 背景与目标

HyperCom 工作区当前为固定布局。串口调试的真实负载差异极大——快捷命令少则三五条、多则几十条；终端输出有时需要挪到副屏长时间盯着。固定布局无法兼顾。

本特性把工作区从"固定"进化为"柔性"：面板既能**弹出**为独立 OS 窗口（跨屏摆放、永不遮挡主窗口输出），功能区也能**收放**（窗内省空间）。

**本轮范围**：通用弹出管线 + 快捷发送（溢出条 + 独立窗）+ 终端标签弹出。
**明确排除**：操作面板弹出、串口控制栏弹出（前端态双向耦合，留待体系成熟后）。

## 已确认的设计决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 弹出机制 | **通用化**，服务终端标签 + 快捷发送两个客户 |
| 2 | 快捷发送形态 | **溢出式**：内联小条（前 N 条）+ 超出开瘦高独立窗 |
| 3 | 独立窗默认形态 | 瘦高竖排（Stream Deck 式），贴边置顶，最少抢屏 |
| 4 | 数据模型 | **复用 `SendCommandSet`**，不新造槽位表；删除死代码 `quickSendSlots` |
| 5 | 终端弹出语义 | **detach**（撕标签式）：标签移入独立窗，主窗占位，关窗回贴 |
| 6 | 快捷发送窗编辑入口 | 跳主窗 ConfigModal 命令页（经意图事件），不做窗内 inline 编辑 |
| 7 | 窗口位置/尺寸 | **跨会话持久化** |
| 8 | `quickSendInlineCount` | 默认 **6**，设 0 = 隐藏内联条（纯窗口模式） |
| 9 | 内存顾虑 | 撤销（串口缓冲量级远超 WebView 开销） |
| 10 | 功能区收放 | 纳入规划，本轮不详细实现 |

## 核心架构原则（贯穿全程）

1. **弹出窗之间不共享可变前端态，只交换"意图/事件"。** 这是整个体系的协议基石。
2. **后端 / SQLite 是唯一真相，事件只当"刷新信号"（不携带数据）。** 弹窗收到信号后自己回库读，避免两个 store 对不齐。
3. **耦合度决定落地顺序**：快捷发送（只写后端，低）→ 终端（只读流 + 一次性快照，中）→ 控制栏（双向前端态，高，排除）。
4. **面板组件与宿主解耦**：`QuickSendPanel` / 终端视图是纯组件，独立窗只是壳，将来可复用于应用内浮层。

## 耦合度判据（为何控制栏被排除）

| 弹出对象 | 数据关系 | 耦合度 |
|---|---|---|
| 快捷发送 | 只**发**（走后端命令，天然跨窗口） | 低 |
| 终端标签 | 只**收**（订阅 `serial_data` 流 + 一次性历史快照） | 中 |
| 串口控制栏 | **又读又写前端态**（端口列表同步 + 开标签/切焦点要反映到主窗 `useAppStore`） | 高 |

控制栏的"连接/断开"走后端命令哪个窗口都能调，但"开标签/切焦点"是纯前端态（tabs 活在 `useAppStore`，后端没有），需要额外的"意图总线"。故本轮排除，且对控制栏而言**收放比弹出更值钱**（间歇性使用，多数时候想收没而非挪到副屏）。

---

## Phase 1 · 通用弹出管线（地基）

### 1.1 窗口注册表（Rust，`AppState`）

- 新增 `popouts: Mutex<HashMap<String, PopoutMeta>>`，key 为窗口 label，value 记 `{kind, target_id}`。
- label 约定：快捷发送 = `"quick-send"`（单例）；终端 = `"terminal-{safe_id}"`（每端口一个）。
- label 安全化：portId 可能含特殊字符，需映射为标识符安全字符串（如非 `[A-Za-z0-9_-]` 字符替换为 `_`，并保留可逆映射或哈希后缀防冲突）。

### 1.2 通用命令

- `open_popout(kind: String, target_id: Option<String>) -> Result<(), CommandError>`
  - label 已存在 → `set_focus()` 拉起；否则 `WebviewWindowBuilder` 新建。
  - URL：`WebviewUrl::App("index.html?popout={kind}&id={target_id}")`。
  - 属性：`.decorations(false)`（自绘窄标题栏）、`.always_on_top(true)`、`.skip_taskbar(true)`、`.parent(&main)`（owner 语义：随主窗最小化/销毁、恒在主窗之上）、`.inner_size()` 按 kind 取默认（快捷发送 ~280×640）。
  - 位置/尺寸：从持久化配置恢复（若有）。
- `close_popout(label: String) -> Result<(), CommandError>`
- `set_popout_always_on_top(label, on)` —— 置顶开关。
- 窗口移动/缩放结束时回写持久化位置（前端监听 `onMoved`/`onResized` → invoke 保存，或后端 `on_window_event`）。

### 1.3 前端路由分流（`main.tsx`）

- 无 React Router，用 `new URLSearchParams(window.location.search)` 读 `popout` 参数。
- 有 `popout` → 渲染 `<PopoutShell/>`（按 kind 分发到 `QuickSendPanel` / `TerminalPopout`）；无 → 渲染现有 `<App/>`。
- `PopoutShell`：自绘标题栏（拖拽区 `data-tauri-drag-region` + 置顶切换 + 关闭按钮），内容区按 kind 渲染。

### 1.4 事件 / 意图协议

| 事件 | 方向 | 载荷 | 用途 |
|---|---|---|---|
| `command-sets:changed` | 主窗 → 快捷发送窗 | 无（信号） | 命令集改动后弹窗回库刷新 |
| `active-tab:changed` | 主窗 → 快捷发送窗 | `portId` | 弹窗知道发送到哪个端口 |
| `serial_data` | 后端 → 所有窗 | 字节流 | 终端弹窗订阅（**需验证当前是否全播**，见 R1） |
| `popout:terminal:snapshot` | 主窗 → 终端弹窗 | 历史行（一次性） | 弹出时补历史 |
| `popout:open-config` | 弹窗 → 主窗 | `{page}` | 弹窗请求主窗打开 ConfigModal 指定页 |

### 1.5 状态同步策略

- 命令集：弹窗 mount 时 `load_command_sets()` 直读 SQLite；主窗 save 后 emit `command-sets:changed`，弹窗重读。
- 发送：弹窗直接 `invoke('send_data')` → 共享 `AppState` → 后端 emit `serial_data` → 主窗 `useSerialReceive` 自动写终端。**发送→回显链路天然跨窗口，零额外代码。**

### 1.6 权限配置（`capabilities/default.json`）

- 给弹出窗 label 授权（或建一个覆盖所有 popout label 的 capability）。**漏配会导致弹窗内 invoke 静默失败**（高频坑，见 R2）。

---

## Phase 2 · 快捷发送（首个客户）

### 2.1 内联溢出条（`SendSection.tsx`）

- 渲染 `commands.slice(0, N)`，**单行不换行**，宽高严格有界。
- 溢出按钮显示**实时计数** `⋯ +{hidden}`，点击 → `open_popout("quick-send")`。
- `N = config.quickSendInlineCount`（默认 6）；**设 0 = 隐藏整条，纯窗口模式**。
- 取集合中 `order` 最靠前的 N 条（v1）；"置顶常用"留 v2。

### 2.2 `QuickSendPanel`（瘦高独立窗内容，宿主无关组件）

- 顶部搜索框（按名称 + 内容模糊过滤，`/` 聚焦）。
- 命令集切换下拉 + "编辑"按钮（emit `popout:open-config{page:'commands'}` 跳主窗 ConfigModal）。
- 纵向列表，每行：名称（主）+ 内容（等宽副）+ `[STR]/[HEX]` 徽标 + 行尾符；**整行可点 = 发送**。
- 键盘流：`↑/↓` 导航、`Enter` 发送、`/` 搜索。
- 底部：目标端口只读指示（`发送到 ● COM3`）+ 置顶开关。
- 与内联条**共用视觉语言与发送反馈动效**（发送成功短促闪烁）。

### 2.3 配置项

- `quickSendInlineCount: number`（默认 6，0 = 隐藏）—— `config/mod.rs` + `types` + `useAppStore` 默认值 + `validate_and_clamp`。
- `popoutBounds: Record<string, {x,y,width,height}>`（持久化各弹出窗位置/尺寸）。

### 2.4 死代码清理

- 删除 `quickSendSlots`：`config/mod.rs`（字段 + validate）、`types/index.ts`、`useAppStore` 默认值、相关测试引用。

---

## Phase 3 · 终端标签弹出（复用管线）

### 3.1 触发入口

- TabBar 标签右键菜单 / 分屏按钮组旁加"弹出"动作 → `open_popout("terminal", portId)`。

### 3.2 detach 语义（已确认）

- 弹出：给 tab 打 `poppedOut: true` 标记，主窗该 tab 终端显示"已弹出"占位（含"收回"按钮），paneTree 中保留 tab 身份不销毁。
- 关窗：清除标记，tab 在主窗恢复显示。
- 重复弹出同一端口：聚焦已有窗口而非新建。

### 3.3 数据流

- 新数据：弹窗订阅 `serial_data`（后端已广播），自建缓冲 + 跑虚拟滚动。
- 历史：终端行是前端内存态（`memoryLimitMb` 上限），**不在 SQLite**。弹出时主窗经 `popout:terminal:snapshot` 一次性推送当前缓冲（大缓冲注意载荷体积，见 R3）。
- 显示态（编码/格式/滚动锁定）：弹窗自带控制，降低耦合。

---

## Phase 4 · 功能区收放（路线图，轻量）

- 左侧串口控制栏：VSCode 式收起到窄图标轨 / 隐藏，汉堡按钮切换，状态持久化（`useAppStore.ui`）。
- 耦合度低（纯 UI 态），可独立于弹出体系随时插入。
- 本轮仅占位，不详细设计；实现中若发现与弹出体系耦合则一并处理。

---

## 分期与依赖

```
Phase 1 通用弹出管线 ──┬──> Phase 2 快捷发送（验证管线，低耦合）
                       └──> Phase 3 终端弹出（复用管线，中耦合，detach + 快照）
Phase 4 收放（独立，任意时机插入）
```

提交粒度：每个 Phase 独立可验证、独立 commit；Phase 2 的溢出条与独立窗可拆两个 commit。

## 风险与待验证

| # | 风险 | 应对 |
|---|---|---|
| R1 | `serial_data` 当前是否广播到所有窗口（若 `emit_to` 定向则弹窗收不到） | Phase 3 开工前验证 `serial/mod.rs` 的 emit 方式，必要时改全播 |
| R2 | 弹窗 capability 漏配 → invoke 静默失败 | Phase 1 即配齐 + 冒烟验证 |
| R3 | 终端历史快照载荷过大（接近 memoryLimitMb） | 评估分片推送 / v1 仅推近 N 行 |
| R4 | Windows 窗口 z-order / 焦点怪癖 | `.parent()` owner 语义兜底 + 实测 |
| R5 | portId 含特殊字符做 label | label 安全化映射 |

## 验收标准

- 快捷发送：≤N 条仅显示内联条；>N 条溢出计数正确、点击开窗；窗口瘦高、贴边、置顶、随主窗最小化；搜索/键盘/发送可用；主窗改命令集后弹窗实时刷新；`quickSendInlineCount=0` 时内联条隐藏。
- 终端弹出：标签可 detach 为独立窗，历史 + 实时数据均正确，关窗回贴主窗，重复弹出聚焦。
- 通用管线：同一 `open_popout` 服务两种 kind；窗口位置/尺寸跨会话恢复。
- 质量门：`npx tsc --noEmit` 0 错、`cargo check` 0 错 0 警、`npm run test:run` 与 `cargo test --lib` 全过；`quickSendSlots` 死代码清零。
