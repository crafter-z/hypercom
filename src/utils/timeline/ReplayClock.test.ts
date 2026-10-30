import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayClock } from './ReplayClock';
const clocks: ReplayClock[] = [];
afterEach(() => clocks.splice(0).forEach((c) => c.dispose()));
function setup(startTimeMs = 0, endTimeMs = 100000) {
  let now = 0;
  const frames: (() => void)[] = [];
  const ticks = vi.fn();
  const clock = new ReplayClock({
    startTimeMs,
    endTimeMs,
    now: () => now,
    onTick: ticks,
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancel: () => {},
  });
  clocks.push(clock);
  return {
    clock,
    ticks,
    advance: (ms: number) => {
      now += ms;
    },
    frame: () => frames.splice(0).forEach((cb) => cb()),
  };
}
describe('shared replay clock', () => {
  it('preserves long gaps and uses a monotonic origin instead of accumulated timer deltas', () => {
    const { clock, advance, frame } = setup();
    clock.play();
    advance(60000);
    frame();
    expect(clock.getSnapshot()).toEqual({
      timeMs: 60000,
      speed: 1,
      playing: true,
    });
  });
  it('settles before speed changes with no cursor jump', () => {
    const { clock, advance } = setup();
    clock.play();
    advance(1000);
    clock.setSpeed(2);
    expect(clock.getSnapshot().timeMs).toBe(1000);
    advance(500);
    clock.tick();
    expect(clock.getSnapshot().timeMs).toBe(2000);
    clock.setSpeed(0.5);
    advance(1000);
    clock.tick();
    expect(clock.getSnapshot().timeMs).toBe(2500);
  });
  it('pause/resume excludes wall time spent paused and seek resets the origin', () => {
    const { clock, advance } = setup(10000);
    clock.play();
    advance(1000);
    clock.pause();
    advance(50000);
    expect(clock.getSnapshot().timeMs).toBe(11000);
    clock.seek(20000);
    clock.play();
    advance(500);
    clock.tick();
    expect(clock.getSnapshot().timeMs).toBe(20500);
  });
  it('clamps at union range end and stops exactly once reached', () => {
    const { clock, advance, frame } = setup(100, 500);
    clock.play();
    advance(10000);
    frame();
    expect(clock.getSnapshot()).toEqual({
      timeMs: 500,
      speed: 1,
      playing: false,
    });
    clock.play();
    expect(clock.getSnapshot().playing).toBe(false);
    clock.seek(-1);
    expect(clock.getSnapshot().timeMs).toBe(100);
  });
  it('rejects zero/negative/nonfinite speed and reversed or unknown ranges', () => {
    const { clock } = setup();
    [0, -1, Infinity, NaN].forEach((n) =>
      expect(() => clock.setSpeed(n)).toThrow(),
    );
    expect(() => new ReplayClock({ startTimeMs: 2, endTimeMs: 1 })).toThrow();
    expect(() => new ReplayClock({ startTimeMs: NaN, endTimeMs: 1 })).toThrow();
  });
  it('has stable snapshots between ticks, unsubscribe and disposal release callbacks', () => {
    const { clock, ticks, frame } = setup();
    const first = clock.getSnapshot();
    expect(clock.getSnapshot()).toBe(first);
    const fn = vi.fn();
    const unsub = clock.subscribe(fn);
    clock.play();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    clock.pause();
    expect(fn).toHaveBeenCalledTimes(1);
    clock.dispose();
    const count = ticks.mock.calls.length;
    frame();
    clock.play();
    expect(ticks).toHaveBeenCalledTimes(count);
  });
});
