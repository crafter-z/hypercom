/**
 * Numeric-input clamp helper (shared by ConfigModal pages).
 *
 * Clamp a raw input string to [min, max], falling back to `min` on NaN
 * (e.g. a cleared field). Extracted from 5 duplicated per-page copies.
 */
export function clampNumber(raw: string, min: number, max: number): number {
  const value = Number(raw);
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
}
