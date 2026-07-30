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
                          开发者在 GitHub 上编辑 release notes
                          点击 Publish → 用户可下载 / 自动更新
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
| `ubuntu-22.04` | `.deb` + `.AppImage` | 需 webkit2gtk 系统依赖 |
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

# 2. 提交
git add -A
git commit -m "chore: bump version to 0.x.0"

# 3. 打 tag
git tag v0.x.0

# 4. 推送（代码 + tag 一起推）
git push origin main --tags

# 5. 等待 GitHub Actions 完成（约 10-20 分钟）
#    在 https://github.com/crafter-z/hypercom/actions 查看进度

# 6. 去 Releases 页面，编辑 draft release 的 notes，点 Publish
```

## Updater 自动更新原理

1. 应用启动时，`tauri-plugin-updater` 请求 endpoint 获取 `latest.json`
2. 比较 `latest.json.version` 与当前 `app.version`
3. 有新版本 → 下载对应平台的 `.nsis.zip`（Windows）/ `.dmg`（macOS）/ `.AppImage`（Linux）
4. 用 `pubkey` 验证 `.sig` 签名 → 合法则提示用户更新
5. Windows 使用 `passive` 安装模式（显示进度条，无需用户交互）

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| workflow 未触发 | tag 格式不匹配 | 确保 tag 以 `v` 开头（`v0.1.0`，不是 `0.1.0`） |
| 构建失败 "signing key not found" | Secret 未配置 | 检查 `TAURI_SIGNING_PRIVATE_KEY` 是否添加 |
| updater 报 "Could not fetch update" | Release 未 Publish | draft release 不可被 updater 访问，必须 Publish |
| updater 签名验证失败 | 公钥/私钥不匹配 | 重新生成密钥对，更新 `tauri.conf.json` 的 `pubkey` |
| Linux 构建缺依赖 | webkit2gtk 版本 | workflow 已安装 `libwebkit2gtk-4.1-dev`，检查 Ubuntu 版本 |
| macOS 公证失败 | 未配置 Apple 证书 | 当前未做代码签名，macOS 用户需手动信任；后续见 `plans/code-signing.md` |

## 相关文件

| 文件 | 作用 |
|------|------|
| `.github/workflows/publish.yml` | CI/CD 工作流定义 |
| `src-tauri/tauri.conf.json` | bundle + updater 配置 |
| `src-tauri/Cargo.toml` | Rust 版本号 |
| `package.json` | 前端版本号 |
| `plans/code-signing.md` | 代码签名（Windows/macOS）规划 |
