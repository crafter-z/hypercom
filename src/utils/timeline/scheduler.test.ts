import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineScheduler, type TimelineTask } from './scheduler';
const schedulers: TimelineScheduler[] = [];
afterEach(() => {
  schedulers.splice(0).forEach((s) => s.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  let now = 0;
  const frames: (() => void)[] = [];
  const scheduler = new TimelineScheduler({
    now: () => now,
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancel: () => {},
  });
  schedulers.push(scheduler);
  return {
    scheduler,
    advance: (ms: number) => {
      now += ms;
    },
    frame: async () => {
      now += 16;
      frames.splice(0).forEach((cb) => cb());
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
function task(
  sequence: number,
  run: TimelineTask['run'],
  phase: TimelineTask['phase'] = 'preview',
  epoch = 1,
): TimelineTask {
  return { phase, epoch, sequence, run, valid: () => true };
}
describe('timeline budget scheduler', () => {
  it('rotates admission fairly when each synchronous follower exhausts a batch', async () => {
    vi.useFakeTimers();
    const { scheduler, advance, frame } = setup();
    const order: string[] = [];
    for (const id of ['a', 'b', 'c'])
      scheduler.enqueue(
        id,
        task(1, () => {
          order.push(id);
          advance(5);
        }),
      );
    await frame();
    expect(order).toEqual(['a']);
    vi.advanceTimersByTime(1);
    await frame();
    expect(order).toEqual(['a', 'b']);
    vi.advanceTimersByTime(1);
    await frame();
    expect(order).toEqual(['a', 'b', 'c']);
  });
  it('reserves bounded final-control admissions independently of preview throttling', async () => {
    const { scheduler, frame } = setup();
    const calls: number[] = [];
    for (let i = 0; i < 10; i++)
      scheduler.enqueue(
        String(i),
        task(
          i,
          () => {
            calls.push(i);
          },
          'commit',
        ),
      );
    await frame();
    expect(calls).toHaveLength(4);
    await frame();
    expect(calls).toHaveLength(8);
    await frame();
    expect(calls).toHaveLength(10);
    expect(new Set(calls).size).toBe(10);
  });
  it('cannot replace a pending commit with a preview from that navigation', async () => {
    const { scheduler, frame } = setup();
    const calls: string[] = [];
    scheduler.enqueue(
      'a',
      task(
        1,
        () => {
          calls.push('commit');
        },
        'commit',
      ),
    );
    scheduler.enqueue(
      'a',
      task(2, () => {
        calls.push('preview');
      }),
    );
    await frame();
    expect(calls).toEqual(['commit']);
  });
  it('keeps callbacks physically in flight after timeout, abort and newer requests', async () => {
    vi.useFakeTimers();
    const { scheduler, frame } = setup();
    let resolve!: () => void;
    const first = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const second = vi.fn();
    scheduler.enqueue('a', task(1, first));
    await frame();
    scheduler.enqueue('a', task(2, second, 'commit'));
    vi.advanceTimersByTime(3000);
    await frame();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(scheduler.state('a')).toEqual({ pending: true, inFlight: true });
    resolve();
    await Promise.resolve();
    await frame();
    expect(second).toHaveBeenCalledTimes(1);
  });
  it('foreground frame pressure only degrades during a gesture and resets next gesture', async () => {
    const { scheduler, frame } = setup();
    scheduler.beginGesture();
    scheduler.observeFrame(30);
    scheduler.observeFrame(30);
    scheduler.observeFrame(30);
    const preview = vi.fn(),
      commit = vi.fn();
    scheduler.enqueue('a', task(1, preview));
    scheduler.enqueue('b', task(1, commit, 'commit'));
    await frame();
    expect(preview).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    scheduler.beginGesture();
    scheduler.observeFrame(1000, false);
    scheduler.enqueue('a', task(2, preview));
    await frame();
    expect(preview).toHaveBeenCalledOnce();
  });
  it('probes actual rAF gaps while a foreground user gesture is active', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const { scheduler, advance, frame } = setup();
    scheduler.beginGesture('g');
    await frame();
    for (let i = 0; i < 3; i++) {
      advance(20);
      await frame();
    }
    expect(scheduler.previewsPaused).toBe(true);
    scheduler.endGesture('g');
    scheduler.beginGesture('new');
    expect(scheduler.previewsPaused).toBe(false);
  });
});
