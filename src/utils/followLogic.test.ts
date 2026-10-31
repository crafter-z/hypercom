import { describe, it, expect } from 'vitest';
import {
  isAtBottom,
  shouldFollow,
  FOLLOW_TOLERANCE,
} from './followLogic';

describe('isAtBottom', () => {
  it('is true when the viewport sits flush at the bottom', () => {
    expect(isAtBottom(700, 300, 1000)).toBe(true);
  });

  it('is true when the residual gap is smaller than the tolerance', () => {
    expect(isAtBottom(651, 300, 1000)).toBe(true);
    expect(isAtBottom(699, 300, 1000)).toBe(true);
  });

  it('is true exactly at the tolerance boundary', () => {
    expect(isAtBottom(650, 300, 1000)).toBe(true);
  });

  it('is false beyond the tolerance', () => {
    expect(isAtBottom(649, 300, 1000)).toBe(false);
    expect(isAtBottom(0, 300, 1000)).toBe(false);
  });

  it('honors a custom tolerance parameter', () => {
    expect(isAtBottom(895, 100, 1000, 5)).toBe(true);
    expect(isAtBottom(894, 100, 1000, 5)).toBe(false);
    expect(isAtBottom(0, 100, 1000, 0)).toBe(false);
    expect(isAtBottom(900, 100, 1000, 0)).toBe(true);
  });

  it('exposes the default tolerance as a named constant', () => {
    expect(FOLLOW_TOLERANCE).toBe(50);
  });
});

describe('shouldFollow', () => {
  it('follows when nothing suppresses it; search visibility is not a blocker', () => {
    expect(shouldFollow(false, true, false)).toBe(true);
  });

  it('never follows while paused', () => {
    expect(shouldFollow(true, true, false)).toBe(false);
    expect(shouldFollow(true, false, false)).toBe(false);
  });

  it('never follows when follow is not engaged', () => {
    expect(shouldFollow(false, false, false)).toBe(false);
  });

  it('never follows mid-gesture', () => {
    expect(shouldFollow(false, true, true)).toBe(false);
  });

  it('stays suppressed under every combination of blockers', () => {
    expect(shouldFollow(true, false, true)).toBe(false);
    expect(shouldFollow(false, false, true)).toBe(false);
    expect(shouldFollow(true, true, true)).toBe(false);
    expect(shouldFollow(true, false, false)).toBe(false);
  });

  it('exhaustively covers all 8 combinations of actual follow blockers', () => {
    let trueCount = 0;
    for (const paused of [false, true]) {
      for (const follow of [false, true]) {
        for (const gestureActive of [false, true]) {
          const result = shouldFollow(paused, follow, gestureActive);
          expect(result).toBe(!paused && follow && !gestureActive);
          if (result) trueCount += 1;
        }
      }
    }
    expect(trueCount).toBe(1);
  });
});
