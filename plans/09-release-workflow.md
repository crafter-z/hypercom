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
| `git push origin v0.x.0` | 推送匹配 `v*` 的 tag 即触发 |
| 手动 | GitHub → Actions → publish → Run workflow（未配置，如需可加 `workflow_dispatch`） |

## 构建矩阵

| Runner | 产物 | 备注 |
|--------|------|------|
| `windows-latest` | NSIS `.exe` + `.msi` + `.nsis.zip`（updater） | 主要分发平台 |
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

当前配置（`tauri.conf.json`）：

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

1. 应用启动时，`tauri-plugin-updater` 请求 endpoint 获取 `latest.json`
2. 比较 `latest.json.version` 与当前 `app.version`
3. 有新版本 → 下载对应平台的 `.nsis.zip`（Windows）/ `.dmg`（macOS）/ `.AppImage`（Linux）
4. 用 `pubkey` 验证 `.sig` 签名 → 合法则提示用户更新
5. Windows 使用 `passive` 安装模式（显示进度条，无需用户交互）

## Release notes 与 updater 弹窗文案（RELEASE_NOTES.md）

GitHub 网页上的 release 说明，和 updater 弹窗里显示的更新说明，**是两份独立内容**，但本工作流让它们来自同一个文件 `RELEASE_NOTES.md`，避免不一致。

机制：

- workflow 在构建前用 `read release notes` step 把 `RELEASE_NOTES.md` 读成 step output，传给 `tauri-action` 的 `releaseBody`。
- `tauri-action` 的 `releaseBody` **同时**驱动两处：① GitHub Release 的 body（网页 notes）；② 写入 `latest.json` 的 `notes` 字段（updater 弹窗文案）。
- 因此发版时**只需维护 `RELEASE_NOTES.md` 一个文件**，构建后网页 notes 与弹窗文案自动一致，Publish 时也无需再手动填 notes。

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

## 相关文件

| 文件 | 作用 |
|------|------|
| `.github/workflows/publish.yml` | CI/CD 工作流定义 |
| `RELEASE_NOTES.md` | 本次发版说明，构建时写入网页 notes 与 `latest.json.notes` |
| `src-tauri/tauri.conf.json` | bundle + updater 配置 |
| `src-tauri/Cargo.toml` | Rust 版本号 |
| `package.json` | 前端版本号 |
| `plans/code-signing.md` | 代码签名（Windows/macOS）规划 |
