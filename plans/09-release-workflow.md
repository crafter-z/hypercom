# 09 — Release Workflow（发版工作流）

> 最后更新：2026-07-30 · 适用版本：v0.1.0+

## 架构概览

```
开发者本地                          GitHub
─────────                          ──────
改版本号 (3 文件)
git commit
git tag v0.x.0
git push --tags  ──────────────►  tag push 事件
                                    │
                                    ▼
                          .github/workflows/publish.yml
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              windows-latest   ubuntu-22.04   macos-latest (×2 arch)
              tauri build      tauri build    tauri build
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
                          tauri-action 汇总产物
                          创建 GitHub Release (draft)
                          上传: .exe / .msi / .dmg / .AppImage
                                + .sig 签名文件
                                + latest.json (updater 清单)
                                    │
                                    ▼
                          开发者点击 Publish（notes 已在构建时
                          由 RELEASE_NOTES.md 写入，无需手填）
                          → 用户可下载 / 自动更新
```

## 触发方式

| 事件 | 说明 |
|------|------|
| `git push origin v0.x.0` | 推送匹配 `v*` 的 tag 即触发（issue #12：`v*-preview*` 经同过滤器 `!` 否定排除——GitHub Actions 禁止 tags 与 tags-ignore 同事件共存，由 preview 流负责） |
| `git push origin v0.x.y-preview.N` | **preview 流**（`.github/workflows/publish-preview.yml`）：每版独立唯一 tag，`prerelease: true`（详见 §Preview 发版） |
| 手动 | GitHub → Actions → publish → Run workflow（未配置，如需可加 `workflow_dispatch`） |

## Preview 发版（issue #12）

与 stable 完全同构的独立 release 流，唯一差异在 release 标记：

| 项 | stable（publish.yml） | preview（publish-preview.yml） |
|---|---|---|
| 触发 tag | `v*` + `!v*-preview*` 否定（同过滤器内，GitHub 禁止 tags 与 tags-ignore 共存） | `v*-preview*` |
| tag | `v0.6.0`（唯一） | `v0.6.0-preview.N`（**每版唯一，绝不复用**） |
| releaseDraft | true（Publish 后生效） | **false**（必须立即可见——GitHub API `/releases` 解析依赖它入列） |
| prerelease | false | **true**（从 `releases/latest` 排除 → stable 用户零污染；API 解析按此筛选） |
| updaterJsonPreferNsis | **true**（复审修复：tauri-action 默认 false → latest.json Windows 块指 MSI；更新链路按 NSIS `/UPDATE` passive 验收，必须显式优先 NSIS） | **true**（同款） |
| 版本号三处 | `0.6.0` | `0.6.0-preview.N` |

预览版本号约定：`0.x.y-preview.N` 属于「下一个核心」——目标 stable 0.6.0 → preview 依次
`0.6.0-preview.1/2/…`，stable 0.6.0 落地即收尾。semver 保证同核心下 preview < stable，
preview 用户发布后自动晋升 stable——该晋升由 **preview 通道双检查**实际兑现
（issue #12 二轮）：`check_for_update("preview")` 同查 preview 与 stable、取 semver
大者返回（`newer_channel`/`version_key` 纯函数），stable 发布后 preview 用户自动
收到晋升与后续 stable 热修，见 `plans/12-autoupdate.md` §2.2。

Preview 发版操作步骤（与 stable §发版操作步骤 同构）：

```bash
# 1. 三处版本写 0.x.y-preview.N（package.json / tauri.conf.json / Cargo.toml）
# 2. RELEASE_NOTES.md 顶部新章节 # HyperCom v0.x.y-preview.N（awk 前缀天然兼容）
# 3. git add -A && git commit && git tag v0.x.y-preview.N
# 4. git push origin main --tags  → publish-preview.yml 构建
# 5. release 已发布（非 draft），检查 /releases 中 prerelease 标记
```

> **为什么 preview release 必须 `prerelease: true` + 非 draft**：① `releases/latest`
> 语义排除 prerelease → stable 通道（共用 endpoint）永不泄漏 preview；② 前端
> `commands/update.rs` 的 GitHub API 解析只认 `prerelease && !draft` 的 release——
> draft 不在 `/releases` 列表中，preview 用户将永远查不到新 preview。

## 构建矩阵

