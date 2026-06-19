# 待办事项

## 🟡 中优先级

### 分屏嵌套
- 当前 Pane 为平铺模型，不支持树状嵌套分屏 (VS Code 式)
- Pane 内再分屏需重构 `SplitPane` 为树结构

## 🟢 低优先级

### 协议解析器
- 后端定义协议模板 (帧头/长度/校验/帧尾)，自动解析并高亮各字段
- 前端提供协议模板编辑器

### 多语言 i18n
- 引入 `i18next` + `react-i18next`
- 创建 `zh-CN.json` / `en-US.json`
- 所有组件文本替换为 `t('key')`

### 字体缩放
- 终端字体大小绑定 `--font-size-terminal` CSS 变量
- 添加 Ctrl+滚轮 或滑块调整

### 背景图片
- ConfigModal 已有路径选择，需实现在主窗口 CSS `background-image` 应用

## ✅ 已完成（移出待办列表）

### 2026-06 重构批次 (12 commits)

| Commit | 范围 | 说明 |
|--------|------|------|
| `ccfd867` | `fix(backend)` | GBK 解码改用 encoding_rs, 替换 U+FFFD 占位符 |
| `6d805b3` | `refactor(backend)` | 移除 serial 死代码, 抽取 emit_data_event helper |
| `8bf661d` | `refactor(backend)` | 移除 storage 死 CRUD, 合并重复类型, 修复 6 处 .lock().unwrap() |
| `686b7be` | `refactor(backend)` | commands 单体拆分为 6 个领域文件 + CommandError 枚举 + 抽取 win32_power |
| `5224457` | `fix(utils)` | 抽取 hexUtils, 移除 3 个死导出 |
| `cec426c` | `refactor(store)` | god store 拆分为 4 个 store + removeEmptyPanes helper |
| `8944418` | `refactor(hooks)` | useSerialData 拆分为 useSerialReceive + useSerialSend |
| `a724c05` | `refactor(ui)` | ConfigModal 拆分为 10 个文件 + RuleSetAccordion |
| `3ed0bab` | `refactor(ui)` | OperationPanel 拆分为 4 个文件 + useCyclicSend hook |
| `e33bd30` | `refactor(ui)` | Sidebar 抽取 usePortDragEnd hook + AliasDialog |
| `bbd4540` | `refactor(ui)` | MainDisplay 拆分 + 修复 closeTab 生命周期 + 移除 setTimeout(0) |
| `ef32ce0` | `refactor(ui)` | styles.css 拆分为 11 个文件, 移除 20 个死 CSS class |

### 早期完成项

- **虚拟滚动** — commit `e0ec7ce`（`@tanstack/react-virtual` 替换 naive `lines.map`）
- **数据导出** — commit `4f1693e`（`save()` 文件对话框 + 新 Rust 命令 `export_terminal_log` 写盘，替代剪贴板方案）
- **日志功能完善** — 已实现自动分片、文件名变量解析、auto_save 短路
- **HEX 发送格式解析** — `parse_hex_string` 公共函数已就位
- **日志操作按钮** — 另存为/打开文件/打开目录全实现
- **前端测试基线** — commit `35169aa`（vitest 4.x + 15 个 useAppStore 单测，后扩展至 71 cases / 2 files）
- **标题栏窗口控制** — 最小化/最大化/关闭已绑定 Tauri API
- **串口参数完善** — `set_serial_params` 支持完整参数 (baud_rate + data_bits + parity + stop_bits + handshake)
- **窗口防休眠** — Win32 `SetThreadExecutionState` 已实现 (`system.rs`)
- **滚动锁定同步** — OperationPanel `opScrollLocked` 与 TerminalState 已同步
- **侧边栏 mock 分组清理** — 已改为仅在有真实端口时可选分组
