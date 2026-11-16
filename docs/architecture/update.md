# 自动更新模块

preview/stable 双通道自动更新。发版与签名见 [`release.md`](release.md)。

## 通道模型（v1.2 定稿）

**通道是运行时用户选择**（设置项 `updateCheckMode: 'none'|'stable'|'preview'`，`AppConfig` 字段，config.json 持久化，默认 stable；About 手动检查可选正式版/preview，不过 DEV 门控、也不受 `none` 限制）——不再是构建属性。因此更新检查必须经 **Rust 命令**承载（JS `check()` 无法在运行时指定 endpoint）。`tauri-plugin-updater` 2.10.x 的 JS 侧零使用（npm 包已卸载），链路全走 `commands/update.rs` 的 `check_for_update` / `download_and_install_update` 两个命令。

## 检查链路（commands/update.rs）

```
check_for_update(channel)                    # 入口：is_debug_build() → Ok(None)（见下「构建门控」）
  stable  → 单端点直连 https://github.com/crafter-z/hypercom/releases/latest/download/latest.json
            （GitHub 原生「最新非 prerelease」指针，永不泄漏 preview）
  preview → 双端点（preview 语义 = max(preview, stable)，见下）：preview_endpoint() + stable_endpoint() 各查一次
            preview_endpoint()：① GET api.github.com/repos/crafter-z/hypercom/releases?per_page=100
                                  （含 prerelease；未认证限流 60/h/IP。无 preview release 视为「无更新」继续查
                                  stable；其它 API 失败（含 403 限流）按双通道合并规则处理——stable 有更新
                                  则采用 stable，否则错误上抛。自动检查静默、手动检查 toast）
                                ② find_latest_preview_tag：取**版本号最大**的 tag——纯函数 is_preview_tag
                                  严格匹配 ^v\d+\.\d+\.\d+-preview\.\d+$ 过滤，parse_preview_tag 数值四元组
                                  做 max_by_key（API 按创建时间倒序：补发旧核心 preview 会乱序，取最大而非
                                  第一个命中）；非 draft + prerelease 才参与
                                ③ endpoint = releases/download/<tag>/latest.json（唯一 tag、preview→preview 自升级）
            newer_channel(preview.version, stable.version) → 按 version_key 取 semver 大者的通道
  → app.updater_builder().endpoints(vec![url])?.build()?.check().await
  → Ok(Option<UpdatePayload{ version, currentVersion, date, notes, channel }>)
```

**二轮修正（preview 语义 = max(preview, stable)）**：preview 收尾发布 stable 后只查 preview 端点的用户永远收不到晋升与后续 stable 热修——`check_for_update("preview")` 改为**双检查**：preview 与 stable endpoint 都查，纯函数 `version_key`（数值四元组，stable rank=u64::MAX 保证同核心 preview<stable）+ `newer_channel` 取 semver 大者；`payload.channel` 反映更新**实际来源**（徽标显示「正式版」，安装按该通道解析 endpoint）。双通道合并规则：一边失败另一边**有更新**则用有更新的一边；两边都失败则透出 preview 侧错误；preview 端点解析失败且 stable 无更新时错误上抛（不回退成「无更新」）。

**安装**：`download_and_install_update(channel, expected_version)` 重解析 endpoint 并核对版本 → `update.download`（累计 `update:progress.downloaded`，返回前验签）→ 发 `install` 阶段 → `update.install`。Windows 由插件拉起 NSIS 安装器（`tauri.conf.json` 的 `plugins.updater.windows.installMode: passive`）后进程退出，安装器负责重启；Linux 安装完成后前端 `relaunch()`。macOS 仍禁用自动更新。

**复审加固**：
- `expected_version` 安装前重检查版本比对（防「展示 X 装 Y」TOCTOU——弹窗展示版本 X 后发布新版 Y，装的是 Y）；不一致报错拒绝安装。
- 未知 channel 报错（`unknown update channel: {other}`，不静默回退 stable）。
- `UpdateNetwork`：API/清单请求总期限 15s、连接期限 10s；下载空闲读取期限 30s、总期限 15min。插件不继承 builder timeout 到下载对象，因此安装命令显式设置 `Update.timeout`。
- **构建门控**：两条命令体只有一份实现（release 逻辑原地保留），入口由 `system_cmds::is_debug_build()` 短路——`check_for_update` 返回 `Ok(None)`、`download_and_install_update` 返回 `Ok(())`，保持开发期检查/安装按钮可用（E2E 可在 dev server 上 mock 驱动）。调试能力门控的**唯一实现**在 `commands/system_cmds.rs`（`dev_only()` / `is_debug_build()`）；命令体不得再写 `#[cfg(debug_assertions)]` 双主体，纯解析函数（`find_latest_preview_tag` / `version_key` 等）也不做条件编译——两种构建下都存在，测试直接覆盖。自动检查前端另有 `import.meta.env.DEV` 短路；**手动检查不过 DEV 门控**——显式用户意图，靠后端 `is_debug_build()` 兜底。

