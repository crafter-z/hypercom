# 发版与构建模块

GitHub Actions 日常质量门（`ci.yml`）+ 发布/updater 工作流（tag 触发构建、RELEASE_NOTES.md 统一 notes、签名、密钥轮换、故障排查）。客户端自动更新行为见 [`update.md`](update.md)。

## 架构概览

```
开发者本地                          GitHub
─────────                          ──────
改版本号（package.json / tauri.conf.json /
  Cargo.toml 三处手工 + Cargo.lock /
  package-lock.json 随之同步）+ RELEASE_NOTES.md 新章节
git commit
git push（分支）/ PR  ─────────►  ci.yml 日常质量门
                                    （frontend / rust / e2e）
git tag v0.x.0（stable）/ v0.x.y-preview.N（preview）
git push --tags  ──────────────►  tag push 事件
                                    │
                                    ▼
                publish.yml（stable） / publish-preview.yml（preview）
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              windows-latest   ubuntu-22.04   macos-latest (×2 arch)
                    └───────────────┼───────────────┘
                                    ▼
                          tauri-action 汇总产物
                          创建 GitHub Release
                          上传安装包 + .sig + latest.json
                                    ▼
                          （stable: 开发者 Publish draft；preview: 直接发布）
```

## 触发方式

| 事件 | 说明 |
|------|------|
| `push` tag 匹配 `v*`（如 `git push origin v0.x.0`） | stable 流 `publish.yml` 的**构建**触发；`v*-preview*` 经同过滤器 `!` 否定排除（GitHub Actions 禁止 tags 与 tags-ignore 同事件共存，由 preview 流负责） |
| `push` tag 匹配 `v*-preview*`（如 `git push origin v0.x.y-preview.N`） | **preview 流**（`publish-preview.yml`）：每版独立唯一 tag，`prerelease: true`。该流**仅**由此事件触发 |
| release **published** | `publish.yml` 的 `verify-release` 门禁触发（draft 资产任何身份都取不到，必须等 Publish 后资产公开才能校验 `latest.json`）。`publish-preview.yml` 的对应门禁**不**走此事件，而是 `needs: publish-preview-tauri` 在构建后同流程内执行（preview 非 draft，资产 push 后即公开） |
| `workflow_dispatch` | `publish.yml` 可手动重跑（构建 + 校验）；`publish-preview.yml` **未**开放手动触发 |

## Stable 与 Preview 流差异

| 项 | stable（publish.yml） | preview（publish-preview.yml） |
|---|---|---|
| 触发 tag | `v*` + `!v*-preview*` 否定 | `v*-preview*` |
| tag | `v0.6.0`（唯一） | `v0.6.0-preview.N`（**每版唯一，绝不复用**） |
| releaseDraft | true（Publish 后生效） | **false**（必须立即可见——GitHub API `/releases` 解析依赖它入列） |
| prerelease | false | **true**（从 `releases/latest` 排除 → stable 用户零污染；API 解析按此筛选） |
| Windows 产物 | NSIS `.exe` + `.msi`（`args: ''`，`targets: all`） | **仅 NSIS**（`args: '--bundles nsis'`；MSI/WiX 只接受数字版本，`0.x.y-preview.N` 的 pre-release 段非数字，bundler 直接拒绝打包——对更新链路零损失，`latest.json` Windows 块本就走 NSIS） |
| updaterJsonPreferNsis | **true**（复审修复：tauri-action 默认 false → latest.json Windows 块指 MSI；更新链路按 NSIS `/UPDATE` passive 验收） | **true**（同款） |

预览版本号约定：`0.x.y-preview.N` 属于「下一个核心」——目标 stable 0.6.0 → preview 依次 `0.6.0-preview.1/2/…`，stable 落地即收尾。semver 保证同核心下 preview < stable，preview 用户发布后自动晋升 stable（由 preview 通道双检查实际兑现，见 update.md）。

> **为什么 preview release 必须 `prerelease: true` + 非 draft**：① `releases/latest` 语义排除 prerelease → stable 通道（共用 endpoint）永不泄漏 preview；② 前端 update.rs 的 GitHub API 解析只认 `prerelease && !draft`——draft 不在 `/releases` 列表中，preview 用户将永远查不到新 preview。

