# 12 — 自动更新（preview/stable 双通道 + 版本校验 + 更新日志）

> 状态：**方案 v1.2** · 2026-08-15
> 结论先行：`tauri-plugin-updater` 2.10.x（Rust/JS 依赖已装但前端零使用）· GitHub Releases 静态 `latest.json` 为源 · 版本比较全交给插件内置 semver `>`（免费降级保护）· 更新弹窗消费 `Update.body/date/rawJson`。
> **通道模型（v1.2，用户需求定稿）**：通道是**运行时用户选择**（设置项：不检查 / 定期到正式版 / 定期到 preview；About 手动检查可选通道）——不再是构建属性。因此更新检查必须经 **Rust 命令**承载（JS `check()` 无法运行时指定 endpoint）。preview 通道经 **GitHub API 解析最新 preview tag**（唯一 tag、只依赖 GitHub 服务，并解除 preview→preview 限制）。自动检查周期 **7 天**；发现更新弹窗三动作：立即更新 / 7 天后提醒 / 永不提醒（同步设置项）。
> 关联：`plans/09-release-workflow.md`（发版流程）· `plans/code-signing.md`（Authenticode 另列，与 updater 签名正交）。

---

## 0. 现状盘点（2026-08-15 实测）

### 已就位（直接复用，零改动）
| 项 | 位置 | 说明 |
|---|---|---|
| Rust 插件注册 | `src-tauri/src/lib.rs:135` | `tauri_plugin_updater::Builder::new().build()` |
| 前端依赖 | `package.json` `@tauri-apps/plugin-updater@^2.10.1` | **已装但全项目零引用** |
| updater 配置 | `src-tauri/tauri.conf.json` `plugins.updater` | pubkey ✅ · endpoint（stable 单点）✅ · `windows.installMode: passive` ✅ |
| 产物开关 | `bundle.createUpdaterArtifacts: true` | raw exe/msi + `.sig`（现代 v2 格式，无 zip） |
| 发版工作流 | `.github/workflows/publish.yml` | tag `v*` 触发 → 4 平台矩阵 → tauri-action 上传 release + `latest.json` |
| 更新日志源 | `RELEASE_NOTES.md` | 累积式 `# HyperCom vX.Y.Z` 分章节；workflow 已接 `releaseBody` → `latest.json.notes` |
| 版本号 | `package.json` / `tauri.conf.json` / `Cargo.toml` 三处 0.5.2 | 现有发版流程已处理三处同步 |

### 缺口（本方案要补的）
| 需求 | 现状问题 |
|---|---|
| 版本号校验 | 无任何 `check()` 调用；插件语义未被利用 |
| 通道分离 | 单 endpoint 且写死；无「运行时选择通道」能力 |
| 更新设置 | 无 `updateCheckMode` 设置项（config.json 无此字段） |
| 更新日志展示 | `notes` 已写入 `latest.json` 但无 UI 消费 |
| **权限（致命缺口）** | `capabilities/default.json` 缺 `updater:*` 和 `process:*` —— 运行时拒绝 |
| relaunch 依赖 | `@tauri-apps/plugin-process` / `tauri-plugin-process` 未装 |
| preview 指针 | 需要「最新 preview」解析（GitHub API，见 §2.2）→ 需新增 `reqwest` 依赖 |
| 手动更新入口 | About 对话框无更新按钮 |

---

## 1. 目标与非目标

### 目标
- **完整版本号校验**：链路依赖 semver 语义（升级判定/降级保护/同版本拒绝）。
- **preview 与 stable 分离**：用户设置选择检查通道；stable 用户永不被推荐 preview（除非主动改设置/手动选），preview 用户可跟进 preview 也可随更新到 stable。
- **分离检测**：运行时渠道判定（版本后缀解析 + 当前设置）。
- **关联 GitHub 源**：GitHub Releases（`latest.json` 静态清单）+ GitHub API（preview 指针解析），无自建服务器。
- **更新日志展示**：弹窗展示版本、发布日期、changelog（`Update.body` / `date` / `rawJson`）。
- **更新决策流**：7 天自动检查周期；发现更新弹窗三动作（立即更新 / 7 天后提醒 / 永不提醒→同步设置）。
- 网络异常静默降级：自动检查失败不发干扰性提示，仅诊断日志记录；手动检查失败才 toast。

