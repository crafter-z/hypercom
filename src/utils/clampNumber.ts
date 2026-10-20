/**
 * Numeric-input clamp helper (shared by ConfigModal pages).
 *
 * Clamp a raw input string to [min, max], falling back to `min` on NaN
 * (e.g. a cleared field). Extracted from 5 duplicated per-page copies.
 */
export function clampNumber(raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  const clamped = Math.max(min, Math.min(max, value));
  // Rust 配置字段是整数类型（u8/u32）；小数在 set_config 反序列化时会被拒收，
  // 因此在唯一的 clamp 入口收敛为整数，而不是让整份设置保存失败。
  return Math.round(clamped);
}
