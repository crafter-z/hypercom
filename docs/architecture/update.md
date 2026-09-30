# 自动更新模块

preview/stable 双通道自动更新（issue #12）。发版与签名见 [`release.md`](release.md)。

## 通道模型（v1.2 定稿）

**通道是运行时用户选择**（设置项 `updateCheckMode: 'none'|'stable'|'preview'`，`AppConfig` 字段，config.json 持久化，默认 stable；About 手动检查可选正式版/preview，不过 DEV 门控、也不受 `none` 限制）——不再是构建属性。因此更新检查必须经 **Rust 命令**承载（JS `check()` 无法在运行时指定 endpoint）。`tauri-plugin-updater` 2.10.x 的 JS 侧零使用（npm 包已卸载），链路全走 `commands/update.rs` 的 `check_for_update` / `download_and_install_update` 两个命令。

## 检查链路（commands/update.rs）

```
check_for_update(channel)                    # 入口：is_debug_build() → Ok(None)（见下「构建门控」）
  stable  → 单端点直连 https://github.com/crafter-z/hypercom/releases/latest/download/latest.json
            （GitHub 原生「最新非 prerelease」指针，永不泄漏 preview）
  preview → 双端点（preview 语义 = max(preview, stable)，见下）：preview_endpoint() + stable_endpoint() 各查一次
            preview_endpoint()：① GET api.github.com/repos/crafter-z/hypercom/releases?per_page=100
                                  （含 prerelease；未认证限流 60/h/IP，超限静默降级）
                                ② find_latest_preview_tag：取**版本号最大**的 tag——纯函数 is_preview_tag
                                  严格匹配 ^v\d+\.\d+\.\d+-preview\.\d+$ 过滤，parse_preview_tag 数值四元组
                                  做 max_by_key（API 按创建时间倒序：补发旧核心 preview 会乱序，取最大而非
                                  第一个命中）；非 draft + prerelease 才参与
                                ③ endpoint = releases/download/<tag>/latest.json（唯一 tag、preview→preview 自升级）
            newer_channel(preview.version, stable.version) → 按 version_key 取 semver 大者的通道
  → app.updater_builder().endpoints(vec![url])?.build()?.check().await
  → Ok(Option<UpdatePayload{ version, currentVersion, date, notes, channel }>)
```

**二轮修正（preview 语义 = max(preview, stable)）**：preview 收尾发布 stable 后只查 preview 端点的用户永远收不到晋升与后续 stable 热修——`check_for_update("preview")` 改为**双检查**：preview 与 stable endpoint 都查，纯函数 `version_key`（数值四元组，stable rank=u64::MAX 保证同核心 preview<stable）+ `newer_channel` 取 semver 大者；`payload.channel` 反映更新**实际来源**（徽标显示「正式版」，安装按该通道解析 endpoint）。preview 端点解析失败降级仅 stable；双通道一边失败另一边有更新则用有更新的一边。

**安装**：`download_and_install_update(channel, expected_version)`——重解析 endpoint → `update.download_and_install(|evt| emit "update:progress")`；Windows 插件 ShellExecuteW 拉起 NSIS（`/UPDATE`）后进程 exit(0)，installer 负责重启；macOS/Linux 安装完成后前端 `relaunch()`。

**复审加固**：
- `expected_version` 安装前重检查版本比对（防「展示 X 装 Y」TOCTOU——弹窗展示版本 X 后发布新版 Y，装的是 Y）；不一致报错拒绝安装。
- 未知 channel 报错（`unknown update channel: {other}`，不静默回退 stable）。
- GitHub API `GITHUB_API_TIMEOUT = 15s`（曾无超时——API 挂起时手动检查按钮永久「正在检查」）。
- **构建门控**：两条命令体只有一份实现（release 逻辑原地保留），入口由 `system_cmds::is_debug_build()` 短路——`check_for_update` 返回 `Ok(None)`、`download_and_install_update` 返回 `Ok(())`，保持开发期检查/安装按钮可用（E2E 可在 dev server 上 mock 驱动）。调试能力门控的**唯一实现**在 `commands/system_cmds.rs`（`dev_only()` / `is_debug_build()`）；命令体不得再写 `#[cfg(debug_assertions)]` 双主体，纯解析函数（`find_latest_preview_tag` / `version_key` 等）也不做条件编译——两种构建下都存在，测试直接覆盖。自动检查前端另有 `import.meta.env.DEV` 短路；**手动检查不过 DEV 门控**——显式用户意图，靠后端 `is_debug_build()` 兜底。

## 前端决策流