### 非目标（本阶段）
- 动态更新服务器 / CrabNebula。
- Authenticode/公证（见 `plans/code-signing.md`；NSIS 未签会触发 SmartScreen 但不阻断更新）。
- 强制更新（`allowDowngrades` 通道：设计预留，不做 UI）。
- iOS/Android（Tauri updater 不支持 mobile）。

---

## 2. 核心设计原则

### 2.1 版本比较全交给插件（不重复造轮子）
插件 `Updater::check()` 默认判定为 `release.version > self.current_version`（semver crate 全语义）：

| 场景 | 插件行为 | 需要做 |
|---|---|---|
| 同版本 | `>` 为 false → 不更新 | 无需处理（免费） |
| stable 1.1.0 已装，manifest 1.1.0-preview.1 | **不更新**（降级保护免费） | 无需处理 |
| preview 2.0.0-alpha 已装，manifest stable 1.9.0 | 不更新（核心号更低） | 无需处理 |
| preview 1.1.0-preview.1 已装，manifest stable 1.1.0 | **更新**（晋升稳定版） | 无需处理 |
| build metadata 差异（1.0.0+a → 1.0.0+b） | 不更新（precedence 相等） | 无需处理 |

> **v2 无 `minVersion`/`force`**（v1 配置键）。强制手段只有：JS `check({ allowDowngrades: true })` 与 Rust `version_comparator`。本方案不用。

### 2.2 运行时通道选择 = Rust 命令承载（v1.2 定稿）
用户可在设置中选择通道、About 手动检查还可临时切换——通道是**运行时参数**。而 JS `check()` 的 `CheckOptions` **没有 endpoints 参数**（源码核实，只有 headers/timeout/proxy/target/allowDowngrades）→ 端点在 Rust `updater_builder().endpoints(vec![...])` 侧才能运行时指定。

**新增 `commands/update.rs`（注册进 lib.rs）**：
```text
check_for_update(channel: 'stable'|'preview')
    → 解析该通道 endpoint（见下）
    → app.updater_builder().endpoints(vec![url])?.build()?.check().await
    → Ok(Option<UpdatePayload>)  |  Err(CommandError)
    // UpdatePayload { version, currentVersion, date(RFC3339), notes, channel }

download_and_install(channel)
    → 重解析 endpoint → update.download_and_install(|evt| emit "update:progress" 事件)
    // Windows: 插件 ShellExecuteW 拉起 NSIS(/UPDATE) 后进程 exit(0)，installer 负责重启
    // macOS/Linux: 安装完成后前端 relaunch()
```

**endpoint 解析**：
```
stable  channel: https://github.com/crafter-z/hypercom/releases/latest/download/latest.json
                 （GitHub 原生「最新非 prerelease」指针，永不泄漏 preview）

preview channel: ① GET https://api.github.com/repos/crafter-z/hypercom/releases?per_page=100
                    （GitHub API 返回含 prerelease 的 release 列表，newest first）
                 ② 取第一个 !draft && prerelease && tag 匹配 ^v\d+\.\d+\.\d+-preview\.\d+$
                 ③ endpoint = https://github.com/crafter-z/hypercom/releases/download/<tag>/latest.json
```

- **解除 v1.1 限制**：preview 模式能发现「比已装 preview 更新的 preview」→ preview→preview 自动升级可用（唯一 tag 不变、仍只依赖 GitHub 服务）。
- 需新增 `reqwest`（Rust）依赖做 GitHub API 调用；插件自身 reqwest 不可复用（内部私有）。
- GitHub API 未认证限流 60 req/h/IP——7 天周期 + 手动检查用量极低；办公室 NAT 共享 IP 场景可接受，超限时静默降级为「无更新」。