## 构建矩阵

| Runner | 产物 | 备注 |
|--------|------|------|
| `windows-latest` | NSIS `.exe` + `.msi`（含对应 `.sig`，updater） | 主要分发平台；`createUpdaterArtifacts: true` |
| `ubuntu-22.04` | `.deb` + `.AppImage` | 需 webkit2gtk + libudev 系统依赖 |
| `macos-latest` (aarch64) | `.dmg` | Apple Silicon |
| `macos-latest` (x86_64) | `.dmg` | Intel Mac |

两条流共用同一 4 项矩阵（`fail-fast: false` — 任一平台失败不阻断其他平台）；preview 的 Windows 项改 `--bundles nsis`（见上表差异）。

## 日常质量门（ci.yml）

与发版流**同一套质量门**（`tsc` + vitest + `cargo test --lib`，步骤逐条对应，便于对照排查），但提前到每次 push / PR——发版门禁报红时 tag 已经打完，回滚代价高。此外 `ci.yml` 独有 `e2e` job（playwright）：两条发版流都不跑 e2e。

- **触发**：`push`（`branches: ['**']`，覆盖所有分支）、`pull_request`、`workflow_dispatch`。分支过滤而非裸 `push`：tag push 已由发版流自己的质量门（tsc + vitest + `cargo test --lib`）覆盖，CI 再跑一遍只是重复占 runner。
- **concurrency**：`group: ci-${{ github.workflow }}-${{ github.ref }}`；`cancel-in-progress` 仅对 `pull_request` 为真——同一 PR 的旧运行被新提交取代，分支 push 不取消（避免发布前门禁被中断）。
- **job `frontend`**（ubuntu-latest）：`npm ci` → `npx tsc --noEmit` → `npm run test:run`。
- **job `rust`**（ubuntu-latest）：装 `libwebkit2gtk-4.1-dev` / `libayatana-appindicator3-dev` / `librsvg2-dev` / `patchelf` / `xdg-utils` / `libudev-dev` → Rust stable + rust-cache → `npm ci`（tauri-build 在 test profile 下仍读 `tauri.conf.json`，前端依赖先就位）→ `cargo test --lib --manifest-path src-tauri/Cargo.toml`。`--lib` 在 Linux 上会执行 `#[cfg(not(target_os = "windows"))]` 的串口/TTY 测试，Windows 本地开发环境跑不到——把 Windows-only 之外的分支纳入回归是本 job 的目的。
  - 与发版流的**唯一依赖差异**：发版流跑 ubuntu-22.04 用 `libappindicator3-dev`，本 job 跑 ubuntu-latest（24.04）只能装继任者 `libayatana-appindicator3-dev`（`libappindicator-sys` 优先探测 `ayatana-appindicator3-0.1`，两者提供同一 pkg-config 依赖）。
- **job `e2e`**（ubuntu-latest）：`npx playwright install --with-deps chromium` → `npx playwright test`。e2e 用 mock IPC（`e2e/smoke.spec.ts` 注入 `window.__TAURI_INTERNALS__`），不需要 Rust 侧与 webkit2gtk；`playwright.config.ts` 的 `webServer` 自行拉起 vite dev server（1420），CI 下 `reuseExistingServer=false`。

## 发版操作步骤

```bash
# 1. 同步修改版本号（三处源文件手工改）
#    - package.json → "version": "0.x.0"
#    - src-tauri/tauri.conf.json → "version": "0.x.0"
#    - src-tauri/Cargo.toml → version = "0.x.0"
#    另有两处版本号随工具链同步：src-tauri/Cargo.lock（cargo 生成）与
#    package-lock.json（npm 生成）——发版前五处必须一致，否则发版 CI 的
#    notes↔版本校验与产物版本会对不上
# 1b. 编辑 RELEASE_NOTES.md：顶部新章节 # HyperCom vX（本次更新说明；
#     同时成为 GitHub 网页 release notes 和 updater 弹窗文案）
# 2. git add -A && git commit -m "chore: bump version to 0.x.0"
# 3. git tag v0.x.0（preview: git tag v0.x.y-preview.N）
# 4. git push origin main --tags
# 5. 等待 GitHub Actions 完成（约 10-20 分钟）
# 6. stable: 去 Releases 页面确认 notes（已自动来自 RELEASE_NOTES.md），点 Publish
#    （preview: publish-preview.yml 的 releaseDraft: false，无需 Publish，跳过此步）
```

