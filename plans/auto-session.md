# 自主迭代工作日志

## 2026-07-25 UI/UX 大修

> 日期: 2026-07-25 | 模式: 5 路并行 agent + orchestrator integration | 提交: 待提交 | 类别: UI/UX refactor + bug fix

### 范围

13 项用户反馈问题 + 3 项同源附加项（per-tab 显示状态、opStore 反写补丁移除、`window.prompt` 替换）一并落地。

### 修复清单

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 会话恢复标签启动即误报"端口已断开"横幅 | 横幅未过滤 session-restored 标签 | `useTauri.ts` 模块级 `lostPortIds` + `isPortLost`；横幅改由纯函数 `filterLostTabIds` 驱动 (单测) |
| 2 | 编码切换"不生效" | `scrollLocked`/`showTimestamp`/`displayFormat`/`encoding` 全局态覆盖 per-tab 终端 | 4 字段移出 opStore，控件下沉 `TerminalFilterBar` 直写 `useTerminalStore` |
| 3 | 编码切换只影响新数据 | 没重解码存量行 | 新增 `setTerminalEncoding` 从 `rawData` 重解码全部存量 |
| 4 | Ctrl+Enter 全局发送与换行决策冲突 | 两个热键抢同一语义 | 移除全局热键及帮助弹窗对应行 |
| 5 | 循环发送 `loopInterval` 语义重叠 | 双数据源（间隔字段 + 命令集延时） | 移除间隔字段，时机由命令集延时唯一决定 |
| 6 | HEX/字符串切换无内容转换 | toggle 没跑转换 | `sendUtils.ts` 新增 `textToHexPreview`/`hexToTextPreview`/`sanitizeHexInput` |
| 7 | 发送历史持久化过度设计 | 用户决策：无需持久化 | per-port `Map<string, SendHistoryEntry[]>`，上限 50；移除 `sendHistoryService` |

### Layout 重构

| # | 变更 | 说明 |
|---|------|------|
| 8 | `ViewStrip.tsx` 删除 | 顶部 strip 内联至 OperationPanel (连接/清屏 ‖ 回放速率/启停 ‖ 日志另存/打开/目录 ‖ 字号) |
| 9 | SendSection 重构 | connect/clear 迁出；Enter-toggle 进 GeneralSettings；HEX toggle 双向转换；文件发送移至 Send 按钮旁 |
| 10 | ParamsSection 简化 | 预设下拉改 apply-only；预设管理整体迁至 GeneralSettings (无 `window.prompt`) |
| 11 | TabBar split 按钮 | 从 `main-display-toolbar` 行迁至每个 Pane 的 TabBar 右端 (`onSplitVertical`/`onSplitHorizontal`) |
| 12 | Sidebar 一级工具栏 | open-all / close-all 从 ⋯ 菜单升级为 icon-button |
| 13 | GeneralSettings 扩容 | + Enter 行为开关 (`!config.sendOnEnter`) + 预设管理 section |
| 附 1 | per-tab 显示状态 | 随 bug 2 顺势落地 |
| 附 2 | opStore 反写补丁移除 | bug 2 顺势清理 |
| 附 3 | `window.prompt` 替换 | 预设管理 inline 命名 |

### i18n

- +9 keys: `generalSettings.enterNewline`, `generalSettings.enterNewline.hint`, `generalSettings.presets.*` ×6, `sendSection.input.placeholder.hex`
- −12 dead keys: `rulesSection.interval*`, `op.send.enterBehavior.*` ×4, `op.send.clearHistory`, `paramsSection.preset.{namePrompt,saveTooltip,deleteTooltip}`, `hotkeys.send`, `mainDisplay.toolbar.paneCount`

### 验证

| 检查 | 结果 |
|------|------|
| `npx tsc --noEmit` | 0 errors |
| `vitest run` | 179/179 (11 files) |
| `cargo check` | 0 errors, 0 warnings |
| `cargo test --lib` | 33/33 |

### 文档同步

9 份 plan 文档按本次变更更新 (01-overview / 02-architecture / 05-components / 06-status / 08-defects / 09-reference / test-checklist / auto-session / 10-v0.1-roadmap)。README 与 AGENTS.md 由另一 agent 同步。

---

## 2026-06 重构批次