| Runner | 产物 | 备注 |
|--------|------|------|
| `windows-latest` | NSIS `.exe` + `.msi`（含对应的 `.sig`，updater） | 主要分发平台；`createUpdaterArtifacts: true`（raw 安装包，非 zip） |
| `ubuntu-22.04` | `.deb` + `.AppImage` | 需 webkit2gtk + libudev 系统依赖 |
| `macos-latest` (aarch64) | `.dmg` | Apple Silicon |
| `macos-latest` (x86_64) | `.dmg` | Intel Mac |

`fail-fast: false` — 任一平台失败不阻断其他平台。

## 前置配置（一次性）

### 1. GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 中添加：

| Secret 名 | 值 | 来源 |
|-----------|---|------|
| `TAURI_SIGNING_PRIVATE_KEY` | updater 私钥内容（`.pem` 文件全文） | `tauri signer generate` 生成的私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（无密码则留空） | 生成时设定的密码 |

> `GITHUB_TOKEN` 由 GitHub Actions 自动注入，无需手动配置。

### 2. 密钥生成（如果还没有）

```bash
npx tauri signer generate -w ~/.tauri/hypercom.key
```

生成的公钥需写入 `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`（已完成）。

### 3. Updater Endpoint

`tauri.conf.json` 中的 endpoint 是 stable 通道（`releases/latest/download/latest.json`）——config 级兜底；运行时实际 endpoint 由 `commands/update.rs` 按通道选择（stable 直连上述 URL，preview 经 GitHub API 解析 tag），见 `plans/12-autoupdate.md` §2.2。

```json
"endpoints": [
  "https://github.com/crafter-z/hypercom/releases/latest/download/latest.json"
]
```

此 URL 由 GitHub Releases 自动托管，无需额外服务器。

## 发版操作步骤

```bash
# 1. 同步修改版本号（三处必须一致）
#    - package.json            → "version": "0.x.0"
#    - src-tauri/tauri.conf.json → "version": "0.x.0"
#    - src-tauri/Cargo.toml    → version = "0.x.0"

# 1b. 编辑 RELEASE_NOTES.md（本次更新说明）
#     它会同时成为 GitHub 网页 release notes 和 updater 弹窗文案

# 2. 提交
git add -A
git commit -m "chore: bump version to 0.x.0"

# 3. 打 tag
git tag v0.x.0

# 4. 推送（代码 + tag 一起推）
git push origin main --tags

# 5. 等待 GitHub Actions 完成（约 10-20 分钟）
#    在 https://github.com/crafter-z/hypercom/actions 查看进度

# 6. 去 Releases 页面，确认 notes（已自动来自 RELEASE_NOTES.md），点 Publish
#    无需再手动填 notes；直接 gh release edit v0.x.0 --draft=false 亦可
```

## Updater 自动更新原理

> 最终运行链路见 `plans/12-autoupdate.md`（本工作流只保证产物/清单/渠道正确，客户端行为由前端 `useAutoUpdate` + 后端 `commands/update.rs` 驱动）。要点：

1. 应用启动 config 就绪后（`ui.configReady` 信号，复审替代旧 3s 启发式窗口），前端评估自动更新（`updateCheckMode` 设置决定通道与开关，7 天周期）
2. 后端 `check_for_update` 请求该通道 endpoint 获取 `latest.json`（stable 直连 `releases/latest`，preview 经 GitHub API 解析最新 preview tag）
3. 比较 `latest.json.version` 与当前 `app.version`（semver `>`：同版本/降级不更新）
4. 有新版本 → 弹窗展示 changelog（`notes`）→ 用户点「立即更新」→ 下载**该平台安装包 + `.sig`**
5. 用 `pubkey` 验证 `.sig` 签名 → 合法才安装；Windows 使用 `passive` 安装模式（`/UPDATE`，显示进度条，无需用户交互）

## Release notes 与 updater 弹窗文案（RELEASE_NOTES.md）

GitHub 网页上的 release 说明，和 updater 弹窗里显示的更新说明，**是两份独立内容**，但本工作流让它们来自同一个文件 `RELEASE_NOTES.md`，避免不一致。

机制：

