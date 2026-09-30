/**
 * 数值设置边界的**前端唯一来源**。
 *
 * 后端同表在 `src-tauri/src/config/mod.rs` 的 `CONFIG_BOUNDS`（`validate_and_clamp`
 * 读它收敛落盘值）。两侧必须逐项相等，由 `src/utils/bounds.test.ts` 解析 Rust 源
 * 文本断言——曾经 `terminalFontSize` 前端允许 8..96 而后端 clamp 到 8..48，
 * 用户输入的值被静默丢弃（备份间隔 1..8760 vs 1..720 同款）。
 *
 * 新增数值设置时：此处加一行 + Rust `CONFIG_BOUNDS` 加一行，测试会强制两侧一致。
 */
export const CONFIG_BOUNDS = {
  terminalFontSize: [8, 48],
  uiFontSize: [8, 48],
  maxDisplayLines: [1000, 1_000_000],
  maxRetries: [1, 10],
  logSplitSizeMb: [1, 10_240],
  backupInterval: [1, 720],
  quickSendInlineCount: [0, 20],
  backgroundImageOpacity: [0, 100],
  backgroundImageBlur: [0, 64],
} as const satisfies Record<string, readonly [number, number]>;

export type BoundedNumericSetting = keyof typeof CONFIG_BOUNDS;