## 系统代理与网络边界

- `src-tauri/src/update_network.rs` 是升级专用客户端策略，API、清单、下载共用；TLS 证书/主机名验证保持启用，HTTPS 重定向不得降级到 HTTP。
- Windows `update_network/windows.rs` 读取当前活动用户 WinINet 配置；手动代理支持单地址、`http=...;https=...` 与 SOCKS，绕过支持 Windows 通配符、端口及 `<local>`。
- 明确的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 优先于对应系统代理；`NO_PROXY` 使用环境变量域名/IP规则。不向客户端内置 GitHub Token。
- PAC/WPAD 通过 `WinHttpGetProxyForUrlEx` 按完整初始/重定向 URL 解析，10s 等待上限、关闭异步 resolver 取消。整数上下文注册表避免迟到回调访问已释放内存。尊重 Windows 对 HTTPS PAC URL 的隐私限制。
- PAC 列表按顺序消费、跳过不支持协议；多代理列表用有界 TCP 可达性探测选择首个可连接代理，只有列表明确含 DIRECT 才可直连。代理已可连接但拒绝认证/握手时仍报错，不承诺应用层认证故障的自动备用切换。
- reqwest 自定义代理回调只有 origin，因此每次请求前准备路由、重定向前重新解析，并禁用 Windows 升级客户端空闲连接复用，避免旧连接绕过新路由。每个检查/安装创建独立策略实例。
- 自动解析失败时可使用已配置手动代理；仅 WPAD 未发现且无手动/PAC配置时直连。显式 PAC 失败且无手动代理时报错，不静默绕开。
- 非 Windows 保持 reqwest 平台/环境策略；Linux 桌面代理须通过环境变量提供。企业集成认证代理不是当前 reqwest 的自动登录能力。
- 新发布清单只包含 tag-pinned 公开下载 URL，不再把安装包下载放在匿名 REST API 配额内；preview 发现仍受 GitHub API 配额限制，按既有双通道规则降级。


## 前端决策流

- `useAutoUpdate`（`hooks/useAutoUpdate.ts`，App.tsx 挂一次）：先等 `ui.configReady` 信号（`useConfigPersistence.loadConfig` 成功或失败后均置位）后评估；软件更新过 `isUpdateCheckEnabled()`（DEV 构建与 macOS 不检查软件更新），插件更新走独立门控与 `runPluginAutoCheck`，两者并行（见「插件更新联动」）。没有超时抢跑：慢启动期间不能用默认 stable 覆盖尚未加载的持久化 none/preview；就绪后立即按已提交模式检查。**会话内每 6h 重评估**（setInterval，门控在 `shouldAutoCheck` / `shouldCheckPluginUpdates`，常驻挂机覆盖）。
- `shouldAutoCheck`：先检查 `none` 与有效 snooze，再判断首启、时钟回拨与 7 天周期；即使自动检查账为空，手动检查后的延期也生效。仅当前意图下成功完成的自动检查记 `lastCheckAt`。
- localStorage 记账：`hypercom.update.lastCheckAt` / `hypercom.update.snoozeUntil`（`updateTiming` 读写，非法值解析为 null；per-install，不随配置导出）。
- `utils/updateService.ts` 的 `getCommittedUpdateMode` / `commitUpdateMode` 管理已提交模式，与设置页 `useAppStore.config` 草稿分离。加载/成功保存使旧 generation 失效，取消设置不会触发升级副作用。
- `runAutoCheck()` 读取已提交模式，同 generation 去重；切新通道可在旧检查未完成时启动，旧结果不发布、不记账。`manualCheck(channel)` 绕过周期/none/DEV，推进发布意图使更早自动结果失效，并走同一发布守卫；失效结果返回 `discarded`。
- 成功保存改变模式才清除 `lastCheckAt` / snooze；`ConfigModal.handleSave` 在模式变化且新模式非 `none` 时关闭设置后立即 `runAutoCheck()`。设置页显示最后成功自动检查时间。
- 版本号约定：stable `0.x.y`、preview `0.x.y-preview.N`（属于下一核心，同核心 preview<stable 晋升自洽——semver 免费降级保护）。

