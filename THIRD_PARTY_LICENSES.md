# 第三方开源许可证（Third-party Licenses）

本页是 HyperCom **直接依赖**的许可证索引，包含运行依赖、开发工具、构建依赖和平台专用依赖，不是完整的传递依赖清单，也不能代替分发所需的许可证全文和版权声明。应用「关于 → 开源许可证」只提供精简列表。

依赖声明分别以 [npm manifest](<package.json>) 和 [Cargo manifest](<src-tauri/Cargo.toml>)为准；实际解析版本以 [npm 锁文件](<package-lock.json>)和 [Cargo 锁文件](<src-tauri/Cargo.lock>)为准。本页不复制版本号，避免把依赖范围误当成安装版本。许可证表达式来自对应依赖的包元数据；完整文本及附加声明需从实际使用版本的发行包或源码中核对。

## 前端与开发工具（npm）

| 包 | SPDX 许可证表达式 |
| --- | --- |
| `react` / `react-dom` | MIT |
| `typescript` | Apache-2.0 |
| `vite` / `@vitejs/plugin-react` | MIT |
| `vitest` / `jsdom` | MIT |
| `zustand` / `immer` | MIT |
| `@dnd-kit/core` / `@dnd-kit/sortable` / `@dnd-kit/utilities` | MIT |
| `@tauri-apps/api` / `@tauri-apps/cli` | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` / `@tauri-apps/plugin-shell` / `@tauri-apps/plugin-process` / `@tauri-apps/plugin-clipboard-manager` | MIT OR Apache-2.0 |
| `@xterm/xterm` / `@xterm/addon-fit` | MIT |
| `i18next` / `react-i18next` | MIT |
| `lucide-react` | ISC |
| `@playwright/test` | Apache-2.0 |
| `@types/node` / `@types/react` / `@types/react-dom` | MIT |

## 后端与构建依赖（Rust crates）

| Crate | SPDX 许可证表达式 |
| --- | --- |
| `tauri` / `tauri-build` | Apache-2.0 OR MIT |
| `tauri-plugin-shell` / `tauri-plugin-dialog` / `tauri-plugin-updater` / `tauri-plugin-process` / `tauri-plugin-clipboard-manager` | Apache-2.0 OR MIT |
| `serialport` | MPL-2.0 |
| `portable-pty` | MIT |
| `tokio` | MIT |
| `serde` / `serde_json` | MIT OR Apache-2.0 |
| `encoding_rs` | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| `chrono` / `log` / `dirs` | MIT OR Apache-2.0 |
| `uuid` | Apache-2.0 OR MIT |
| `thiserror` / `anyhow` | MIT OR Apache-2.0 |
| `sysinfo` | MIT |
| `base64` / `reqwest` / `http` | MIT OR Apache-2.0 |
| `hyper-util` | MIT |
| `parking_lot` / `url` / `percent-encoding` / `sha2` / `regex` | MIT OR Apache-2.0 |
| `zip` | MIT |
| `libc`（Unix） | MIT OR Apache-2.0 |
| `wry`（Windows） | Apache-2.0 OR MIT |
| `webview2-com`（Windows） | MIT |
| `windows` / `windows-sys`（Windows） | MIT OR Apache-2.0 |
| `winreg`（Windows） | MIT |

## 阅读与维护

- `OR` 表示可按表达式中的任一许可使用；`AND` 表示相关许可条件须同时满足，不能当作二选一。
- MIT、Apache-2.0、ISC 和 BSD-3-Clause 等许可证有各自的声明保留要求；Apache-2.0 还可能涉及 NOTICE 与修改标记。MPL-2.0 有适用文件的源码提供等要求。应以实际许可证全文为准，不能仅凭本页简称判断分发义务。
- 新增、删除或升级依赖时同步核对本表，包括构建和平台依赖。完整分发清单还应纳入实际产物使用的传递依赖及其附加声明。
- 本项目自身的许可证声明见 [README](<README.md>)；这不改变第三方代码各自的许可证。
