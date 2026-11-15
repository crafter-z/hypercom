# 参与 HyperCom 开发

HyperCom 的前端是 React / TypeScript / Vite，桌面宿主是 Rust / Tauri v2。用户安装和功能入口见 [README](<README.md>)；模块实现与复用入口见[架构索引](<docs/architecture/README.md>)。

## 准备环境

- Node.js 22（与 CI 保持一致）及 npm；使用锁文件安装依赖，不以重新生成锁文件代替排查安装问题。
- Rust stable；运行 Clippy 时需要对应组件。
- 当前平台的 Tauri 原生构建依赖：Windows 需要 Microsoft C++ Build Tools 与 WebView2，macOS 需要 Xcode Command Line Tools，Linux 需要 WebKitGTK 等系统开发包。安装方式见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/)，Linux CI 的具体包列表见[质量门工作流](<.github/workflows/ci.yml>)。

在仓库根目录执行：

```bash
npm ci
npm run tauri dev
```

`npm run dev` 只启动前端 Vite 服务，不能代替带真实串口与原生 API 的桌面应用。开发端口与产物路径分别以 [Vite 配置](<vite.config.ts>)、[Tauri 配置](<src-tauri/tauri.conf.json>)为准。

Windows PowerShell 如果拦截 `npm` 或 `npx` 脚本，可使用 `npm.cmd` / `npx.cmd`。项目的 [Tauri 启动脚本](<scripts/tauri.mjs>)在 Windows 上默认把 Cargo 产物放到 `%LOCALAPPDATA%/HyperComBuild/target`，已有 `CARGO_TARGET_DIR` 设置则优先使用，不要假定桌面产物总在仓库内。

## 验证改动

按受影响范围运行检查。CI 的完整步骤与平台矩阵以[质量门工作流](<.github/workflows/ci.yml>)为准，以下命令都从仓库根目录运行。

### 前端与工具

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.e2e.json
npm run test:run
node --test scripts/release.test.mjs
npm run build
```

`npm run build` 包含应用 TypeScript 检查与前端生产构建，不包含 Rust 编译或桌面打包。CI 还运行 `npm audit --audit-level=low --registry=https://registry.npmjs.org`。

### Rust

```bash
cargo test --lib --manifest-path src-tauri/Cargo.toml
cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo check --release --lib --manifest-path src-tauri/Cargo.toml
```

### 浏览器交互

首次运行前安装浏览器，然后执行：

```bash
npx playwright install chromium
npm run e2e
```

Linux 环境可能还需要 Playwright 的系统依赖；CI 使用 `npx playwright install --with-deps chromium`。测试启动方式见 [Playwright 配置](<playwright.config.ts>)。

Playwright 使用 mock IPC，只验证浏览器侧交互；通过这些测试不代表真实串口、原生 WebView 隔离、更新签名或安装包已验收。涉及这些边界时，按[发布与验证说明](<docs/architecture/release.md>)补充对应平台和原生验证，并在提交说明中写清未覆盖的范围。

## 文档与配置的维护边界

| 内容 | 维护入口 |
| --- | --- |
| 产品介绍、下载、第一次使用 | [README](<README.md>) |
| 开发环境、贡献与验证 | 本指南 |
| 用户操作与排查 | [用户手册](<docs/userwiki/README.md>) |
| 当前模块行为、跨模块约定与符号导航 | [架构索引](<docs/architecture/README.md>) |
| 插件作者接口、调试和打包 | [插件开发指南](<docs/plugin-development.md>) |
| 示例的安装和具体行为 | [基础插件示例](<examples/plugin-demo/README.md>)、[Sensor Workspace](<examples/plugin-views-demo/README.md>) |
| Agent 导航和硬规则 | [根级指南](<AGENTS.md>)及其列出的目录指南 |
| 面向用户的发行摘要 | [发行说明](<RELEASE_NOTES.md>) |
| 直接依赖的许可证索引 | [第三方许可证](<THIRD_PARTY_LICENSES.md>) |

- 文档描述当前有效行为与操作要求；不要新增评审报告、审计处置清单、历史设计或执行过程记录。发行说明保留版本历史，但不作为当前接口、依赖版本或测试数量的依据。
- 引用仓库文件时使用相对链接；引用实现使用文件与符号名，不固定源码行号。移动文件、重命名标题时检查所有入口和锚点，截图也要与说明同步。
- 共享约定和完整 API 放在各自维护入口，其他页面链接引用，避免复制长篇规则或易漂移的统计数字。
- npm 依赖范围与桌面脚本以 [package manifest](<package.json>)为准，Rust 依赖以 [Cargo manifest](<src-tauri/Cargo.toml>)为准，实际解析版本由各自锁文件决定。升级 Tauri 时同时核对两侧依赖与 IPC 兼容性；新增或升级依赖同步检查许可证。
- [发行脚本](<scripts/release.mjs>)读取发行说明中的首个 `# HyperCom v版本` 标题和该章节正文，并与应用配置、两个 manifest 及锁文件核对。保持这一格式；已有 draft 的正文也受一致性校验，不能在发布中途随意改写。

## 提交与反馈

提交说明写清改动目的、用户影响、已运行的验证及尚未覆盖的平台。提交格式与跨模块规则见[开发指南](<AGENTS.md>)。

问题反馈请包含系统、HyperCom 版本、最小复现步骤、预期与实际结果；日志、配置、截图和串口数据发出前先移除敏感内容。插件问题还应说明插件版本、所授权限与视图入口。
