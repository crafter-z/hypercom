/**
 * Tauri 后端命令调用层（barrel）。
 *
 * 实现按域拆在 `./serial` `./config` `./log` `./storage` `./popout` `./update`
 * `./system` `./diag` `./file` `./tool` `./event`；本文件只做重新导出——
 * `import { serialService } from '../services/tauri'` 这类既有路径与导出名不变。
 *
 * ## 参数约定（唯一一种写法，新增命令照此办理）
 *
 * 1. **service 方法的公开参数一律 camelCase**（`{ portId, baudRate, … }`），与 TS
 *    惯用法一致；顶层 invoke 参数同理——Tauri 把 camelCase 键映射到 Rust 的
 *    snake_case 形参（`{ portId }` → `fn cmd(port_id: String)`）。
 * 2. **结构体载荷**（`invoke(cmd, { args })`）由 service 在 invoke 处**显式**构造，
 *    字段名即 Rust 结构体字段名（`port_id` 等）——Rust 侧这些结构体没有
 *    `#[serde(rename_all)]`，wire 名就是字段名，camelCase 会反序列化失败。
 *    调用方永远不接触 snake_case。
 * 3. **后端 → 前端的载荷**（事件 payload、命令返回值类型）逐字段镜像 Rust 的 wire
 *    名（如 `SerialDataEvent.port_id`），不做转换——它们是别处的既有契约。
 *
 * 一句话：只有「前端 → 后端」的参数是 camelCase，其余都是 wire 原样。
 */
export * from './serial';
export * from './config';
export * from './log';
export * from './storage';
export * from './popout';
export * from './update';
export * from './system';
export * from './diag';
export * from './file';
export * from './tool';
export * from './event';
