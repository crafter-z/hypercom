/**
 * 共享顺序发送引擎的纯逻辑测试（S-F1）。
 *
 * 只测调度本身——计时器链、重入防护、停止语义、可见性补发阈值。引擎不碰
 * `document`（可见性由调用方转调 `catchUpIfOverdue`），所以可以在 node 环境下
 * 用假定时器精确控制时间，不需要 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSendLoop,
  SEND_LOOP_FIRST_TICK_MS,
  SEND_LOOP_OVERDUE_MS,
} from './useSequentialSend';

describe('createSendLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers the first iteration and then follows the delay returned by step', async () => {
    let iterations = 0;
    const loop = createSendLoop({
      step: () => {
        iterations += 1;
        return 20;
      },
    });

    loop.start();
    // 首次迭代也走计时器：start() 不递归调用 step（否则同步风暴）
    expect(iterations).toBe(0);
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS - 1);
    expect(iterations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(iterations).toBe(1);

    await vi.advanceTimersByTimeAsync(19);
    expect(iterations).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(iterations).toBe(2);

    loop.stop();
  });

  it('honours a custom first tick delay', async () => {
    let iterations = 0;
    const loop = createSendLoop({ firstTickMs: 0, step: () => { iterations += 1; return 1000; } });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(iterations).toBe(1);
    loop.stop();
  });

  it('ends and reports once when step returns null', async () => {
    const onStop = vi.fn();
    let iterations = 0;
    const loop = createSendLoop({
      step: () => {
        iterations += 1;
        return null;
      },
      onStop,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(iterations).toBe(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(loop.isRunning()).toBe(false);

    // 结束之后不得再有迭代
    await vi.advanceTimersByTimeAsync(10_000);
    expect(iterations).toBe(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('routes step failures to onStepError, which decides retry vs end', async () => {
    const errors: unknown[] = [];
    let iterations = 0;
    const loop = createSendLoop({
      step: () => {
        iterations += 1;
        if (iterations === 1) throw new Error('boom');
        return null;
      },
      onStepError: (err) => {
        errors.push(err);
        return 5;
      },
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(iterations).toBe(2);
    expect(loop.isRunning()).toBe(false);
  });

  it('ends on a step failure when no handler asks to retry', async () => {
    const onStop = vi.fn();
    const loop = createSendLoop({
      step: () => {
        throw new Error('boom');
      },
      onStop,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(loop.isRunning()).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('start() is a no-op while running, and stop() is idempotent', async () => {
    const onStop = vi.fn();
    let iterations = 0;
    const loop = createSendLoop({ step: () => { iterations += 1; return 100; }, onStop });

    loop.start();
    loop.start(); // 运行中重复 start：不得并行两套计时器
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(iterations).toBe(1);

    loop.stop();
    loop.stop();
    expect(onStop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(iterations).toBe(1);
  });

  it('can be restarted after it ended', async () => {
    let iterations = 0;
    const loop = createSendLoop({ step: () => { iterations += 1; return null; } });

    loop.start();
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(iterations).toBe(1);

    loop.start();
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(iterations).toBe(2);
  });

  it('catchUpIfOverdue ignores iterations that are not overdue yet', async () => {
    let iterations = 0;
    const loop = createSendLoop({ step: () => { iterations += 1; return SEND_LOOP_OVERDUE_MS * 100; } });

    loop.start();
    loop.catchUpIfOverdue(); // 首次迭代还有 100ms 才到期
    await vi.advanceTimersByTimeAsync(0);
    expect(iterations).toBe(0);

    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(iterations).toBe(1);
    loop.catchUpIfOverdue(); // 下一次迭代刚排上，远未到期
    await vi.advanceTimersByTimeAsync(0);
    expect(iterations).toBe(1);
    loop.stop();
  });

  it('catchUpIfOverdue fires a throttled iteration exactly once', async () => {
    let iterations = 0;
    const loop = createSendLoop({ step: () => { iterations += 1; return 1000; } });

    loop.start();
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(iterations).toBe(1);

    // 模拟窗口隐藏：时钟前跳但计时器回调未执行（WebView2 把 setTimeout 链节流）
    vi.setSystemTime(Date.now() + SEND_LOOP_OVERDUE_MS + 1000);
    loop.catchUpIfOverdue();
    await vi.advanceTimersByTimeAsync(0);
    expect(iterations).toBe(2);

    // 句柄已被消费 / 新一轮未到期：补发不得重复触发同一次迭代
    loop.catchUpIfOverdue();
    await vi.advanceTimersByTimeAsync(0);
    expect(iterations).toBe(2);
    loop.stop();
  });

  it('never runs two iterations concurrently, even when a catch-up races an in-flight step', async () => {
    let started = 0;
    let release: (() => void) | null = null;
    const loop = createSendLoop({
      step: () => {
        started += 1;
        return new Promise<number | null>((resolve) => {
          release = () => resolve(10);
        });
      },
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(SEND_LOOP_FIRST_TICK_MS);
    expect(started).toBe(1);

    // 迭代仍在飞（await step 未返回）：补发必须被重入防护挡住
    vi.setSystemTime(Date.now() + 10_000);
    loop.catchUpIfOverdue();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(1);

    release!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toBe(2);
    loop.stop();
  });
});
