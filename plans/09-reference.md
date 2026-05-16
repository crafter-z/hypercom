# 快速参考

## 文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/types/index.ts` | 256 | 全局类型定义 |
| `src/stores/useAppStore.ts` | 580 | Zustand 状态管理 |
| `src/services/tauri.ts` | 285 | invoke 包装器 |
| `src/hooks/useTauri.ts` | 328 | React Hooks 桥接 |
| `src/utils/highlightEngine.ts` | 96 | 语法高亮引擎 |
| `src/styles.css` | 1427 | 全局样式 |
| `src/App.tsx` | 110 | 根组件 + 布局 |
| `src/components/shared/ContextMenu.tsx` | 104 | 通用右键菜单 |
| `src/components/TitleBar/TitleBar.tsx` | — | 标题栏 |
| `src/components/Sidebar/Sidebar.tsx` | 435 | 侧边栏 + 拖拽 |
| `src/components/MainDisplay/MainDisplay.tsx` | 226 | 分屏容器 |
| `src/components/MainDisplay/TabBar.tsx` | 177 | 标签栏 + 拖拽 |
| `src/components/MainDisplay/TerminalView.tsx` | 136 | 终端视图 + 高亮 |
| `src/components/OperationPanel/OperationPanel.tsx` | 410 | 操作面板 + 循环发送 |
| `src/components/StatusBar/StatusBar.tsx` | 64 | 状态栏 |
| `src/components/ConfigModal/ConfigModal.tsx` | 450 | 配置弹窗 + 规则编辑器 |
| `src-tauri/src/main.rs` | 6 | 程序入口 |
| `src-tauri/src/lib.rs` | 96 | 状态定义 + 命令注册 + setup |
| `src-tauri/src/commands/mod.rs` | 370 | 22 个 Tauri 命令 |
| `src-tauri/src/serial/mod.rs` | 450 | 串口管理器 |
| `src-tauri/src/config/mod.rs` | 139 | 配置管理 |
| `src-tauri/src/logger/mod.rs` | 184 | 日志管理 |
| `src-tauri/src/storage/mod.rs` | 530 | SQLite CRUD |

## 前端依赖

| 包 | 版本 | 用途 |
|----|------|------|
| react / react-dom | ^18.3.1 | UI 框架 |
| zustand | ^5.0.13 | 状态管理 |
| immer | ^11.1.6 | 不可变更新 |
| lucide-react | ^1.14.0 | 矢量图标 |
| @dnd-kit/core | ^6.3.1 | 拖拽核心 |
| @dnd-kit/sortable | ^10.0.0 | 可排序列表 |
| @dnd-kit/utilities | ^3.2.2 | 拖拽工具 |
| @tauri-apps/api | ^2.0.0 | Tauri 前端 API |
| @tauri-apps/plugin-dialog | ^2.7.1 | 文件对话框 |
| @tauri-apps/plugin-shell | ^2.0.0 | Shell/打开外部 |
| typescript | ^5.6.3 | 类型检查 |
| vite | ^5.4.10 | 构建工具 |

## 后端依赖

| Crate | 版本 | 用途 |
|-------|------|------|
| tauri | 2.11 | 桌面框架 |
| tauri-plugin-shell | 2 | Shell 插件 |
| tauri-plugin-dialog | 2 | 文件对话框 |
| serialport | 4 | 串口通信 |
| sqlx (sqlite) | 0.7 | 数据库 |
| sysinfo | 0.33 | 系统监控 |
| serde / serde_json | 1 | 序列化 |
| chrono | 0.4 | 时间处理 |
| tokio | 1 (full) | 异步运行时 |
| uuid | 1 (v4) | ID 生成 |
| dirs | 5 | 系统目录 |
| anyhow / thiserror | 1 | 错误处理 |
| log / env_logger | 0.4 / 0.11 | 日志 |

## 命名规范

| 上下文 | 风格 | 示例 |
|--------|------|------|
| 组件名 | PascalCase | `TerminalView`, `OperationPanel` |
| 变量/函数 | camelCase | `handleSend`, `activeTabId` |
| 类型/接口 | PascalCase | `SerialPort`, `AppConfig` |
| CSS class | kebab-case | `.port-item-name`, `.terminal-toolbar-title` |
| Rust 结构体 | PascalCase | `SerialManager`, `AppConfig` |
| Rust 函数/变量 | snake_case | `open_port`, `baud_rate` |
| Rust 模块 | snake_case | `serial`, `config` |
| 文件名 | PascalCase (组件), camelCase (工具) | `Sidebar.tsx`, `highlightEngine.ts` |

## 提交规范

```
type(scope): description

type: feat / fix / docs / style / refactor / perf / test / chore
scope: ui / backend / store / hooks / plans
```

示例：
- `feat(backend): add sysinfo crate for real CPU/memory monitoring`
- `fix(ui): prevent port status overwrite on periodic poll`
- `docs(plans): reorganize documentation into 9 files`

## 常用命令

```bash
npm run tauri dev          # 开发模式运行
npm run tauri build        # 生产构建
npx tsc --noEmit           # TypeScript 类型检查
cargo build                # Rust 编译 (在 src-tauri/ 下)
cargo check                # Rust 快速检查 (不生成二进制)
```