## 插件更新联动

软件更新与插件市场更新共享同一自动检查时机，但插件更新只做通知：不自动安装、不回写配置。插件侧逻辑集中在 `src/utils/pluginUpdateService.ts`，记账与软件更新分离；`useAutoUpdate` 在 `ui.configReady` 后并行评估 `runAutoCheck`（软件）与 `runPluginAutoCheck`（插件），会话内每 6h 重评估。`updateCheckMode === 'none'` 时两者都不自动检查；DEV 构建下 `isPluginUpdateCheckEnabled()` 关闭自动插件检查（手动显式检查可绕过）；macOS 不支持软件自动更新，但插件检查不排除 macOS，`isUpdateCheckEnabled()` 为 false 时插件仍按自身门控执行。

- **触发与周期**：自动插件检查周期为 7 天（`PLUGIN_UPDATE_CHECK_PERIOD_MS`），`shouldCheckPluginUpdates(mode, now, lastCheckAt)` 判定是否到期：`none` 永不、无记录或时钟回拨立即、距上次成功 ≥7 天。`runPluginAutoCheck` 只在成功完成实际检查后 `markCheckedAt`；`runPluginManualCheck` 表示显式用户意图，绕过 DEV/模式/周期，但仍要求非空市场源，且不写 `lastCheckAt`。
- **独立记账**：localStorage 键 `hypercom.pluginUpdate.lastCheckAt` / `hypercom.pluginUpdate.notified` 由 `pluginUpdateTiming` 读写（复用 `updateService` 的 `parseStoredTs`，非法值按 null）；`notified` 保存已提示过的更新指纹，不随配置导出。
- **只提示已安装插件的可用更新**：`availablePluginUpdates` 只保留 `updateAvailable === true` 且 `currentVersion` 非空的条目，未安装的市场插件不产生提示。`pluginUpdateFingerprint` 对排序后的 `id@latestVersion` 拼串去重：同一批更新只提示一次，安装或版本变化使指纹改变后再次提示；没有可用更新时清除 `notified`。提示经 `useToastStore.push` 投递粘性（`durationMs: 0`）info 通知，携带 `action: 'open-plugin-settings'`，标题与正文使用 `update.pluginUpdatesTitle` 和 `update.pluginUpdatesAvailable`（多于 3 条用 `update.pluginUpdatesAvailableMore`，只列前 3 个名字加“等”）；名称取 `manifest.name` 回退 id。`pushPlugin` 的输入类型不暴露 `action`，插件通知不能伪造该跳转。
- **通知入口**：`Toast`（`ToastContainer` 的粘性 toast）与 `NotificationCenter` 的通知行都识别 `action === 'open-plugin-settings'`，提供 button 语义（Enter/Space 可触发）。点击 toast 会移除该提示并打开“设置 → 插件”；通知中心行点击会关闭通知中心并打开同一页面（`configActiveTab: 'plugins'` 与 `toggleConfigModal`），标题用 `notify.openPluginSettings`；关闭按钮 `stopPropagation`，原有按 `portId` 打开串口标签的行为保留，普通 toast 仍为不可点击的 `alert`。
- **手动联动与失败分类**：`AboutDialog` 手动检查软件更新时并行发起 `void runPluginManualCheck()`，不阻塞软件更新的候选弹窗或“已是最新”提示；设置页市场手动检查（`usePluginMarketplace` → `checkPluginUpdates`）仍保留。插件检查失败只 `console.debug` 静默记录，不抛异常、不弹 toast，也不影响软件更新结果。
- **已提交市场源**：`pluginUpdateService` 维护模块级已提交源（`getCommittedPluginMarketplaceUrl()` / `commitPluginMarketplaceUrl(url, {resetTiming?})`）；配置加载成功前尚未初始化时回退读取 `useAppStore` 的 `config.pluginMarketplaceUrl`。后台检查以已提交值为准，设置草稿不会改变已提交源。`useConfigPersistence.loadConfig` 成功应用迁移配置后提交当前源；`saveConfig` 成功提交后若源变化则提交并 `resetTiming`（清 `lastCheckAt` 与 `notified`，新源立即重新检查），更新模式变化也清插件记账与已通知指纹。`ConfigModal.handleSave` 在模式变化且新模式非 `none` 时追加 `void runPluginAutoCheck()`；`GeneralSettings.tsx` 在更新模式下方以 `update.pluginCheckHint` 说明联动。