### 2.3 更新设置与决策流（用户需求）
**设置项**（ConfigModal 通用设置页新增「自动更新」radio 组）：
```text
updateCheckMode: 'none' | 'stable' | 'preview'
  none     = 不自动检查更新
  stable   = 定期检查更新到正式版        ┐ 周期统一
  preview  = 定期检查更新到 preview 版    ┘ 7 天
```
- **持久化**：`updateCheckMode` → config.json（Rust `AppConfig` 新字段 + 前端 `defaultConfig` 镜像 + `set_config` 全量保存）；`lastCheckAt` / `snoozeUntil` → localStorage（per-install 记账，无需随配置导出）。
- **周期逻辑**（App 启动时评估）：`mode === 'none'` → 跳过；否则 `now >= max(lastCheckAt + 7d, snoozeUntil)` 才检查。**成功完成一次检查**（含"无更新"）才更新 `lastCheckAt`；网络失败不重置（下次启动重试）。
- **发现更新 → UpdateDialog**（通道徽标 + 版本 + 日期 + changelog + 三动作）：
  - **立即更新** → `download_and_install`（进度条）→ Windows installer 自重启 / 其他平台 `relaunch()`
  - **7天后再次提醒** → `snoozeUntil = now + 7d`
  - **不更新（永不提醒）** → **同步设置 `updateCheckMode = 'none'`**（写入 config.json）
  - 关闭弹窗（X/遮罩）默认等同「7 天后提醒」
- **手动检查**（About 对话框）：始终可用（不受 `none` 影响）；点「检查更新」先在弹层选 **正式版 / preview** → 走同一检查链路；结果 toast（已是最新 / 发现更新→弹窗 / 失败→错误提示）。
- 设置变更（改 mode）→ 清除 `snoozeUntil`（新意图生效）。

### 2.4 分离检测 = 版本后缀解析
```ts
// src/utils/channel.ts
export type ReleaseChannel = 'stable' | 'preview';
export function detectChannel(version: string): ReleaseChannel {
  return /-preview(\.|$|-)/.test(version) ? 'preview' : 'stable';
}
```
- 用于：About 显示当前构建通道徽标、更新设置项上下文提示、弹窗目标通道标识。
- **版本规范**：stable `0.x.y`；preview `0.x.y-preview.N`（preview.N 属于「下一个核心」；semver 保证同核心号下 preview < stable，晋升自洽）。

### 2.5 更新日志 = 既有 RELEASE_NOTES.md 管线零改动
workflow 已把 RELEASE_NOTES.md 顶部章节 → `releaseBody` → `latest.json.notes` → 插件 `Update.body`。弹窗消费：
- `Update.body` → changelog 正文
- `Update.date` → `pub_date`（RFC3339 → 本地化）
- `Update.rawJson` → 预留「打开 GitHub Release」链接（自定义字段）

preview workflow 同样走 releaseBody 机制，preview 通道检查到更新时弹窗展示 preview changelog。

> 无事件推送（v2 无 `update:available` event）——检查触发点：启动评估 + 手动按钮。

---

## 3. 里程碑

### M1 — 前端闭环（不依赖新 release 流即可验收核心逻辑）
| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| M1.1 | capabilities 加 `updater:default` + `process:default`；装 `@tauri-apps/plugin-process` + `tauri-plugin-process` + Rust `reqwest`（json + rustls） | `src-tauri/capabilities/default.json`、`Cargo.toml`、`package.json` | `cargo check` + `tsc` 通过；无 permission denied |
| M1.2 | `commands/update.rs`：`check_for_update` / `download_and_install` / `update:progress` 事件；stable endpoint 直连、preview 走 GitHub API 解析；`#[cfg(debug_assertions)]` 直接返回 Ok(None)（对齐 SIM 双层门控）；注册 lib.rs | 新 `src-tauri/src/commands/update.rs` + mod.rs + lib.rs | cargo build 通过；mock 测试 endpoint 解析纯函数 |
| M1.3 | 前端 utils：`channel.ts`（detectChannel）+ `updateService.ts`（check 三模式语义、lastCheckAt/snooze 记账、DEV 短路、手动检查 bypass） | 新 `src/utils/channel.ts`、`updateService.ts` | vitest：detectChannel 边界、周期/snooze 判定纯函数、DEV 短路 |
| M1.4 | `UpdateDialog.tsx`：通道徽标/版本/日期/changelog/三动作/进度条/失败分支（**应用不退出**） | 新 `src/components/shared/UpdateDialog.tsx` + `styles/update-dialog.css` | 三动作行为正确；进度实时；失败继续运行 |
| M1.5 | 设置项 `updateCheckMode`：Rust `AppConfig` 字段（serde default 见 §决策项 A）+ 前端 `defaultConfig` + ConfigModal 通用设置页 radio 组 | `config/mod.rs`、`useAppStore.ts`、`ConfigModal/pages/GeneralSettings.tsx` | 保存/重启恢复；改 mode 清 snooze |
| M1.6 | 触发点：App 启动自动检查（7 天周期 + snooze）；About 手动检查（先选 正式版/preview） | `App.tsx`、`AboutDialog.tsx` | 两路径都到弹窗；周期/提醒语义正确 |
| M1.7 | i18n `update.*` key 双语 | `src/i18n.ts` | 风格一致 |
| M1.8 | 验收：`tsc` + `cargo check` + `npm run test:run`；DEV 短路；mock 三分支单测 | — | 无新诊断错误 |

