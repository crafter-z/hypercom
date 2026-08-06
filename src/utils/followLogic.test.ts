import { describe, it, expect } from 'vitest';
import {
  isAtBottom,
  computePinTarget,
  becameLocked,
  shouldFollow,
  FOLLOW_TOLERANCE,
} from './followLogic';

describe('isAtBottom', () => {
  it('is true when the viewport sits flush at the bottom', () => {
    // scrollTop + clientHeight === scrollHeight
    expect(isAtBottom(700, 300, 1000)).toBe(true);
  });

  it('is true when the residual gap is smaller than the tolerance', () => {
    expect(isAtBottom(651, 300, 1000)).toBe(true); // gap 49 < 50
    expect(isAtBottom(699, 300, 1000)).toBe(true); // gap 1 < 50
  });

  it('is true exactly at the tolerance boundary', () => {
    // scrollTop + clientHeight === scrollHeight - 50
    expect(isAtBottom(650, 300, 1000)).toBe(true);
  });

  it('is false beyond the tolerance', () => {
    expect(isAtBottom(649, 300, 1000)).toBe(false); // gap 51 > 50
    expect(isAtBottom(0, 300, 1000)).toBe(false);
  });

  it('honors a custom tolerance parameter', () => {
    expect(isAtBottom(895, 100, 1000, 5)).toBe(true); // gap 5 == tolerance
    expect(isAtBottom(894, 100, 1000, 5)).toBe(false); // gap 6 > tolerance
    expect(isAtBottom(0, 100, 1000, 0)).toBe(false); // zero tolerance: only flush counts
    expect(isAtBottom(900, 100, 1000, 0)).toBe(true);
  });

  it('exposes the default tolerance as a named constant', () => {
    expect(FOLLOW_TOLERANCE).toBe(50);
  });
});

describe('computePinTarget', () => {
  it('pins to the delta when content overflows the viewport', () => {
    expect(computePinTarget(1000, 300)).toBe(700);
    expect(computePinTarget(500, 200)).toBe(300);
  });

  it('returns 0 when content fits exactly', () => {
    expect(computePinTarget(300, 300)).toBe(0);
  });

  it('clamps negative overflow (content shorter than viewport) to 0', () => {
    expect(computePinTarget(200, 300)).toBe(0);
    expect(computePinTarget(100, 500)).toBe(0);
    expect(computePinTarget(0, 300)).toBe(0);
  });
});

describe('becameLocked', () => {
  it('treats first observation with locked=true as a transition (tab remount)', () => {
    expect(becameLocked(undefined, true)).toBe(true);
  });

  it('treats first observation with locked=false as no-op', () => {
    expect(becameLocked(undefined, false)).toBe(false);
  });

  it('fires only on the false→true transition', () => {
    expect(becameLocked(false, true)).toBe(true);
    expect(becameLocked(false, false)).toBe(false);
  });

  it('never re-fires while already locked, and never on unlock', () => {
    expect(becameLocked(true, true)).toBe(false);
    expect(becameLocked(true, false)).toBe(false);
  });
});

describe('shouldFollow', () => {
  it('follows when nothing suppresses it', () => {
    expect(shouldFollow(false, true, false, false)).toBe(true);
  });

  it('never follows while paused', () => {
    expect(shouldFollow(true, true, false, false)).toBe(false);
    expect(shouldFollow(true, false, false, false)).toBe(false);
  });

  it('never follows when follow is not engaged', () => {
    expect(shouldFollow(false, false, false, false)).toBe(false);
  });

  it('never follows mid-gesture', () => {
    expect(shouldFollow(false, true, true, false)).toBe(false);
  });

  it('never follows while the search bar is open', () => {
    expect(shouldFollow(false, true, false, true)).toBe(false);
  });

  it('stays suppressed under every combination of blockers', () => {
    expect(shouldFollow(true, false, true, true)).toBe(false);
    expect(shouldFollow(false, false, true, true)).toBe(false);
    expect(shouldFollow(true, true, true, true)).toBe(false);
    expect(shouldFollow(true, false, false, true)).toBe(false);
    expect(shouldFollow(false, true, true, true)).toBe(false);
    expect(shouldFollow(true, true, false, true)).toBe(false);
  });

  it('exhaustively covers all 16 combinations', () => {
    // Brute-force the truth table: exactly one cell is true (all-clear).
    let trueCount = 0;
    for (const paused of [false, true]) {
      for (const follow of [false, true]) {
        for (const gestureActive of [false, true]) {
          for (const searchOpen of [false, true]) {
            const result = shouldFollow(paused, follow, gestureActive, searchOpen);
            expect(result).toBe(!paused && follow && !gestureActive && !searchOpen);
            if (result) trueCount += 1;
          }
        }
      }
    }
    expect(trueCount).toBe(1);
  });
});