## UpdateDialog

三动作：
- **立即更新**：`beginUpdateInstall()` 快照候选并置 `ui.isUpdateInstalling`；参数、版本、通道及日志不受迟到检查覆盖。下载/安装中遮罩、X、决策按钮不可关闭。先等 `requestEditorLeave()` 关闭审批通过（未通过则直接收尾、不发起安装）。失败 `finishUpdateInstall()` 恢复原候选供重试，不重启；成功清 snooze 并重启。
- **7 天后提醒**：`dismissUpdate()` 统一处理按钮、X、遮罩，写 `snoozeUntil = now + 7d` 并使在途结果失效；安装中不执行。
- **永不提醒**：`saveConfig({ updateCheckMode: 'none' }, true)` 在新鲜后端快照上仅补该字段并 CAS 保存，保留其他设置草稿和实体。成功才提交模式/更新内存/关闭；失败保持原模式及弹窗，可重试。

弹窗内容：通道徽标、冻结候选版本、日期、changelog、发布页链接、累计下载进度与错误。下载/验签失败不退出；Windows 插件安装器启动失败的原生退出/重启边界仍需真实发行环境验证。changelog 以 React 文本节点渲染，不使用 dangerouslySetInnerHTML。

## 失败分类

- 自动检查 reject → 静默 + diagLog；手动检查 reject → toast；下载/签名验证失败 → toast 不退出。
- 插件更新检查 reject → 静默 `console.debug` 诊断，不弹 toast、不记账，也不影响软件更新结果；手动检查软件更新时并行发起的插件检查同样静默。

## 关键事实备忘

1. **先导校验**：manifest 反序列化**先于**版本比较——`latest.json` 缺平台键（矩阵部分失败）会让 `check()` 直接报错而非忽略。
2. **同版本永不重装**：强行重推必须 bump 版本。
3. **清单由唯一发布汇总生成**：`scripts/release.mjs` 明确令 Windows 默认键选择 NSIS，并保留 `-nsis` / `-msi` 等 installer-specific 键；矩阵 `uploadUpdaterJson: false`，不并行读改写 latest.json。
4. **endpoint 数组是 fallback 不是协商器**：第一有效 2XX 即定——每端点只喂一个 URL（通道协商由 `newer_channel` 在命令层完成，不靠 `endpoints` 数组）。
5. **DEV 短路（双层）**：前端 `import.meta.env.DEV`（`isUpdateCheckEnabled()`）+ 后端 `commands::system_cmds::is_debug_build()`——调试能力门控的唯一实现处（与 `dev_only()` 同文件），`update.rs` 命令体不再写 `#[cfg(debug_assertions)]` 双主体；插件自动检查由 `isPluginUpdateCheckEnabled()` 按同一 DEV 事实关闭，手动显式检查可绕过。
6. **更新检查只挂主窗** App.tsx；弹出窗不挂（沿用一次性纪律）。
7. **macOS 暂不支持自动更新**：未签名/公证的 .app 带 quarantine 属性会被 Gatekeeper 拦截，更新 relaunch 即失败。前端据此把 macOS 判为不可用——`isUpdateCheckEnabled()`（`!DEV && !isMacPlatform()`）不检查不弹窗，`AboutDialog` 也隐藏两个手动检查按钮。启用前置条件 = Apple Developer ID 签名 + 公证（尚未实施）。`verify-release` 仍校验 darwin 键（产物完整性），不代表 macOS 更新可用。该平台判断只关闭软件更新；插件更新检查不排除 macOS，仍会按周期提示已安装插件的可用更新（见「插件更新联动」）。

## 依赖

- Rust：`tauri-plugin-updater ~2.10.1`（配置 reqwest 客户端接口需锁 minor）+ `reqwest 0.13`（rustls / system-proxy / socks）+ Windows WinHTTP 接口；`tauri-plugin-process` 负责 Linux relaunch。
- 前端：`@tauri-apps/plugin-process`（`relaunch`）；当前前端工具链为 Vite 8 / Vitest 5，CI 固定 Node 22。
- capabilities：`process:default`（relaunch 必需）；`updater:default` 已移除（JS updater IPC 零使用）。
- 升级回归覆盖已提交通道失效、空账 snooze、保存失败重试、候选冻结、原生 PAC 路由与取消；测试数量以实际运行输出为准。