- `useAutoUpdate`（`hooks/useAutoUpdate.ts`，App.tsx 挂一次）：先过 `isUpdateCheckEnabled()`（DEV 构建与 macOS 直接不检查），再等 `ui.configReady` 信号（`useConfigPersistence.loadConfig` 完成置位，15s 兜底）后评估——复审替代旧 3s 启发式窗口（config 加载慢于 3s 会按默认模式误判）。**会话内每 6h 重评估**（setInterval，门控在 shouldAutoCheck，常驻挂机覆盖）。
- `shouldAutoCheck` 纯函数（`utils/updateService.ts`）：7 天周期 + snooze 暂停 + 首启立即；**成功完成检查（含无更新）才记 lastCheckAt（完成时刻）**，失败静默不重置——下次启动重试；**时钟回拨防护**（now < lastCheckAt 视为记账损坏放行）。
- localStorage 记账：`hypercom.update.lastCheckAt` / `hypercom.update.snoozeUntil`（`updateTiming` 读写，非法值解析为 null；per-install，不随配置导出）。
- `runCheck` 是自动/手动共用的检查入口（失败返回 `failed=true`，提示层级由调用方定）；`runAutoCheck` = 检查 + 成功记账，带模块级 in-flight 锁（改通道首检与 6h 周期并发不再双弹窗/双记账）；`manualCheck` bypass 周期/snooze、不过 DEV 门控、不记账。
- 改通道保存后：`ConfigModal.handleSave` 检测 mode 实际变化 → `updateTiming.clearLastCheck()+clearSnooze()`（旧通道周期会推迟新通道首检）+ mode 非 `none` 时立即 `runAutoCheck`；设置页（`GeneralSettings`）挂载时读 `updateTiming.getLastCheckAt()` 显示「上次自动检查」。
- 版本号约定：stable `0.x.y`、preview `0.x.y-preview.N`（属于下一核心，同核心 preview<stable 晋升自洽——semver 免费降级保护）。

## UpdateDialog

三动作：
- **立即更新**：`downloadAndInstall(candidate.channel, candidate.version)`（进度经 `update:progress` 事件 → 进度条）；下载中遮罩/X/按钮均不可关闭（曾遮罩可关——关闭后后端装完无预警 relaunch）。成功后 `clearSnooze()` + `relaunch()`（Windows 由 installer 重启，该调用无害）。
- **7 天后提醒**：`snoozeUntil = now + 7d`；关闭弹窗（X/遮罩）默认等同。
- **永不提醒**：`disableAutoCheck` → `setConfig({ updateCheckMode: 'none' })` + `saveConfig({ updateCheckMode: 'none' })`（只传该字段，实体数组由 `saveConfig` 内部的安全快照补齐）+ 关闭弹窗。

弹窗内容：通道徽标 + 版本 + 日期 + changelog + 「查看发布页」链接（`releaseUrl(version)`，tag 约定 `v<version>`）+ 进度 + 失败分支（**应用不退出**）。changelog 轻量 Markdown 渲染（`utils/changelog.ts`：heading/bullet/bold 纯函数解析，非 dangerouslySetInnerHTML）；通道徽标文案与发布页地址在 `utils/channel.ts`（`channelLabelKey` / `releaseUrl`；`UpdatePayload.channel` 由后端给出，前端不按版本号后缀猜通道）。

## 失败分类

- 自动检查 reject → 静默 + diagLog；手动检查 reject → toast；下载/签名验证失败 → toast 不退出。

## 关键事实备忘

1. **先导校验**：manifest 反序列化**先于**版本比较——`latest.json` 缺平台键（矩阵部分失败）会让 `check()` 直接报错而非忽略。
2. **同版本永不重装**：强行重推必须 bump 版本。
3. **`updaterJsonPreferNsis` 默认 false**：MSI+NSIS 并存默认 MSI 写进 latest.json；两条发版流均显式 `true`（NSIS passive `/UPDATE` 流程是验收路径）。
4. **endpoint 数组是 fallback 不是协商器**：第一有效 2XX 即定——每端点只喂一个 URL（通道协商由 `newer_channel` 在命令层完成，不靠 `endpoints` 数组）。
5. **DEV 短路（双层）**：前端 `import.meta.env.DEV`（`isUpdateCheckEnabled()`）+ 后端 `commands::system_cmds::is_debug_build()`——调试能力门控的唯一实现处（与 `dev_only()` 同文件），`update.rs` 命令体不再写 `#[cfg(debug_assertions)]` 双主体。
6. **更新检查只挂主窗** App.tsx；弹出窗不挂（沿用一次性纪律）。
7. **macOS 暂不支持自动更新**：未签名/公证的 .app 带 quarantine 属性会被 Gatekeeper 拦截，更新 relaunch 即失败。前端据此把 macOS 判为不可用——`isUpdateCheckEnabled()`（`!DEV && !isMacPlatform()`）不检查不弹窗，`AboutDialog` 也隐藏两个手动检查按钮。启用前置条件 = Apple Developer ID 签名 + 公证（尚未实施）。`verify-release` 仍校验 darwin 键（产物完整性），不代表 macOS 更新可用。

## 依赖

- Rust：`tauri-plugin-process`（relaunch）+ `reqwest 0.13(rustls) + url`（GitHub API）。`tauri-plugin-updater` 已注册（lib.rs）。
- 前端：`@tauri-apps/plugin-process`（`relaunch`）。
- capabilities：`process:default`（relaunch 必需）；`updater:default` 已移除（JS updater IPC 零使用）。
- 验证基线（2026-09-25）：tsc 0 错 · vitest 42 files / 652 用例 · cargo test --lib 178 用例 · playwright 23 用例。
