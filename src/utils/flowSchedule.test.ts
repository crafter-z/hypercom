import { describe, it, expect } from 'vitest';
import { advanceFlow } from './flowSchedule';

/**
 * 时间规则只有两条：
 * 1. 步骤之间用这一步自己的 `delay`（对任何动作类型都一样）；
 * 2. 轮与轮之间用集合级 `loopDelay`——轮末那一步的 `delay` 不参与。
 * 下面这些断言就是「旧命令集字节级行为不变」的守卫。
 */
describe('advanceFlow — legacy send-only sets', () => {
  it('advances mid-round with the current step delay', () => {
    const result = advanceFlow({
      stepIndex: 0, stepCount: 3, stepDelay: 120,
      loopDelay: 1000, repeatCount: 0, isLoop: true, completedRounds: 0,
    });
    expect(result).toEqual({ kind: 'continue', nextIndex: 1, delayMs: 120, completedRounds: 0 });
  });

  it('does not apply the step delay after the round-final step', () => {
    const result = advanceFlow({
      stepIndex: 2, stepCount: 3, stepDelay: 120,
      loopDelay: 1000, repeatCount: 0, isLoop: true, completedRounds: 0,
    });
    // 轮间只认 loopDelay——旧实现若把末条 delay 也算上，节奏会整体漂移。
    expect(result).toEqual({ kind: 'next-round', delayMs: 1000, completedRounds: 1 });
  });

  it('finishes a single-round set when isLoop is false', () => {
    const result = advanceFlow({
      stepIndex: 1, stepCount: 2, stepDelay: 50,
      loopDelay: 0, repeatCount: 0, isLoop: false, completedRounds: 0,
    });
    expect(result).toEqual({ kind: 'finish', completedRounds: 1 });
  });

  it('counts repeatCount by rounds, not by steps', () => {
    // 3 条命令 / 重复 2 轮 = 6 次迭代后结束，不能在第 3 次（=1 轮）就停。
    let completedRounds = 0;
    let finishedAt = -1;
    const steps = [{}, {}, {}];
    for (let i = 0; i < 12; i += 1) {
      const result = advanceFlow({
        stepIndex: i % steps.length, stepCount: steps.length, stepDelay: 0,
        loopDelay: 0, repeatCount: 2, isLoop: false, completedRounds,
      });
      completedRounds = result.completedRounds;
      if (result.kind === 'finish') { finishedAt = i; break; }
    }
    expect(finishedAt).toBe(5);
    expect(completedRounds).toBe(2);
  });

  it('keeps looping while repeatCount is 0 and isLoop is true', () => {
    let completedRounds = 0;
    for (let i = 0; i < 40; i += 1) {
      const result = advanceFlow({
        stepIndex: i % 2, stepCount: 2, stepDelay: 0,
        loopDelay: 10, repeatCount: 0, isLoop: true, completedRounds,
      });
      completedRounds = result.completedRounds;
      expect(result.kind).not.toBe('finish');
    }
    expect(completedRounds).toBe(20);
  });
});

describe('advanceFlow — timing is independent of the action type', () => {
  it('applies the same step delay before the next step of any kind', () => {
    // 撤销独立等待步骤后，改参步骤的「之后等待」与发送步骤走同一条规则。
    for (const stepDelay of [0, 30, 250]) {
      expect(advanceFlow({
        stepIndex: 1, stepCount: 4, stepDelay,
        loopDelay: 0, repeatCount: 0, isLoop: true, completedRounds: 0,
      })).toEqual({ kind: 'continue', nextIndex: 2, delayMs: stepDelay, completedRounds: 0 });
    }
  });

  it('uses the round gap when the timed step is the round-final one', () => {
    expect(advanceFlow({
      stepIndex: 2, stepCount: 3, stepDelay: 250,
      loopDelay: 500, repeatCount: 0, isLoop: true, completedRounds: 0,
    })).toEqual({ kind: 'next-round', delayMs: 500, completedRounds: 1 });
  });

  it('finishes an enhanced set after repeatCount rounds even when isLoop is true', () => {
    const result = advanceFlow({
      stepIndex: 1, stepCount: 2, stepDelay: 0,
      loopDelay: 100, repeatCount: 3, isLoop: true, completedRounds: 2,
    });
    expect(result).toEqual({ kind: 'finish', completedRounds: 3 });
  });

  it('treats a missing step delay as zero rather than NaN', () => {
    const result = advanceFlow({
      stepIndex: 0, stepCount: 2,
      loopDelay: undefined, repeatCount: undefined, isLoop: true, completedRounds: 0,
    });
    expect(result).toEqual({ kind: 'continue', nextIndex: 1, delayMs: 0, completedRounds: 0 });
  });
});