## Release notes 与 updater 弹窗文案机制

GitHub 网页 release 说明与 updater 弹窗更新说明是**两份独立内容**，但本工作流让它们来自同一个文件 `RELEASE_NOTES.md`，避免不一致：

- workflow 构建前用 `read release notes` step 提取**顶部当前版本章节**（`awk '/^# HyperCom /{n++} n <= 1 {print} n > 1 {exit}'`，截至下一个 `# HyperCom v` 头为止）作为 step output，传给 tauri-action 的 `releaseBody`。
- `releaseBody` **同时**驱动：① GitHub Release 的 body；② `latest.json` 的 `notes` 字段（updater 弹窗文案）。
- `RELEASE_NOTES.md` 是累积式——旧版本章节保留为**历史归档**，不进入 release 描述与弹窗（0.5.1 及更早版本曾 `cat` 全文件受影响）。
- **章节↔版本校验**：两条发版流都在构建前跑 `verify release notes match version` step，比对 `RELEASE_NOTES.md` 顶部章节版本与 `tauri.conf.json` 版本，不一致显式 fail——防止忘加新章节时 `awk` 静默抓上一版 notes（preview 章节头 `# HyperCom vX.Y.Z-preview.N` 同样命中 `^# HyperCom ` 前缀）。

注意点：
- `read release notes` step 显式声明 `shell: bash`（matrix 含 windows-latest，默认 shell 是 PowerShell）。
- heredoc 分隔符 `RELEASE_NOTES_EOF` 需独特（正文出现独占一行的该字符串会截断 output）。
- `latest.json` 的 `notes` 在**构建时**写死，Publish 后无法回改——notes 必须在打 tag 前写好。
- 历史遗留：v0.1.0 的 notes 是占位句且不可回改——**无害**（无更早版本会更新到它）。

## Action 版本

`actions/checkout@v5` 与 `actions/setup-node@v5`（v4 声明 node20，GitHub 自 2025-09 弃用会报 `Node.js 20 is deprecated` 警告；v5 声明 node24，纯警告不影响产物；选 v5 而非 v6/v7 是「首个脱离 node20 的稳定 major」）。升级 major 前可用 `gh api repos/<owner>/<repo>/contents/action.yml?ref=vN --jq .content`（base64 解码看 `using:` 行）确认 Node 运行时。

其余动作（发版流与 `ci.yml` 一致）：`dtolnay/rust-toolchain@stable`、`swatinem/rust-cache@v2`（`workspaces: './src-tauri -> target'`）、`tauri-apps/tauri-action@v1`（仅发版流）。

## 发版 CI 三重护栏（issue #12 二轮）

两条流护栏内容同款（触发机制见下）：
1. **质量门**：tsc + vitest + `cargo test --lib` 前置于构建。
2. **notes↔版本校验**：RELEASE_NOTES 顶部章节 ↔ tauri.conf.json 版本不一致显式 fail（防忘加章节静默抓上一版 notes）。
3. **verify-release gate job**：`latest.json` 四平台键（windows-x86_64 / linux-x86_64 / darwin-aarch64 / darwin-x86_64）url+signature 完整性校验——矩阵部分失败（fail-fast:false 下 tauri-action 逐 job 覆盖 latest.json）的静默损坏变成显式红叉。

