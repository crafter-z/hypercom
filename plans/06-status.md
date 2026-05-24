# 实现状态

> 按模块划分，✅ 已完成 | 🔄 部分完成 | ⏳ 未开始

## 前端

| 文件 | 状态 | 说明 |
|------|------|------|
| `types/index.ts` | ✅ | 全部类型定义 (256 行) |
| `stores/useAppStore.ts` | ✅ | Zustand + Immer, 55+ Actions, 完整 |
| `services/tauri.ts` | ✅ | 5 个服务模块, 含 storageService |
| `hooks/useTauri.ts` | ✅ | 7 个 Hooks, mergePorts 防覆盖 |
| `utils/highlightEngine.ts` | ✅ | 正则/关键词高亮引擎 |
| `styles.css` | ✅ | 暗色/亮色主题, 组件 class 体系 |
| `components/shared/ContextMenu.tsx` | ✅ | 通用右键菜单 |
| `components/TitleBar/TitleBar.tsx` | ✅ | 完整, 窗口按钮未绑定 API |
| `components/Sidebar/Sidebar.tsx` | ✅ | 含 @dnd-kit 拖拽, 搜索, 分组, 备注 |
| `components/MainDisplay/MainDisplay.tsx` | ✅ | 分屏 + Pane + ResizeHandle |
| `components/MainDisplay/TabBar.tsx` | ✅ | 含 @dnd-kit 水平拖拽, 右键菜单 |
| `components/MainDisplay/TerminalView.tsx` | ✅ | 真实数据 + 语法高亮 + `@tanstack/react-virtual` 虚拟滚动 + 真实文件导出 |
| `components/OperationPanel/OperationPanel.tsx` | ✅ | 手动发送 + 循环发送 + 参数自动下发 |
| `components/StatusBar/StatusBar.tsx` | ✅ | 进程内存/CPU + TX/RX 流量 + 时钟 |
| `components/ConfigModal/ConfigModal.tsx` | ✅ | 6 页: 含规则集/命令集完整编辑器 |
| `App.tsx` | ✅ | 布局编排 + useAppInit + ThemeProvider |

## 后端

| 文件 | 状态 | 说明 |
|------|------|------|
| `commands/mod.rs` | ✅ | 32 个命令（含 12 个日志命令、6 个 storage CRUD、`open_path`、`export_terminal_log`），sysinfo 缓存增量刷新 |
| `serial/mod.rs` | ✅ | 真实/模拟串口, 事件推送, 完整参数解析 |
| `config/mod.rs` | ✅ | JSON 持久化, 36 项配置 |
| `logger/mod.rs` | ✅ | 写入 / 分片续写 / 文件名变量 / auto_save 短路 / 多编码（UTF-8/GBK/ISO-8859-1）/ writer 反向索引 |
| `storage/mod.rs` | ✅ | 6 表 + 完整 CRUD, 延迟初始化 |
| `lib.rs` | ✅ | AppState（含 sysinfo 缓存）, 32 命令注册, CPU 预热 + 异步 DB 初始化 |
| `Cargo.toml` | ✅ | tauri 2.11, sysinfo, sqlx, serialport |
| `capabilities/default.json` | ✅ | 事件权限, shell:allow-open, dialog:allow-open/save, 6 个 window 控件权限 |

## 功能

| 功能 | 状态 |
|------|------|
| 串口枚举/连接/断开 | ✅ |
| 数据收发 (HEX/字符串/换行) | ✅ |
| 事件推送 (serial:data, serial:status) | ✅ |
| 模拟串口 SIM:Loopback | ✅ |
| 多标签页 + 分屏 | ✅ |
| 串口分组管理 | ✅ |
| 搜索过滤 | ✅ |
| 备注名设置 | ✅ |
| 拖拽排序 (侧边栏 + 标签页) | ✅ |
| 循环发送 (命令集 + 延时) | ✅ |
| 语法高亮 (正则/关键词/颜色/样式) | ✅ |
| 高亮规则集编辑器 (含数据库存取) | ✅ |
| 发送命令集编辑器 (含数据库存取) | ✅ |
| 6 页全局配置 | ✅ |
| 暗色/亮色/跟随系统主题 | ✅ |
| 系统资源监控 (进程 CPU/内存) | ✅ |
| 串口流量统计 (TX/RX 累加) | ✅ |
| 数据库 CRUD | ✅ |
| 日志分片续写 | ✅ |
| 日志文件名变量解析 | ✅ |
| 日志操作 (另存/打开/目录) | ✅ |
| 日志自动保存 (连接时启停) | ✅ |
| 标题栏窗口控制 | ✅ |
| HEX 发送格式解析 (含错误检测) | ✅ |
| 虚拟滚动 (`@tanstack/react-virtual`) | ✅ |
| 真实文件导出 (TXT/CSV via `save()` + Rust 写盘) | ✅ |
| 前端单元测试 (vitest, useAppStore 15 cases) | ✅ |
| 协议解析器 | ⏳ |
| 多语言支持 | ⏳ |
