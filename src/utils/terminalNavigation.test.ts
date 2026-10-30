import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalNavigationLifecycle } from './terminalNavigation';

function setup(isCurrent?: () => boolean, canUseLastAnchor?: () => boolean) {
  vi.useFakeTimers();
  let top = 0;
  let anchor: number | null = 10;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const callbacks = { begin: vi.fn(), preview: vi.fn(), commit: vi.fn(), cancel: vi.fn() };
  const lifecycle = new TerminalNavigationLifecycle({
    readAnchor: () => anchor, readScrollTop: () => top, isCurrent, canUseLastAnchor,
    onBegin: callbacks.begin, onPreview: callbacks.preview,
    onCommit: callbacks.commit, onCancel: callbacks.cancel,
    requestFrame: cb => { frames.set(++frameId, cb); return frameId; },
    cancelFrame: id => { frames.delete(id); },
  });
  return {
    lifecycle, callbacks,
    top: (value: number) => { top = value; }, anchor: (value: number | null) => { anchor = value; },
    frame: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0)); },
  };
}

afterEach(() => vi.useRealTimers());

describe('explicit terminal navigation lifecycle', () => {
  it('never acquires driving ownership from bare scroll', () => {
    const s = setup(); s.top(100); s.lifecycle.scroll(); s.frame();
    vi.runAllTimers(); s.frame();
    expect(s.callbacks.begin).not.toHaveBeenCalled();
    expect(s.callbacks.commit).not.toHaveBeenCalled();
  });

  it('coalesces source samples and keeps a held scrollbar deferred until release', () => {
    const s = setup(); s.lifecycle.begin(1);
    s.top(100); s.lifecycle.scroll(); s.top(200); s.anchor(20); s.lifecycle.scroll(); s.frame();
    expect(s.callbacks.preview).toHaveBeenCalledExactlyOnceWith(20);
    vi.advanceTimersByTime(1000); s.frame();
    expect(s.callbacks.commit).not.toHaveBeenCalled();
    s.lifecycle.release(1); vi.advanceTimersByTime(120); s.frame();
    expect(s.callbacks.commit).toHaveBeenCalledExactlyOnceWith(20);
    s.lifecycle.release(1); vi.runAllTimers(); s.frame();
    expect(s.callbacks.commit).toHaveBeenCalledTimes(1);
  });

  it('samples the last scroll arriving after pointer release, exactly once', () => {
    const s = setup(); s.lifecycle.begin(2); s.top(10); s.lifecycle.scroll(); s.frame();
    s.lifecycle.release(2); vi.advanceTimersByTime(100);
    s.top(90); s.anchor(90); s.lifecycle.scroll(); s.frame();
    vi.advanceTimersByTime(119); s.frame(); expect(s.callbacks.commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); s.frame(); expect(s.callbacks.commit).toHaveBeenCalledExactlyOnceWith(90);
  });

  it('ignores unrelated pointerup and horizontal-only scroll', () => {
    const s = setup(); s.lifecycle.begin(7); s.lifecycle.scroll(); s.frame();
    s.lifecycle.release(8); vi.advanceTimersByTime(300); s.frame();
    expect(s.callbacks.commit).not.toHaveBeenCalled();
    expect(s.callbacks.preview).not.toHaveBeenCalled();
    s.lifecycle.release(7); vi.advanceTimersByTime(120); s.frame();
    expect(s.callbacks.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels old settle and source generations without stale commit', () => {
    const s = setup(); s.lifecycle.begin(); s.top(10); s.lifecycle.scroll(); s.frame();
    vi.advanceTimersByTime(120); // final rAF pending
    s.lifecycle.cancel(); s.lifecycle.begin(); s.top(30); s.anchor(30); s.lifecycle.scroll(); s.frame();
    expect(s.callbacks.commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120); s.frame();
    expect(s.callbacks.commit).toHaveBeenCalledExactlyOnceWith(30);
  });

  it('blur/cancel release preserves the last valid anchor instead of guessing zero', () => {
    const s = setup(); s.lifecycle.begin(1); s.top(40); s.anchor(40); s.lifecycle.scroll(); s.frame();
    s.anchor(null); s.lifecycle.release(); vi.advanceTimersByTime(120); s.frame();
    expect(s.callbacks.commit).toHaveBeenCalledExactlyOnceWith(40);
  });

  it('does not reuse a previous event time when final visible record time is unknown', () => {
    const s = setup(undefined, () => false);
    s.lifecycle.begin(); s.top(40); s.anchor(40); s.lifecycle.scroll(); s.frame();
    s.anchor(null); vi.advanceTimersByTime(120); s.frame();
    expect(s.callbacks.commit).not.toHaveBeenCalled();
    expect(s.callbacks.cancel).toHaveBeenCalledTimes(1);
  });

  it('new explicit input reacquires a preempted lease before the old settle', () => {
    let current = true;
    const s = setup(() => current);
    s.lifecycle.begin(); s.top(10); s.lifecycle.scroll(); s.frame();
    current = false; // a different participant has become driver
    s.lifecycle.begin(); // same source receives a new, explicit wheel intent
    current = true;
    s.top(30); s.anchor(30); s.lifecycle.scroll(); s.frame();
    expect(s.callbacks.begin).toHaveBeenCalledTimes(2);
    expect(s.callbacks.cancel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120); s.frame();
    expect(s.callbacks.commit).toHaveBeenCalledExactlyOnceWith(30);
  });

  it('disposal never commits and quiet wheel settles independently', () => {
    const s = setup(); s.lifecycle.begin(); s.top(10); s.lifecycle.scroll();
    s.lifecycle.dispose(); vi.runAllTimers(); s.frame();
    expect(s.callbacks.commit).not.toHaveBeenCalled();
    expect(s.callbacks.cancel).toHaveBeenCalledTimes(1);
  });
});