> 开始: 2026-06-19 | 模式: 无监督自主迭代 | 提交: 12 commits | 工作单元: 16 | 阶段: 5

### Phase 1 — 后端重构 (4 commits, 10 work units)

| Commit | 范围 | 说明 |
|--------|------|------|
| `ccfd867` | `fix(backend)` | GBK 解码改用 `encoding_rs::GBK`, 替换 U+FFFD 占位符。后端输出正确 UTF-8, 前端 `TextDecoder` 处理其他编码 |
| `6d805b3` | `refactor(backend)` | 移除 serial 死代码 (未使用函数/字段), 抽取 `emit_data_event` helper 统一事件推送, 移除 `get_traffic_stats` TODO stub |
| `8bf661d` | `refactor(backend)` | 移除 storage 死 CRUD, 合并 4 对重复类型, 合并重复 schema SQL, 6 处 `.lock().unwrap()` 改为 `.map_err()` |
| `686b7be` | `refactor(backend)` | commands 单体 400+ 行拆分为 6 个领域文件 (`serial.rs` / `storage.rs` / `config.rs` / `log.rs` / `system_cmds.rs` / `simulation.rs`), 新增 `CommandError` 枚举 (thiserror, 9 变体), 抽取 `system.rs` (`win32_power`), `export_terminal_log` 添加路径校验 |

### Phase 2 — 工具与 Store (2 commits, 2 work units)

| Commit | 范围 | 说明 |
|--------|------|------|
| `5224457` | `fix(utils)` | 抽取 `hexUtils.ts` (`hexToString` / `stringToHex`), 移除 3 个死导出 |
| `cec426c` | `refactor(store)` | god store 608 行拆分为 4 个 store: `useAppStore` (437 行, tabs/ports/panes/config/groups), `useOperationStore` (55 行, 操作字段无 `op` 前缀), `useTerminalStore` (49 行), `useRuleStore` (47 行)。抽取 `removeEmptyPanes` helper |

### Phase 3 — Hooks 重构 (1 commit, 2 work units)

| Commit | 范围 | 说明 |
|--------|------|------|
| `8944418` | `refactor(hooks)` | `useSerialData` 拆分为 `useSerialReceive` (事件监听, App.tsx 调用一次) + `useSerialSend` (发送动作, OperationPanel 调用)。13 处 `.catch(() => {})` 改为 `console.debug` |

### Phase 4 — UI 组件拆分 (4 commits, 4 work units)

| Commit | 范围 | 说明 |
|--------|------|------|
| `a724c05` | `refactor(ui)` | ConfigModal god component 450 行拆分为 10 个文件: `ConfigModal.tsx` (109) + `RuleSetAccordion.tsx` (78) + 6 个 pages + 2 个 editors |
| `3ed0bab` | `refactor(ui)` | OperationPanel 410 行拆分为 4 个文件: `OperationPanel.tsx` (138) + `SendSection.tsx` (136) + `ParamsSection.tsx` (137) + `RulesSection.tsx` (108) + `useCyclicSend` hook (119) |
| `e33bd30` | `refactor(ui)` | Sidebar 抽取 `usePortDragEnd` hook (80 行) + `AliasDialog` 组件 (37 行), `useSensors` 移至组件顶层 |
| `bbd4540` | `refactor(ui)` | MainDisplay 拆分为 `MainDisplay.tsx` (132) + `Pane.tsx` (160) + `ResizeHandle.tsx` (34) + `useTabDragEnd` hook (73)。closeTab 路由通过 `useSerialConnection.closePort()` 修复生命周期泄漏。移除 `setTimeout(0)` hack (Zustand 是同步的) |

### Phase 5 — 样式拆分 (1 commit, 1 work unit)

| Commit | 范围 | 说明 |
|--------|------|------|
| `ef32ce0` | `refactor(ui)` | `styles.css` 单体 1427 行拆分为 11 个文件 (base/titlebar/sidebar/main-display/tabbar/terminal-view/operation-panel/status-bar/config-modal/context-menu), 移除 20 个死 CSS class |

### 验证

| 检查 | 结果 |
|------|------|
| `npx tsc --noEmit` | 0 errors |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 0 errors, 0 warnings |
| `npm run test:run` | 71/71 passing (2 test files, 210ms) |
| `cargo test --lib` | 24/24 passing |

### 缺陷清零

