# 缺陷追踪

> 仅记录当前存在的未修复缺陷。已修复项移入变更历史。

## 未修复

| # | 级别 | 问题 | 文件 |
|---|------|------|------|
| 01 | P3 | 侧边栏初始化创建 mock 分组引用 COM3/COM4 等不存在的端口 | `Sidebar.tsx` |
| 02 | P3 | 循环发送依赖 `sendCommandSets` 数组引用变化，编辑命令集时会中断当前循环 | `OperationPanel.tsx` |
| 03 | P3 | TerminalView mock 时间戳在模块加载时求值固化 | `TerminalView.tsx` |
| 04 | P3 | OperationPanel 的"滚动锁定"与 TerminalState.scrollLocked 未同步 | `OperationPanel.tsx` |
| 05 | P2 | TabBar 右键"移动到分屏"父条目 onClick 为空实现 | `TabBar.tsx` |
| 06 | P3 | 操作面板折叠图标方向语义不清 (展开时箭头向上/向下) | `OperationPanel.tsx` |
| 07 | P3 | 全局 `user-select: none` 影响部分非终端区域的文字选择 | `styles.css` |
| 08 | P3 | 上下分屏 resize handle 方向逻辑问题 | `MainDisplay.tsx` |
| 09 | P3 | 空状态提示在分屏模式下不正确 | `MainDisplay.tsx` |

## 已修复 (最近)

| 日期 | 问题 | 修复 |
|------|------|------|
| 05-15 | 串口连接状态被 3s 轮询覆盖 | `mergePorts()` 保留已有状态 |
| 05-15 | openPort 硬编码参数忽略操作面板 | 从 Store 读取 op* 参数 |
| 05-15 | 终端无法滚动 | 移除中间非 flex 包裹层 + min-height:0 |
| 05-15 | 操作面板遮挡输出区 | .main-display 添加 min-height:0 |
| 05-15 | 内存显示整机而非进程 | get_system_status 改用 process.memory() |
| 05-15 | 状态栏始终显示"未选择串口" | 事件处理中累加 TX/RX 流量统计 |
| 05-11 | 17 项 P0/P1/P2 UI 缺陷 | 详见 git log |
