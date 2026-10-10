import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useToastStore } from './useToastStore';

// Store-level tests only (DOM-free): auto-dismiss timers live in Toast.tsx,
// so sticky semantics are verified as durationMs === 0 being preserved.
beforeEach(() => {
  useToastStore.setState({ toasts: [], stashed: [], centerOpen: false });
});

describe('useToastStore', () => {

  it('durationMs 0 is preserved — sticky, no auto-dismiss semantics', () => {
    useToastStore.getState().push({ severity: 'warning', message: 'sticky', durationMs: 0 });
    expect(useToastStore.getState().toasts[0].durationMs).toBe(0);
  });

  it('createdAt is stamped at push time and survives into the stash', () => {
    const before = Date.now();
    useToastStore.getState().push({ severity: 'info', message: 'm1', durationMs: 4000 });
    for (let i = 2; i <= 6; i++) {
      useToastStore.getState().push({ severity: 'info', message: `m${i}`, durationMs: 4000 });
    }
    const state = useToastStore.getState();
    expect(state.stashed).toHaveLength(1);
    expect(state.stashed[0].message).toBe('m1');
    expect(state.stashed[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(state.stashed[0].createdAt).toBeLessThanOrEqual(Date.now());
    // 通知中心按 createdAt 倒序渲染——时间戳是排序的唯一事实来源
    expect(state.stashed[0].createdAt).toBeLessThanOrEqual(state.toasts[4].createdAt);
  });

  it('overflow moves the oldest live toast into stashed instead of dropping', () => {
    for (let i = 1; i <= 6; i++) {
      useToastStore.getState().push({ severity: 'info', message: `m${i}`, durationMs: 4000 });
    }
    const state = useToastStore.getState();
    expect(state.toasts).toHaveLength(5); // MAX_VISIBLE live stack
    expect(state.stashed).toHaveLength(1);
    expect(state.stashed[0].message).toBe('m1');
    // Newest stays live at the end of the stack
    expect(state.toasts[4].message).toBe('m6');
  });

  it('repeated overflow accumulates the stash — nothing is ever dropped', () => {
    for (let i = 1; i <= 12; i++) {
      useToastStore.getState().push({ severity: 'info', message: `m${i}`, durationMs: 4000 });
    }
    const state = useToastStore.getState();
    expect(state.toasts).toHaveLength(5);
    expect(state.stashed).toHaveLength(7);
    expect(state.stashed[0].message).toBe('m1');
    expect(state.stashed[6].message).toBe('m7');
  });

  it('dismiss removes a toast from the live stack', () => {
    const id = useToastStore.getState().push({ severity: 'info', message: 'x' });
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismiss also removes a toast from the stash', () => {
    for (let i = 1; i <= 6; i++) {
      useToastStore.getState().push({ severity: 'info', message: `m${i}`, durationMs: 4000 });
    }
    const stashedId = useToastStore.getState().stashed[0].id;
    useToastStore.getState().dismiss(stashedId);
    const state = useToastStore.getState();
    expect(state.stashed).toHaveLength(0);
    expect(state.toasts).toHaveLength(5);
  });

  it('clearAll empties both the live stack and the stash', () => {
    for (let i = 1; i <= 8; i++) {
      useToastStore.getState().push({ severity: 'info', message: `m${i}`, durationMs: 4000 });
    }
    expect(useToastStore.getState().toasts.length + useToastStore.getState().stashed.length).toBe(8);
    useToastStore.getState().clearAll();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().stashed).toHaveLength(0);
  });

});

let pluginTestTime = Date.UTC(2050, 0, 1);

describe('plugin notification quotas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pluginTestTime += 10_000;
    vi.setSystemTime(pluginTestTime);
  });

  afterEach(() => {
    pluginTestTime = Date.now();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const notify = (pluginId = 'quota.test') => useToastStore.getState().pushPlugin(pluginId, {
    severity: 'info', message: 'plugin notification',
  });
  const pending = () => [...useToastStore.getState().stashed, ...useToastStore.getState().toasts];

  it('accepts burst five, drops sequential excess silently, and refills one token per second', () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');
    for (let i = 0; i < 5; i++) expect(notify()).not.toBeNull();
    for (let i = 5; i < 200; i++) expect(notify()).toBeNull();
    expect(pending()).toHaveLength(5);
    vi.advanceTimersByTime(999);
    expect(notify()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(notify()).not.toBeNull();
    expect(notify()).toBeNull();
    expect(pending()).toHaveLength(6);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('preserves fractional refill through repeated rejected requests', () => {
    for (let i = 0; i < 5; i++) notify();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(250);
      expect(notify()).toBeNull();
    }
    vi.advanceTimersByTime(250);
    expect(notify()).not.toBeNull();
  });

  it('gives each plugin its own burst and source identity', () => {
    for (let i = 0; i < 5; i++) notify('first.plugin');
    expect(notify('first.plugin')).toBeNull();
    expect(notify('second.plugin')).not.toBeNull();
    expect(pending().filter((toast) => toast.pluginId === 'first.plugin')).toHaveLength(5);
    expect(pending().filter((toast) => toast.pluginId === 'second.plugin')).toHaveLength(1);
  });

  it('caps live plus stashed plugin backlog at 20 despite allowed requests over time', () => {
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000);
      expect(notify()).not.toBeNull();
    }
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(1000);
      expect(notify()).toBeNull();
    }
    expect(useToastStore.getState().toasts).toHaveLength(5);
    expect(useToastStore.getState().stashed).toHaveLength(15);
    useToastStore.getState().dismiss(pending()[0].id);
    expect(notify()).not.toBeNull();
    expect(pending()).toHaveLength(20);
  });

  it('caps combined plugin backlog at 100 without evicting core or serial sticky notifications', () => {
    const coreIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      coreIds.push(useToastStore.getState().push({
        severity: 'warning', message: `core-${i}`, durationMs: 0, portId: 'COM3',
      }));
    }
    for (let plugin = 0; plugin < 5; plugin++) {
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(1000);
        expect(notify(`backlog-${plugin}`)).not.toBeNull();
      }
    }
    expect(notify('another.plugin')).toBeNull();
    expect(pending().filter((toast) => toast.pluginId !== undefined)).toHaveLength(100);
    const core = pending().filter((toast) => toast.pluginId === undefined);
    expect(core.map((toast) => toast.id)).toEqual(coreIds);
    expect(core.every((toast) => toast.durationMs === 0 && toast.portId === 'COM3')).toBe(true);
    const freshCore = useToastStore.getState().push({ severity: 'error', message: 'core still works', durationMs: 0 });
    expect(pending().some((toast) => toast.id === freshCore)).toBe(true);
    expect(pending()).toHaveLength(109);
  });

  it('clearAll releases pending capacity without resetting the rate quota', () => {
    for (let i = 0; i < 5; i++) notify();
    useToastStore.getState().clearAll();
    expect(notify()).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(notify()).not.toBeNull();
    expect(pending()).toHaveLength(1);
  });

  it('caps an idle refill at the original burst rather than banking unlimited credit', () => {
    for (let i = 0; i < 5; i++) notify();
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 5; i++) expect(notify()).not.toBeNull();
    expect(notify()).toBeNull();
    expect(pending()).toHaveLength(10);
  });

  it.each([255, 256, 257])('bounds title text at the %i code-unit boundary', (size) => {
    useToastStore.getState().pushPlugin('title.plugin', { severity: 'info', title: 't'.repeat(size) });
    expect(pending()[0].title).toBe('t'.repeat(Math.min(size, 256)));
  });

  it.each([4095, 4096, 4097])('bounds body text at the %i code-unit boundary', (size) => {
    useToastStore.getState().pushPlugin('body.plugin', { severity: 'info', message: 'b'.repeat(size) });
    expect(pending()[0].message).toBe('b'.repeat(Math.min(size, 4096)));
  });

  it.each([
    [undefined, 4000], [NaN, 4000], [Infinity, 4000], [-Infinity, 4000],
    [-1, 2000], [0, 2000], [1999, 2000], [2000, 2000],
    [30000, 30000], [30001, 30000],
  ])('normalizes duration %s to finite bounded %s ms', (durationMs, expected) => {
    useToastStore.getState().pushPlugin('duration.plugin', { severity: 'error', durationMs });
    expect(pending()[0].durationMs).toBe(expected);
  });
});