- workflow 在构建前用 `read release notes` step 提取 `RELEASE_NOTES.md` **顶部当前版本章节**（`awk '/^# HyperCom /{n++} n <= 1 {print} n > 1 {exit}'`，截至下一个 `# HyperCom v` 头为止）作为 step output，传给 `tauri-action` 的 `releaseBody`。
- `tauri-action` 的 `releaseBody` **同时**驱动两处：① GitHub Release 的 body（网页 notes）；② 写入 `latest.json` 的 `notes` 字段（updater 弹窗文案）。
- 因此发版时**只需维护 `RELEASE_NOTES.md` 一个文件**，构建后网页 notes 与弹窗文案自动一致，Publish 时也无需再手动填 notes。

> **release body / updater 弹窗 = 仅当前版本章节**（2026-08-09 起）。`RELEASE_NOTES.md` 是累积式——旧版本章节保留在文件里作为**历史归档**，但**不会**进入 release 描述与 updater 弹窗（此前 `cat` 全文件会把全部历史版本带进 body，0.5.1 及更早版本受影响）。如需把历史也带进 release 描述，改该 step 为 `cat RELEASE_NOTES.md` 即可。

注意点：

- `read release notes` step 显式声明 `shell: bash`。因为 matrix 含 `windows-latest`，其默认 shell 是 PowerShell，而读取多行 output 用的是 bash heredoc 写法，不指定会在 Windows runner 上失败。
- heredoc 用了独特分隔符 `RELEASE_NOTES_EOF`，避免与 notes 正文冲突；若正文里出现独占一行的该字符串会截断 output。
- `latest.json` 的 `notes` 在**构建时**就写死了，发布（Publish）后无法回改。所以 notes 必须在打 tag 前在 `RELEASE_NOTES.md` 里写好。

> 历史遗留：v0.1.0 是首个版本，构建时 `releaseBody` 还是占位句，故其 `latest.json.notes` 为占位句且已无法回改。**这无害**——没有任何更早版本的客户端会"更新到 0.1.0"，该字段永远不会被弹窗显示。从 v0.2.0 起本机制生效，弹窗文案将正确。

## Action 版本与 Node 弃用警告

workflow 使用 `actions/checkout@v5` 与 `actions/setup-node@v5`。

- 旧版 `@v4` 内部声明 `runs.using: node20`。GitHub 自 2025-09 弃用 Node 20，会在 Annotations 里报 `Node.js 20 is deprecated ... forced to run on Node.js 24` 警告。
- `@v5` 已声明 `node24`，警告消失。选 v5 而非更新的 v6/v7：v5 是首个脱离 node20 的稳定 major，生态验证充分，仅为消除警告不必追最新而承担 breaking change 风险。
- 该警告**纯提示**，不影响构建与产物；即便不升级，action 也会被强制跑在 Node 24 上。

> 升级 action major 前，可用 `gh api repos/<owner>/<repo>/contents/action.yml?ref=vN --jq .content`（base64 解码后看 `using:` 行）确认目标版本的 Node 运行时，避免臆测版本号。

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| workflow 未触发 | tag 格式不匹配 | 确保 tag 以 `v` 开头（`v0.1.0`，不是 `0.1.0`） |
| 构建失败 "signing key not found" | Secret 未配置 | 检查 `TAURI_SIGNING_PRIVATE_KEY` 是否添加 |
| updater 报 "Could not fetch update" | Release 未 Publish | draft release 不可被 updater 访问，必须 Publish |
| **Release 页面看不到安装包** | Release 还是 draft | draft 不进公开列表，asset 链接是临时 `untagged-*` ID（公开访问 404），`/latest/` 也不认 draft。Publish 后安装包公开、链接变 `v0.x.0`、updater 生效 |
| updater 签名验证失败 | 公钥/私钥不匹配 | 重新生成密钥对，更新 `tauri.conf.json` 的 `pubkey` |
| updater 弹窗更新说明是占位句 | `latest.json.notes` 由构建时 `releaseBody` 决定，旧版是占位句且发布后不可回改 | 0.1.0 无害（无更早版本更新到它）；0.2.0 起 `releaseBody` 读 `RELEASE_NOTES.md`，自动正确 |
| Linux 构建缺依赖 | 缺系统库 | workflow 已装 `libwebkit2gtk-4.1-dev`（Tauri）+ `libudev-dev`（`serialport` 枚举 `/dev/ttyUSB*`）；若仍报 `libudev-sys` 失败，确认 runner 为 ubuntu-22.04 |
| Annotations: `Node.js 20 is deprecated` | action 旧版本声明 node20 | 已升 checkout/setup-node 到 v5（node24）；纯警告，不影响产物 |
| macOS 公证失败 | 未配置 Apple 证书 | 当前未做代码签名，macOS 用户需手动信任；后续见 `plans/code-signing.md` |
| 矩阵部分失败（issue #12） | tauri-action 逐 job 覆盖 `latest.json`，`fail-fast: false` 下部分平台失败会生成**缺平台键**的清单 | manifest 反序列化先于版本比较——缺平台键会让该平台 `check()` 报错而非忽略（相对罕见但影响整通道）。issue #12 二轮起由 `verify-release` gate job 自动校验 latest.json 四平台键完整性（缺键即 workflow 红叉）：重跑失败 job / 补齐资产后重触发。preview 流失败**天然不影响** stable 通道（资产各自 release，共用 endpoint 只认 `releases/latest`） |
| RELEASE_NOTES 与版本不一致（issue #12 二轮） | 发版前忘加新版本章节 / 误留上一版章节 → awk 静默抓上一版 notes 写进 release 描述与 latest.json | workflow `verify release notes match version` step 显式 fail——核对 RELEASE_NOTES.md 顶部 `# HyperCom vX` 与 tauri.conf.json 版本一致 |
| verify-release FAILED（issue #12 二轮） | latest.json 缺平台键 / 缺 url / 缺 signature / version 不符 | 看 gate 输出的具体错误项；重跑失败的矩阵 job 或人工补齐 release 资产后重新触发 workflow |

