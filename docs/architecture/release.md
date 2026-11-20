# 发版与构建

发版由 `.github/workflows/ci.yml`、`.github/workflows/publish.yml`、`.github/workflows/publish-preview.yml` 和 `.github/workflows/recover-preview.yml` 组成。客户端更新实现见 [`update.md`](update.md)。本页描述工作流契约和验收边界，不记录某次发布的操作过程。

## 质量门

`.github/workflows/ci.yml` 是分支 CI 和 stable/preview 发布流共用的 reusable workflow：

- `frontend` 使用 Node 22，执行 `npm ci`、低级别依赖审计、应用/Node 工具/e2e 三套 TypeScript 检查、`npm run test:run`、`node --test scripts/release.test.mjs` 和 `npm run build`。
- `rust` 在 Linux/Windows 矩阵执行 `npm run test:rust`、`npm run test:rust:runner`、`npm run test:cli`、Clippy（`-D warnings`）和 release-profile 的 `cargo check --release --lib --bin hypercom-cli`；Linux 安装 Tauri 所需系统依赖。CLI 验收用实际二进制连接 loopback Host 和假串口，并不验证发行包、驱动或双机。
- `e2e` 安装 Chromium 并运行 Playwright。测试注入 mock Tauri IPC，不证明真实串口、原生 WebView/CSP 或安装包行为。

发布流在创建 draft 前调用同一质量门。质量门失败时不会进入可发布状态。

## 稳定版与预览版

| 项 | stable | preview |
|---|---|---|
| 工作流 | `.github/workflows/publish.yml` | `.github/workflows/publish-preview.yml` |
| tag | `vX.Y.Z`，排除 `-preview` | `vX.Y.Z-preview.N` |
| Release | 先创建 draft；清单和签名验证通过后保持 draft，由维护者 Publish | 先创建 prerelease draft；清单和签名验证通过后自动 Publish |
| Windows | NSIS 与 MSI | 仅 NSIS（WiX 不接受预发布版本号） |
| 其它平台 | Linux x86_64、macOS aarch64、macOS x86_64 | 同一平台矩阵 |

`src-tauri/tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml`、两侧锁文件和 `RELEASE_NOTES.md` 的顶层版本必须与 tag 一致。`scripts/release.mjs` 的 `preflight` 负责版本、通道和首个 notes 章节校验。

## 资产、签名与清单

`tauri-apps/tauri-action@v1` 为每个矩阵项上传安装包和 updater 签名，矩阵不直接写 `latest.json`。`scripts/release.mjs` 的 `finalize`：

1. 校验 release 的 tag、通道、draft/prerelease 状态以及所有矩阵结果；
2. 检查平台安装包、版本、上传状态、签名配对和文件大小；
3. 使用 `src-tauri/tauri.conf.json` 的 updater 公钥验证 minisign `Ed`/`ED` 签名及 trusted comment；
4. 生成只引用 tag 的公开下载 URL，单次上传 `latest.json` 并回读校验版本、notes、平台键和 `pub_date`。

stable 的 `finalize` 不自动 Publish；preview 的 `finalize` 在门禁成功后 Publish。`.github/workflows/publish.yml` 的 `verify-release` 对已公开 stable 做只读复核，不替代发布前门禁。

`RELEASE_NOTES.md` 的首个版本章节同时成为 GitHub release body 和 `latest.json.notes`；后续章节保留在文件中，但不进入当前发布描述。

## Preview 恢复

`.github/workflows/recover-preview.yml` 只接受同仓库、tag 未移动、原 `publish-preview.yml` 已完成且仅 finalize 失败的运行。`scripts/release.mjs` 的 recovery 校验原构建结果、重新验签并发布完整清单；已发布 release 不复用或移动 tag。

## 自动更新与平台边界

- Windows 发布 NSIS/MSI 并带 updater 签名；Linux 发布 deb/AppImage；macOS 发布 aarch64/x86_64 安装包与 app archive。
- macOS 当前未启用自动更新，`verify-release` 仍可检查其清单资产完整性。
- updater 安装前必须验证签名；公钥变更需要兼容旧客户端的过渡版本，否则旧客户端无法原地更新。
- 自动化质量门、签名清单和 Windows 原生 smoke 不等于最终安装包验收。插件 Worker/CSP、原生隔离视图、文件选择器、权限和跨平台行为需在目标平台安装包上单独确认，边界见 [`plugins.md`](plugins.md) 与 [`plugin-views.md`](plugin-views.md)。

## 相关文件

| 文件 | 作用 |
|---|---|
| `.github/workflows/ci.yml` | 日常与发版共用质量门 |
| `.github/workflows/publish.yml` | stable draft、构建、签名清单和只读验证 |
| `.github/workflows/publish-preview.yml` | preview draft、构建、签名清单和自动发布 |
| `.github/workflows/recover-preview.yml` | 未发布 preview 的 finalize 恢复 |
| `scripts/release.mjs` / `scripts/release.test.mjs` | 版本预检、发布事务、签名和清单验证 |
| `RELEASE_NOTES.md` | 当前 release body 与 updater notes 来源 |
| `src-tauri/tauri.conf.json` | bundle 与 updater 公钥/endpoint/installMode |
| `package.json` / `src-tauri/Cargo.toml` | 前端/Rust 版本来源 |

(End of file)
