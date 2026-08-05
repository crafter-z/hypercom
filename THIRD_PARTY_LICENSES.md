# 第三方开源许可证 (Third-party Licenses)

HyperCom 基于以下开源项目构建。本页列出各技术栈依赖及其开源许可证（SPDX 简称）。
完整许可证文本请见各项目仓库或 `node_modules/<包>/LICENSE*` / Cargo 依赖源码。

> issue #4-8：本文件随仓库维护，About 界面「开源许可证」按钮可查看精简版列表。

## 前端依赖 (Frontend)

| 包 | 版本 | 许可证 |
|----|------|--------|
| `react` / `react-dom` | ^18.3.1 | MIT |
| `typescript` | ^5.6.3 | Apache-2.0 |
| `vite` | ^5.4.10 | MIT |
| `vitest` | ^4.1.7 | MIT |
| `zustand` | ^5.0.13 | MIT |
| `immer` | ^11.1.6 | MIT |
| `@dnd-kit/core` / `sortable` / `utilities` | ^6.3.1 / ^10.0.0 / ^3.2.2 | MIT |
| `@tanstack/react-virtual` | ^3.13.15 | MIT |
| `@tauri-apps/api` | ^2.0.0 | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | ^2.7.1 | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-shell` | ^2.0.0 | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-updater` | ^2.10.1 | Apache-2.0 OR MIT |
| `@tauri-apps/cli` | ^2.0.0 | Apache-2.0 OR MIT |
| `i18next` | ^26.3.4 | MIT |
| `react-i18next` | ^17.0.8 | MIT |
| `lucide-react` | ^1.14.0 | ISC |
| `@playwright/test` | ^1.62.0 | Apache-2.0 |

## 后端依赖 (Backend / Rust crates)

| Crate | 版本 | 许可证 |
|-------|------|--------|
| `tauri` (v2) | 2.11 | Apache-2.0 OR MIT |
| `serialport` | 4 | MIT OR Apache-2.0 |
| `tokio` | 1 | MIT |
| `serde` / `serde_json` | 1 | MIT OR Apache-2.0 |
| `encoding_rs` | 0.8 | MIT OR Apache-2.0 |
| `chrono` | 0.4 | MIT OR Apache-2.0 |
| `dirs` | 5 | MIT OR Apache-2.0 |
| `uuid` | 1 | Apache-2.0 OR MIT |
| `thiserror` | 1 | MIT OR Apache-2.0 |
| `anyhow` | 1 | MIT OR Apache-2.0 |
| `log` | 0.4 | MIT OR Apache-2.0 |
| `env_logger` | 0.11 | MIT OR Apache-2.0 |
| `sysinfo` | 0.33 | MIT |

## 许可证说明

- **MIT**：允许使用、复制、修改、合并、出版、分发、再许可和/或出售副本，需保留版权与许可声明。
- **Apache-2.0**：允许商用与修改，需保留版权声明并标记修改；附专利授权；衍生作品可选用其他许可。
- **ISC**：与 MIT 类似的开源许可，允许自由使用与分发。
- **双许可（如 `MIT OR Apache-2.0`）**：可按任一许可条款使用。

本项目自身采用 **MIT License**（见 `README.md`）。

## 更新说明

升级依赖时请同步核对本表。新增依赖务必在合并前补充其许可证。