### M2 — 发版流（唯一 tag 双通道）
| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| M2.1 | 新 workflow `publish-preview.yml`：触发 `v*-preview*` → 复用 publish.yml 矩阵/依赖/notes 读取 → tauri-action `tagName: v__VERSION__`（**每版独立唯一 tag**）+ `releaseDraft: false` + `prerelease: true` | 新 `.github/workflows/publish-preview.yml` | dry-run：独立 release、tag 唯一、prerelease 标记、资产含各平台安装包 + `latest.json`（notes 正确） |
| M2.2 | 版本号三处同步改法 + `RELEASE_NOTES.md` 章节头规范（`# HyperCom vX.Y.Z-preview.N`，awk 前缀兼容）写入文档 | `plans/09-release-workflow.md` 增补、`RELEASE_NOTES.md` | 文档明确 preview 发版流程 |
| M2.3 | 双通道隔离验收：① preview 发版后 stable 通道 `releases/latest/download/latest.json` 不变；② preview 模式 check 经 API 解析出最新 preview tag → tag-pinned latest.json 正确 | — | 手动 curl 验证 |

### M3 — 打磨与健壮性
| # | 任务 | 验收 |
|---|---|---|
| M3.1 | 失败分类处理：自动检查 reject → 静默 + diagLog；手动检查 reject → toast；下载/签名验证失败 → toast 不退出 | 分类行为可测 |
| M3.2 | stable 自身矩阵部分失败会 corrupt 自身 `latest.json`（tauri-action 逐 job 覆盖）：文档警示入 `plans/09` 故障排查表；preview 矩阵失败天然不影响 stable（资产各自 release） | 文档 |
| M3.3 | 测试扩充：updateService mock（null/有更新/异常）、channel 全边界、endpoint 解析纯函数、snooze/period 判定 | vitest 通过 |
| M3.4 | E2E：Playwright mock `check_for_update` 弹窗冒烟（无真实网络） | `npx playwright test` 通过 |
| M3.5 | Windows 更新后自动重启验证：NSIS `/UPDATE` + AUTOLAUNCHAPP；若 E2E/人工发现不重启，补 `nsis` 配置 | 人工/自动化验证 |

---

## 4. 依赖引入

```bash
# Rust（src-tauri）
cargo add tauri-plugin-process --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'
cargo add reqwest --no-default-features --features json,rustls-tls
# 前端
npm install @tauri-apps/plugin-process
```

`tauri-plugin-updater` / `@tauri-apps/plugin-updater` 已就位。版本兼容：updater 2.10.x 基于 Tauri 2.10 workspace 构建，与项目 2.11.x 核心 semver 兼容；Rust ≥ 1.77.2 满足。

---

## 5. 关键事实备忘（源码核实，避免踩坑）

