# HyperCom UI 缺陷追踪

> 由 agents 维护，记录当前项目 UI 层面的瑕疵和修复进度。

## 缺陷清单

### P0 - 严重（影响核心使用体验）

| #  | 问题 | 文件 | 状态 |
|----|------|------|------|
| 01 | 双标题栏：自定义标题栏按钮是死按钮，而 Windows 原生标题栏仍在 | `TitleBar.tsx`, `tauri.conf.json` | ✅ 已修复 |
| 02 | 窗口最小尺寸未在 Tauri 层限制，窗口可缩小到布局崩溃 | `tauri.conf.json`, `App.tsx` | ✅ 已修复 |
| 03 | 主显示区工具栏有"新建标签页"按钮，串口工具中无意义 | `MainDisplay.tsx` | ✅ 已修复 |

### P1 - 重要（显著影响交互）

| #  | 问题 | 文件 | 状态 |
|----|------|------|------|
| 04 | 标题栏最小化/最大化/关闭按钮无实际功能 | `TitleBar.tsx` | ✅ 已修复 |
| 05 | 操作面板三栏布局在窗口缩小时内容溢出/挤压/重叠 | `styles.css`, `OperationPanel.tsx` | ✅ 已修复 |
| 06 | IME 中文输入法按回车确认文字时会误触发发送 | `OperationPanel.tsx` | ✅ 已修复 |
| 07 | 桌面应用中非输入区域右键出现浏览器默认右键菜单 | `App.tsx` | ✅ 已修复 |

### P2 - 一般（体验不佳）

| #  | 问题 | 文件 | 状态 |
|----|------|------|------|
| 08 | 状态栏时钟只在首次渲染时求值，之后不再刷新 | `StatusBar.tsx` | ✅ 已修复 |
| 09 | 空功能按钮（新建分组、一键开/关全部、排序、保存、HEX/文本切换等）点击无反馈 | `Sidebar.tsx`, `OperationPanel.tsx` | ✅ 已修复 |
| 10 | 配置弹窗缺少最小尺寸保障 | `styles.css` | ✅ 已修复 |
| 11 | 侧边栏宽度不可拖拽调整 | `App.tsx`, `styles.css` | ✅ 已修复 |
| 12 | 主题切换下拉框存在于配置页但切换后不生效 | `App.tsx` | ✅ 已修复 |
| 13 | 侧边栏工具栏多个按钮空实现 | `Sidebar.tsx` | ✅ 已修复 |
| 14 | 操作面板"HEX/文本"按钮和"日志文件"按钮空实现 | `OperationPanel.tsx` | ✅ 已修复 |
| 15 | 操作面板循环发送间隔 ms 使用 defaultValue 而非受控组件 | `OperationPanel.tsx`, `useAppStore.ts` | ✅ 已修复 |
| 16 | 配置弹窗"浏览..."按钮未对接 Tauri 文件对话框 | `ConfigModal.tsx`, `Cargo.toml`, `capabilities/default.json` | ✅ 已修复 |
| 17 | 串口参数变更后不会下发给后端 | `OperationPanel.tsx`, `tauri.ts` | ✅ 已修复 |

### P3 - 轻微（细节优化）

| #  | 问题 | 文件 | 状态 |
|----|------|------|------|
| 18 | 状态点颜色硬编码，不随主题切换 | `StatusBar.tsx` | ⏳ |
| 19 | 全局 `user-select: none` 影响部分文字选择场景 | `styles.css` | ⏳ |
| 20 | 标签页过多时无折叠/滚动按钮 | `TabBar.tsx` | ⏳ |
| 21 | 操作面板折叠图标方向语义不清 | `OperationPanel.tsx` | ⏳ |
| 22 | 终端视图使用 mock 硬编码数据 | `TerminalView.tsx` | ⏳ |
| 23 | 上下分屏的 resize handle 方向逻辑问题 | `MainDisplay.tsx` | ⏳ |
| 24 | 空状态提示在分屏模式下不正确 | `MainDisplay.tsx` | ⏳ |

---

## 修复记录

### 2026-05-11 (3): P2 全部修复

**P2-08: 状态栏时钟不刷新**
- 在 `StatusBar.tsx` 中添加 `useState` + `useEffect` + `setInterval` 每秒刷新时钟

**P2-09: 空功能按钮实现**
- 侧边栏：一键打开全部 → 批量调用 toggleConnection；一键关闭全部 → 同理
- 侧边栏：按端口号排序 → 使用 `setPorts` 按 COM 号数字排序
- 侧边栏：保存布局 → 调用 `saveConfig` 保存当前配置
- 侧边栏：新建分组 → 调用 `addGroup` 创建新空分组
- 操作面板：HEX/文本按钮 → 切换 `opDisplayFormat`
- 操作面板：分组的一键开/关按钮 → 批量调用 toggleConnection

**P2-11: 侧边栏拖拽调宽**
- 在 `App.tsx` 添加 `SidebarResizeHandle` 组件，使用 `mousedown/mousemove/mouseup` 实现拖拽
- 从 `useAppStore` 读取/写入 `sidebarWidth`
- CSS 中添加 `.sidebar-resize-handle` 样式，侧边栏 `.sidebar` 移除固定 `width`

**P2-12: 主题切换生效**
- 在 `App.tsx` 添加 `ThemeProvider` 组件
- 监听 `config.theme`，根据值设置 `document.documentElement.setAttribute('data-theme', ...)`
- 支持 `system` 模式，使用 `matchMedia('(prefers-color-scheme: dark)')` 检测系统主题

**P2-14: 操作面板 HEX/文本切换**
- 按钮现在调用 `toggleDisplayFormat` 函数切换 `opDisplayFormat`
- 日志按钮添加 `disabled={!isPortActive}` 防止无选中串口时点击

**P2-15: 循环发送间隔受控组件**
- 在 `useAppStore.ts` 添加 `opLoopInterval` state 字段及 action
- `OperationPanel.tsx` 中 `defaultValue` 改为 `value={opLoopInterval}`，onChange 更新 store

**P2-16: 配置弹窗浏览按钮对接文件对话框**
- 安装 `@tauri-apps/plugin-dialog` 前端包
- 添加 `tauri-plugin-dialog` 到 Rust 依赖和插件注册
- 添加 `dialog:allow-open` 权限
- 通用设置"背景图片"浏览 → `open({ filters: [图片] })`
- 日志设置"日志目录"浏览 → `open({ directory: true })`
- 备份设置"备份目录"浏览 → `open({ directory: true })`

**P2-17: 串口参数变更下发给后端**
- 在 `OperationPanel.tsx` 添加 `useEffect` 监听串口参数变化
- 参数变化时调用 `serialService.setSerialParams()` 和 `serialService.setFlowControl()`
- 使用 `useRef` 跟踪上次参数值，仅在变化时调用后端

### 2026-05-11 (2): 删除无意义按钮 + 禁止浏览器默认右键

**P0-03: 删除"新建标签页"按钮**
- 移除了 MainDisplay 工具栏中的 Plus 按钮

**P1-07: 禁止浏览器默认右键菜单**
- 在 App.tsx 中全局监听 contextmenu 事件，非输入区域调用 e.preventDefault()

### 2026-05-11 (1): P0 + P1 修复

**P0-01/02, P1-04/05/06** — 详见首次修复记录