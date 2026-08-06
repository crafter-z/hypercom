/**
 * Tests for the quick-send strip fit helper (issue #5-4).
 */
import { describe, it, expect } from 'vitest';
import { computeFitCount, OVERFLOW_BUTTON_ESTIMATE, type SendStripOptions } from './sendStrip';

// Layout constants matching the CSS strip: gap = var(--space-1) = 4px;
// panel button is an icon-only btn-sm (28px-ish measured, 32 estimated here).
const baseOpts: SendStripOptions = {
  panelButtonWidth: 32,
  gap: 4,
  minButtons: 1,
  maxButtons: 10,
};

describe('computeFitCount', () => {
  it('returns 0/0 for empty commands regardless of width', () => {
    expect(computeFitCount(300, [], baseOpts)).toEqual({ visibleCount: 0, overflowCount: 0 });
    expect(computeFitCount(0, [], baseOpts)).toEqual({ visibleCount: 0, overflowCount: 0 });
  });

  it('shows all commands when the container is wide enough', () => {
    // allFit = 32 + 4 + (40+60+50) + 2*4 = 194
    expect(computeFitCount(300, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 3, overflowCount: 0 });
  });

  it('shows all commands on an exact-fit container (inclusive boundary)', () => {
    expect(computeFitCount(194, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 3, overflowCount: 0 });
  });

  it('drops the last command one pixel past the exact fit', () => {
    // k=2 with overflow: 32 + 4 + (40+60) + 2*4 + 32 = 176; k=3 needs 230 > 193
    expect(computeFitCount(193, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 2, overflowCount: 1 });
  });

  it('counts overflow at the exact overflow boundary', () => {
    // k=1: 32 + 4 + 40 + 4 + 32 = 112; k=2: 176
    expect(computeFitCount(112, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 1, overflowCount: 2 });
    expect(computeFitCount(176, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 2, overflowCount: 1 });
  });

  it('lets all commands fit even when the last one is narrower than the overflow estimate', () => {
    // Non-monotonic corner: required(1) = 172 with overflow, but required(2) = 160 without.
    expect(computeFitCount(160, [100, 20], baseOpts)).toEqual({ visibleCount: 2, overflowCount: 0 });
    // One px less: 2 no longer fit; minButtons floor keeps at least 1.
    expect(computeFitCount(159, [100, 20], baseOpts)).toEqual({ visibleCount: 1, overflowCount: 1 });
  });

  it('returns 0 visible with full overflow when the panel button itself cannot fit', () => {
    expect(computeFitCount(20, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 0, overflowCount: 3 });
    expect(computeFitCount(31, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 0, overflowCount: 3 });
  });

  it('applies the minButtons floor on narrow-but-viable containers', () => {
    // k=0 needs 32 + 4 + 32 = 68 > 60 → raw 0; floor forces 1.
    expect(computeFitCount(60, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 1, overflowCount: 2 });
  });

  it('allows minButtons: 0 to show zero visible buttons', () => {
    const opts: SendStripOptions = { ...baseOpts, minButtons: 0 };
    expect(computeFitCount(60, [40, 60, 50], opts)).toEqual({ visibleCount: 0, overflowCount: 3 });
    expect(computeFitCount(68, [40, 60, 50], opts)).toEqual({ visibleCount: 0, overflowCount: 3 });
  });

  it('caps the visible slice at maxButtons and counts the rest as overflow', () => {
    const opts: SendStripOptions = { ...baseOpts, maxButtons: 2 };
    // All three actually fit (194 <= 300) but the cap hides the third.
    expect(computeFitCount(300, [40, 60, 50], opts)).toEqual({ visibleCount: 2, overflowCount: 1 });
  });

  it('lets maxButtons larger than the command count be ignored', () => {
    const opts: SendStripOptions = { ...baseOpts, maxButtons: 100 };
    expect(computeFitCount(300, [40, 60, 50], opts)).toEqual({ visibleCount: 3, overflowCount: 0 });
  });

  it('lets maxButtons: 0 win over the minButtons floor', () => {
    const opts: SendStripOptions = { ...baseOpts, maxButtons: 0 };
    expect(computeFitCount(300, [40, 60, 50], opts)).toEqual({ visibleCount: 0, overflowCount: 3 });
  });

  it('accounts for the gap after the panel button with a single command', () => {
    // allFit = 32 + 4 + 40 = 76
    expect(computeFitCount(76, [40], baseOpts)).toEqual({ visibleCount: 1, overflowCount: 0 });
    const noFloor: SendStripOptions = { ...baseOpts, minButtons: 0 };
    // 75 < 76 → k=0: 32 + 4 + 32 = 68 <= 75, k=1: 32+4+40+4+32 = 112 > 75
    expect(computeFitCount(75, [40], noFloor)).toEqual({ visibleCount: 0, overflowCount: 1 });
  });

  it('honors a custom overflowButtonWidth estimate', () => {
    const opts: SendStripOptions = { ...baseOpts, minButtons: 0, overflowButtonWidth: 50 };
    // k=1: 32 + 4 + 40 + 4 + 50 = 130 > 120 → only the panel fits.
    expect(computeFitCount(120, [40, 60], opts)).toEqual({ visibleCount: 0, overflowCount: 2 });
    // Default 32px estimate: 112 <= 120 → one command fits.
    expect(computeFitCount(120, [40, 60], baseOpts)).toEqual({ visibleCount: 1, overflowCount: 1 });
  });

  it('handles a panel-button-only container (panel fits, nothing else)', () => {
    // 34 >= panelButtonWidth 32, but k=0 needs 68.
    expect(computeFitCount(34, [40, 60, 50], baseOpts)).toEqual({ visibleCount: 1, overflowCount: 2 });
    const noFloor: SendStripOptions = { ...baseOpts, minButtons: 0 };
    expect(computeFitCount(34, [40, 60, 50], noFloor)).toEqual({ visibleCount: 0, overflowCount: 3 });
    // 68 = panel + gap + overflow exactly → still zero commands without floor.
    expect(computeFitCount(68, [40, 60, 50], noFloor)).toEqual({ visibleCount: 0, overflowCount: 3 });
  });

  it('exports a documented overflow-button estimate', () => {
    expect(OVERFLOW_BUTTON_ESTIMATE).toBe(32);
    // Default option resolves to the exported constant.
    expect(computeFitCount(112, [40, 60, 50], baseOpts).visibleCount).toBe(1);
  });
});
