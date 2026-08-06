/**
 * Pure width-fit arithmetic for the quick-send inline strip (issue #5-4).
 *
 * Layout model (single row, no wrap):
 *   [panel button] gap [cmd₀] gap [cmd₁] … gap [cmdₖ₋₁] gap [overflow button?]
 *
 * - The panel button is always rendered (first slot, fixed width).
 * - `visibleCount` counts COMMAND buttons only (the panel button is excluded).
 * - The overflow button appears only when `buttonWidths.length > visibleCount`;
 *   its width is reserved in the fit math whenever overflow exists (fixed
 *   estimate, see {@link OVERFLOW_BUTTON_ESTIMATE}).
 *
 * The helper is DOM-free and deterministic: pure arithmetic over measured
 * widths, so it is unit-testable without a layout engine.
 */

export interface SendStripLayout {
  /** Number of COMMAND buttons that fit (excludes the panel button). */
  visibleCount: number;
  /** Number of commands that did not fit: `buttonWidths.length - visibleCount`. */
  overflowCount: number;
}

export interface SendStripOptions {
  /** Measured width of the always-visible panel button (px). */
  panelButtonWidth: number;
  /** Gap between consecutive items (px) — must match the CSS row gap. */
  gap: number;
  /**
   * Floor on `visibleCount` when commands exist and the panel button itself
   * fits (pass 0 to allow zero visible buttons on a very narrow strip).
   * Never exceeds the total command count.
   */
  minButtons: number;
  /** Cap on `visibleCount` (e.g. to bound the slice). */
  maxButtons: number;
  /**
   * Width reserved for the overflow button when overflow exists. Defaults to
   * {@link OVERFLOW_BUTTON_ESTIMATE}. Real width varies with the "+N" count,
   * so a fixed estimate is used; the strip clips at `overflow: hidden`.
   */
  overflowButtonWidth?: number;
}

/** Fixed estimate for the "⋯ +N" overflow button width (px). */
export const OVERFLOW_BUTTON_ESTIMATE = 32;

/**
 * Compute how many command buttons fit in `containerWidth`.
 *
 * Fit checks are inclusive (`required <= containerWidth`). The math is exact
 * for every candidate count: panel + gap after the panel + sum of command
 * widths + inter-command gaps + (gap + overflow button when overflow exists).
 *
 * Edge cases:
 * - Empty commands            → `{ visibleCount: 0, overflowCount: 0 }`.
 * - Container narrower than   → `{ visibleCount: 0, overflowCount: total }`
 *   the panel button alone      (minButtons does NOT apply — hopeless width).
 * - `maxButtons` caps the visible slice; the remainder still overflows.
 */
export function computeFitCount(
  containerWidth: number,
  buttonWidths: number[],
  options: SendStripOptions
): SendStripLayout {
  const total = buttonWidths.length;
  if (total === 0) return { visibleCount: 0, overflowCount: 0 };

  const {
    panelButtonWidth,
    gap,
    minButtons,
    maxButtons,
    overflowButtonWidth = OVERFLOW_BUTTON_ESTIMATE,
  } = options;

  // 面板按钮本身都放不下——没有任何命令按钮能显示（minButtons 下限不适用）。
  if (containerWidth < panelButtonWidth) {
    return { visibleCount: 0, overflowCount: total };
  }

  const cap = Math.min(total, Math.max(0, maxButtons));
  const prefix: number[] = [0];
  for (const w of buttonWidths) prefix.push(prefix[prefix.length - 1] + w);

  // 全部放下（无 overflow 按钮）：panel + gap + Σw + (total-1)·gap。
  // 只在 cap === total 时可能无 overflow，其余情况 overflow 按钮恒占位。
  if (cap === total) {
    const allFit = panelButtonWidth + gap + prefix[cap] + Math.max(cap - 1, 0) * gap;
    if (allFit <= containerWidth) {
      return { visibleCount: cap, overflowCount: 0 };
    }
  }

  // 带 overflow 按钮的前缀贪心：required(k) = panel + gap + Σw[0..k) + k·gap
  // + overflow（k=0 时为 panel + gap + overflow）。宽度非负 ⇒ 在 k ∈ [0, cap]
  // 上单调递增（k 与 k+1 同带 overflow），首个放不下的位置即最优。
  let visibleCount = 0;
  for (let k = 0; k <= cap; k++) {
    const required = panelButtonWidth + gap + prefix[k] + (k > 0 ? k * gap : 0) + overflowButtonWidth;
    if (required <= containerWidth) {
      visibleCount = k;
    } else {
      break;
    }
  }

  // minButtons 下限：仅当面板按钮放得下时生效，且不超总命令数与 maxButtons 上限。
  if (visibleCount < minButtons) {
    visibleCount = Math.min(minButtons, total, cap);
  }

  return { visibleCount, overflowCount: total - visibleCount };
}