## 发版 SOP（issue #12 二轮）

### macOS 与自动更新

macOS 构建照常发布（可手动下载安装），但**自动更新暂不支持**：未签名/公证的
`.app` 带 quarantine 属性会被 Gatekeeper 拦截，更新 relaunch 即失败。macOS 用户
更新路径 = 手动下载安装新版。启用自动更新的前置条件 = Apple Developer ID 签名
+ 公证（见 `plans/code-signing.md`）。`verify-release` gate 仍校验 darwin 键
（产物完整性），不代表 macOS 更新可用。

### 签名密钥轮换 SOP（TAURI_SIGNING_PRIVATE_KEY 泄漏/丢失）

updater **先验签名再安装**——直接换 pubkey 会让旧客户端对新签名的 release 验证
失败、无法更新，必须两步：

1. **过渡版本**：旧密钥仍有效时，发一个仅把 `tauri.conf.json` `pubkey` 改为新公钥
   的常规版本（仍用旧密钥签名）→ 旧客户端验签照常通过、升级到过渡版；
2. **切换**：过渡版覆盖装机面后，签名切新密钥（更新仓库 Secrets 的
   `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`），后续 release 用新密钥。

跳过过渡版的客户端无法再原地更新（验签失败），只能手动下载安装新版。

### 坏版本召回

- **preview**：直接删除该 release 与 tag → GitHub API 解析（`find_latest_preview_tag`）
  自动回落到上一个 preview；已装该版的客户端不受影响（无强制降级），下次检查
  自然收到新版本。
- **stable**：draft 审查期（`releaseDraft: true`）就是缓冲闸；一旦 Publish **不可
  召回**（已装客户端无法回滚），只能 ship-forward——修复后发布更高版本号。
  因此 Publish 前确认 `verify-release` gate 绿、各平台资产齐全。

## 相关文件

| 文件 | 作用 |
|------|------|
| `.github/workflows/publish.yml` | stable CI/CD 工作流定义（`v*` + `!v*-preview*` 否定过滤，issue #12；`updaterJsonPreferNsis: true`——latest.json Windows 块指向 NSIS；二轮：质量门 + notes↔版本校验 + `verify-release` gate） |
| `.github/workflows/publish-preview.yml` | preview CI/CD 工作流（唯一 tag + `prerelease: true`，issue #12；三轮护栏与 stable 同款） |
| `RELEASE_NOTES.md` | 本次发版说明，构建时写入网页 notes 与 `latest.json.notes` |
| `src-tauri/tauri.conf.json` | bundle + updater 配置 |
| `src-tauri/Cargo.toml` | Rust 版本号 |
| `package.json` | 前端版本号 |
| `plans/code-signing.md` | 代码签名（Windows/macOS）规划 |