> 触发时点差异（实测）：stable 流的 `verify-release` 不能挂在 tag push 上——draft release 的资产任何身份都取不到（匿名 404、协作者 PAT 404、GITHUB_TOKEN 401），构建到 draft 阶段无法验证，必须等 release **published** 事件（发布后资产公开，匿名 curl 即可）或 `workflow_dispatch` 手动重跑。preview 流因 `releaseDraft: false`（资产 push 后立即公开），其 `verify-release` 直接 `needs: publish-preview-tauri` 在构建后同流程内执行，不依赖额外事件。

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| workflow 未触发 | tag 格式不匹配 | 确保 tag 以 `v` 开头 |
| 构建失败 "signing key not found" | Secret 未配置 | 检查 `TAURI_SIGNING_PRIVATE_KEY` |
| updater 报 "Could not fetch update" | Release 未 Publish | draft 不可被 updater 访问，必须 Publish |
| Release 页面看不到安装包 | Release 还是 draft | draft 不进公开列表，asset 链接是临时 `untagged-*` ID（公开 404），`/latest/` 不认 draft |
| updater 签名验证失败 | 公钥/私钥不匹配 | 重新生成密钥对，更新 tauri.conf.json 的 `pubkey` |
| updater 弹窗更新说明是占位句 | `latest.json.notes` 构建时由 releaseBody 决定 | 0.1.0 无害；0.2.0 起自动正确 |
| Linux 构建缺依赖 | 缺系统库 | workflow 已装 `libwebkit2gtk-4.1-dev` + `libudev-dev`；仍报 `libudev-sys` 失败则确认 runner 为 ubuntu-22.04 |
| macOS 公证失败 | 未配置 Apple 证书 | 当前未做代码签名，macOS 用户需手动信任 |
| 矩阵部分失败（issue #12） | tauri-action 逐 job 覆盖 latest.json → 缺平台键清单 | verify-release gate 自动校验四平台键；重跑失败 job / 补齐资产后重触发。preview 流失败**天然不影响** stable 通道（资产各自 release） |
| RELEASE_NOTES 与版本不一致 | 忘加/误留版本章节 → awk 静默抓上一版 notes | `verify release notes match version` step 显式 fail |
| verify-release FAILED | latest.json 缺平台键 / url / signature / version 不符 | 看 gate 输出具体错误项；重跑失败矩阵 job 或人工补齐资产 |

## macOS 与自动更新

macOS 构建照常发布（可手动下载安装），但**自动更新暂不支持**：未签名/公证的 `.app` 带 quarantine 属性会被 Gatekeeper 拦截，更新 relaunch 即失败。启用前置条件 = Apple Developer ID 签名 + 公证（尚未实施，属后续规划）。`verify-release` 仍校验 darwin 键（产物完整性），不代表 macOS 更新可用。

## 签名密钥轮换 SOP（TAURI_SIGNING_PRIVATE_KEY 泄漏/丢失）

updater **先验签名再安装**——直接换 pubkey 会让旧客户端对新签名的 release 验证失败、无法更新，必须两步：

1. **过渡版本**：旧密钥仍有效时，发一个仅把 `tauri.conf.json` `pubkey` 改为新公钥的常规版本（仍用旧密钥签名）→ 旧客户端验签照常通过、升级到过渡版；
2. **切换**：过渡版覆盖装机面后，签名切新密钥（更新仓库 Secrets 的 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`），后续 release 用新密钥。

跳过过渡版的客户端无法再原地更新（验签失败），只能手动下载安装新版。

## 坏版本召回

- **preview**：直接删除该 release 与 tag → GitHub API 解析自动回落到上一个 preview；已装该版的客户端不受影响（无强制降级），下次检查自然收到新版本。
- **stable**：draft 审查期（`releaseDraft: true`）就是缓冲闸；一旦 Publish **不可召回**（已装客户端无法回滚），只能 ship-forward——修复后发布更高版本号。因此 Publish 前确认 verify-release gate 绿、各平台资产齐全。

## 相关文件

| 文件 | 作用 |
|------|------|
| `.github/workflows/ci.yml` | 日常质量门（`push` 所有分支 / `pull_request` / `workflow_dispatch`；`frontend` + `rust` + `e2e` 三个 job，前两者与发版流同口径，`e2e` 为 ci 独有；tag push 不跑） |
| `.github/workflows/publish.yml` | stable CI/CD（`v*` + `!v*-preview*` 否定过滤；`updaterJsonPreferNsis: true`；三重护栏） |
| `.github/workflows/publish-preview.yml` | preview CI/CD（唯一 tag + `prerelease: true`；护栏内容同款，`verify-release` 以 `needs` 在构建后同流程内跑） |
| `RELEASE_NOTES.md` | 本次发版说明，构建时写入网页 notes 与 latest.json.notes |
| `src-tauri/tauri.conf.json` | bundle + updater 配置（pubkey / endpoint / installMode passive） |
| `src-tauri/Cargo.toml` / `package.json` | Rust / 前端版本号 |