1. **先导校验**：manifest 反序列化**先于**版本比较——`latest.json` 缺平台键（矩阵部分失败）会让 `check()` 直接报错而非忽略。
2. **204 即停**：动态服务器 204 立刻停止 endpoint 循环（本项目静态 JSON 无此路径）。
3. **同版本永不重装**：强行重推必须 bump 版本。
4. **Windows 安装机制**：下载后先 `verify_signature`（篡改即中止）→ `ShellExecuteW` 拉起 NSIS（`/UPDATE`）→ 进程 `exit(0)` → installer 重启。**无应用内回滚**，失败保持旧版。
5. **`updaterJsonPreferNsis` 默认 false**：MSI+NSIS 并存默认 MSI 写进 `latest.json`；本方案设 `true`（NSIS passive 体验更好）。
6. **JS `check()` 无 endpoints 参数** → 通道选择必须 Rust 侧（§2.2 是本方案的架构基石）。
7. **DEV 短路**：前端 `import.meta.env.DEV` 短路 + Rust `#[cfg(debug_assertions)]` 返回 Ok(None)（双层门控，对齐 `simulation.rs` 纪律）。
8. **弹窗数据流**：`Update.body` / `date` / `rawJson`；JS `Update` 无 `downloadUrl`（仅 Rust 有），release 链接靠 rawJson 自定义字段。
9. **多 webview**：更新检查只挂主窗 `App.tsx`；弹出窗不挂（沿用一次性纪律）。
10. **GitHub API 限流**：未认证 60 req/h/IP；超限 → 静默降级无更新 + diagLog。
11. **endpoint 数组是 fallback 不是协商器**：第一有效 2XX 即定、版本不匹配不 fallthrough——本方案每通道只喂**一个** endpoint，天然规避。
12. **`std::process::exit(0)` 前 `relaunch()` 调用无害**（Windows 下进程已退出；macOS/Linux 走 relaunch）。

---

## 6. 相关文件

| 文件 | 作用 |
|---|---|
| `src-tauri/capabilities/default.json` | +`updater:default` +`process:default` |
| `src-tauri/src/commands/update.rs` + `mod.rs` + `lib.rs` | check/download 命令 + 注册（新） |
| `src-tauri/src/config/mod.rs` | `update_check_mode` 字段 + default + validate |
| `src/utils/channel.ts` | 通道检测纯函数（新） |
| `src/utils/updateService.ts` | 检查/周期/snooze/下载封装 + DEV 短路（新） |
| `src/components/shared/UpdateDialog.tsx` + `styles/update-dialog.css` | 更新弹窗（新） |
| `AboutDialog.tsx` / `App.tsx` | 手动检查（选通道）/ 启动自动检查 |
| `ConfigModal/pages/GeneralSettings.tsx` | 自动更新设置 radio 组 |
| `useAppStore.ts` | `defaultConfig` + `updateCheckMode` |
| `src/i18n.ts` | `update.*` key 双语 |
| `.github/workflows/publish-preview.yml` | preview 发版流（唯一 tag + prerelease） |
| `.github/workflows/publish.yml` | stable 发版流（零改动） |
| `plans/09-release-workflow.md` | 增补 preview 发版流程 + 故障排查 |
| `RELEASE_NOTES.md` | 版本章节（preview 后缀兼容 awk 提取） |

---

## 7. 验收清单（全部完成才算交付）

- [ ] `npx tsc --noEmit`、`cargo check --manifest-path src-tauri/Cargo.toml` 0 错误
- [ ] `npm run test:run`、`cargo test --lib` 通过（含 channel/updateService/endpoint 解析/snooze-period 新测试）
- [ ] DEV 环境：手动检查按钮可用、DEV 短路生效
- [ ] 设置项三态切换保存/重启恢复；改 mode 清 snooze
- [ ] 周期逻辑：lastCheckAt+7d / snoozeUntil 判定正确（单测 + 人工）
- [ ] 三动作行为：立即更新（进度+relaunch）、7 天提醒（snooze 落账）、永不提醒（mode→none 落 config）
- [ ] 手动检查：选正式版/preview 均正确；无更新提示；失败 toast
- [ ] `v0.x.y-preview.N` tag 实测 preview workflow → 独立 prerelease release、tag 唯一、资产齐全
- [ ] 双通道隔离：preview 发版后 stable `latest.json` 不变；preview 模式 API 解析正确
- [ ] 更新弹窗：版本/日期/changelog/进度/失败分支人工验证
- [ ] 降级保护实测：stable 安装包手动安装 preview 更高核心版本 → 不弹更新

---

## 8. 决策记录（已确认，2026-08-15）