本次重构修复 20 项缺陷 (编号 58-79 + 早期遗留 29/40/44), 详见 `plans/08-defects.md` 的「已修复 (2026-06 重构批次)」章节。重构后「未修复」列表为空。

### 总结

**12 commits, 16 work units, 5 phases。** 后端从单体 commands 文件拆为 6 个领域文件 + 类型安全错误枚举。前端从 god store 拆为 4 个职责清晰的 store, god 组件拆为可维护的小文件, 单体样式拆为 11 个按组件划分的 CSS。所有验证全绿。

---

## 2026-05-17 初始迭代

> 开始: 2026-05-17 10:49 | 结束: 2026-05-17 11:30
> 模式: 无监督自主迭代 | 提交: 4 commits | 耗时: 41min

## 执行记录

### 10:49 Phase 1 — 标题栏窗口控制
跳过。`TitleBar.tsx` 已完整实现。

### 10:50 Phase 2 — 日志操作按钮 ✅
- "另存为" → `@tauri-apps/plugin-dialog` `save()` → `logService.saveLogAs()`
- "打开文件" → `logService.getLogFiles()` → `@tauri-apps/plugin-shell` `open()`
- "打开目录" → `config.logDirectory` → shell `open()`

### 10:57 Phase 3 — HEX 发送格式解析 ✅
`serial/mod.rs` `send_data()`: 解析 `"48 65 6C 6C 6F"` → `[0x48, 0x65, ...]`，奇数长度/非法字符→返回 Err

### 10:58 Phase 4 — 日志分片+文件名 ✅
`logger/mod.rs`: `write()` 检测超限→关闭旧文件→创建新文件续写；`create_writer()` 支持 `[com]/[datetime]/[date]/[time]` 变量替换；`list_files()` 从文件名解析 port_id

### 11:01 Phase 5 — 串口参数扩展 ✅
`SetSerialParamsArgs` 新结构体 (baud_rate + data_bits + parity + stop_bits + handshake)；前端 `setSerialParams` 传参更新

### 11:04 Phase 6 — 缺陷发掘 ✅
- HEX 边界修复: 奇数长度/非法字符→Err
- `save_log_as` 无写入器→返回 Err 而非静默失败
- `start_logging` 改为读取 `config.log_format` 而非硬编码 `"string"`
- 修复 `%APPDATA%` Windows-only 路径

### 11:07 Phase 7 — 自动日志记录 ✅
`useSerialConnection`: openPort 连接成功后若 `config.autoSaveLog=true` 自动 `startLogging()`；closePort 自动 `stopLogging()`

### 11:11 Phase 8 — 终端增强 ✅
- `TerminalLine.rawData` 存储原始字节
- TerminalView HEX 视图: `displayFormat === 'hex'` 时渲染 `A0 B1 C2`
- 右键菜单导出 TXT/CSV 到剪贴板
- `opDisplayFormat` + `opShowTimestamp` → `terminal` 同步
- `config.memoryLimitMB` → `terminal.maxLines` (500行/MB)
- StatusBar 显示当前端口 ID
- 终端工具栏显示实时端口参数
- `opIgnoreEmptyChars` 过滤生效

### 11:28 Phase 10 — Ctrl+Scroll 字体缩放 + 字体实时应用 ✅
- TerminalView: Ctrl+鼠标滚轮调整字体大小 (8-48px)
- ThemeProvider: 启动时将 `terminalFontSize/terminalFont/uiFontSize/uiFont` 应用到 CSS 变量

### 11:30 — commit#4: 字体缩放
`d679f34` — 2 files, +22/-2

## 提交记录

| # | Commit | 时间 | 描述 | 文件 |
|---|--------|------|------|------|
| 1 | `45347e3` | 11:16 | log ops, HEX parse, split, serial params, auto-logging | 9 files, +238/-22 |
| 2 | `30a9b34` | 11:19 | HEX display, data export, param sync, terminal improvements | 9 files, +74/-13 |
| 3 | `6a8865b` | 11:26 | command history, smart auto-scroll | 2 files, +54/-3 |
| 4 | `d679f34` | 11:30 | Ctrl+Scroll font scaling, live font apply | 2 files, +22/-2 |

## 总结

**4 commits, 18 项功能, 7 个缺陷修复, 41分钟完成。** Rust + TypeScript 均 0 error/warning 编译通过。
