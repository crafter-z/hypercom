# 缺陷追踪

> 仅记录当前存在的未修复缺陷。已修复项移入变更历史。

## 未修复

*无。*

## 已修复 (最近)

| 日期 | 问题 | 修复 |
|------|------|------|
| 05-16 | 9 项 P2/P3 缺陷全部修复 | 详见下方 |
| 05-15 | 串口连接状态被 3s 轮询覆盖 | mergePorts() 保留已有状态 |
| 05-15 | openPort 硬编码参数忽略操作面板 | 从 Store 读取 op* 参数 |
| 05-15 | 终端无法滚动 | 移除中间非 flex 包裹层 + min-height:0 |
| 05-15 | 操作面板遮挡输出区 | .main-display 添加 min-height:0 |
| 05-15 | 内存显示整机而非进程 | get_system_status 改用 process.memory() |
| 05-15 | 状态栏始终显示"未选择串口" | 事件处理中累加 TX/RX 流量统计 |
| 05-11 | 17 项 P0/P1/P2 UI 缺陷 | 详见 git log |

### 2026-05-16: 9 项缺陷修复

| # | 问题 | 修复 |
|---|------|------|
| 01 | 侧边栏初始化创建 mock 分组引用不存在端口 | 移除 useEffect mock 分组创建 |
| 02 | 循环发送依赖 sendCommandSets 引用变化中断循环 | 从 deps 移除 sendCommandSets，改为 getState() 读取 |
| 03 | TerminalView mock 时间戳固化 | 改为 useMemo(() => generateMockLines(), []) |
| 04 | 滚动锁定与 TerminalState.scrollLocked 未同步 | 添加 useEffect 同步 opScrollLocked → setTerminalConfig |
| 05 | TabBar "移动到分屏" 父条目空 onClick | 移除父条目，改为 "移至分屏 xxx" 直接子条目 |
| 06 | 操作面板折叠图标方向语义不清 | collapsed→ChevronUp(展开), open→ChevronDown(收起) |
| 07 | 全局 user-select:none 影响文字选择 | 从 body 移除，仅 sidebar/titlebar 保留 |
| 08 | 上下分屏 resize handle 方向逻辑 | 根据 pane.direction 动态设置 flexDirection + cursor |
| 09 | 分屏模式空状态提示不正确 | 条件改为 `panes.length <= 1 && !tabs.length` |