| 决策项 | 结论 |
|---|---|
| 默认 `updateCheckMode` | **`stable`（定期检查到正式版）**——`AppConfig` serde default + 前端 `defaultConfig` |
| 首次启动（或从未成功检查过） | **启动后立即检查一次**，之后进入 7 天周期 |
| 检查周期 | 全部 7 天（不变量） |
| 永不再提醒 | 弹窗三动作之一 → 同步设置 `updateCheckMode='none'`（落 config.json） |
| 手动检查 | 不受 `none` 限制；检查时选择 正式版/preview |
| preview 指针 | GitHub API 解析（+reqwest）；超限静默降级 |
| DEV 门控 | 前端 `import.meta.env.DEV` 短路 + Rust `#[cfg(debug_assertions)]` 返回 Ok(None) |

---

## 9. 复审修复（2026-08-15，全部落地）

首轮实现复审（代码审查）发现的问题与修复对照，按严重度：

| # | 问题 | 修复 |
|---|------|------|
| 1 | **两条发版流未设 `updaterJsonPreferNsis`**——与 §5.5 决策矛盾：tauri-action 默认 false，MSI+NSIS 并存时 `latest.json` Windows 块指向 MSI，更新走 msiexec 路径而非本方案验收的 NSIS `/UPDATE` passive 路径 | publish.yml + publish-preview.yml 均显式 `updaterJsonPreferNsis: true` |
| 2 | **安装 TOCTOU**：§2.2「重解析 endpoint」设计使弹窗展示版本 X 后若发布新版 Y，`download_and_install` 装 Y | 安装命令加 `expected_version`：安装前重检查，版本不一致 → 拒绝安装报错（前端重新检查即可）；`downloadAndInstall(channel, expectedVersion)` 传 `candidate.version` |
| 3 | **下载中遮罩可关闭弹窗**：X/动作按钮 disabled 但遮罩 onClick 无守卫——关闭后后端装完无预警 relaunch | 遮罩 onClick 加 `downloading` 守卫 |
| 4 | **`clearSnooze()` 在 radio onChange 立即执行**：取消时配置回滚但副作用泄漏 | 挪到 `ConfigModal.handleSave` 保存边界（mode 实际变化才执行） |
| 5 | **`lastCheckAt` 不分通道**：切通道被旧通道 7 天周期推迟首检，「新意图立即生效」不成立 | 新 `updateTiming.clearLastCheck()`，改 mode 保存时与 snooze 一并清（回到首启立即语义） |
| 6 | **`useAutoUpdate` 3s 启发式窗口**：config 加载 >3s 按默认模式误判 | 新 `ui.configReady` 信号（`loadConfig` finally 置位），hook 订阅跳变后评估，15s 兜底 |
| 7 | **`find_latest_preview_tag` 取 API 顺序第一个**：GitHub `/releases` 创建时间序，补发旧核心 preview 漏最新 | `parse_preview_tag` 数值四元组取 `max_by_key`（+2 单测） |
| 8 | **`reqwest::Client::new()` 无超时**：API 挂起手动检查永久「正在检查」 | `GITHUB_API_TIMEOUT = 15s` |
| 9 | **未知 channel 静默回退 stable**（`_ =>`） | 报错 `unknown update channel: {other}` |
| 10 | 死代码：`channel.ts` `detectChannel`/`isPreviewVersion`（零生产引用）、i18n 4 键无消费者（×2 语言）、`@tauri-apps/plugin-updater` npm 零引用、`updater:default` capability 冗余、`.find()` 后死 `.filter(is_empty)`、`regex_matches_preview_tag` 名不副实 | 删函数/键/包/权限/死过滤；重命名 `is_preview_tag`；`channelLabelKey` 保留 |
| 11 | UpdateDialog 样式误落 config-modal.css（§M1.4 原定独立文件） | 迁 `src/styles/update-dialog.css` + @import |
| 12 | `markCheckedAt(now)` 用评估开始时刻 | 改记检查**完成**时刻 |

验证基线：`tsc --noEmit` 0 错 · `vitest` 587/587 · `cargo check` 0 错 0 警告 · `cargo test --lib` 136/136（Windows）。

> §2.4 备注：`detectChannel`/`isPreviewVersion` 已删——通道最终是运行时用户选择 +
> `UpdatePayload.channel` 携带，版本号后缀解析无消费方（后端 tag 校验由
> `update.rs` `is_preview_tag` 承担，语义更严格）。§6 文件表中
> `styles/update-dialog.css` 已按 M1.4 落地。