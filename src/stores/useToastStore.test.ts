import { describe, it, expect, beforeEach } from 'vitest';
import { useToastStore } from './useToastStore';

// Store-level tests only (DOM-free): auto-dismiss timers live in Toast.tsx,
// so sticky semantics are verified as durationMs === 0 being preserved.
beforeEach(() => {
  useToastStore.setState({ toasts: [], stashed: [], centerOpen: false });
});

describe('useToastStore', () => {
  it('push returns a unique id and applies defaults', () => {
    const id = useToastStore.getState().push({ severity: 'info', message: 'hello' });
    const state = useToastStore.getState();
    expect(state.toasts).toHaveLength(1);
    expect(id).toBe(state.toasts[0].id);
    expect(state.toasts[0].message).toBe('hello');
    expect(state.toasts[0].durationMs).toBe(4000); // DEFAULT_DURATION_MS
    expect(state.toasts[0].title).toBeUndefined();
  });

  it('error severity gets the longer auto-dismiss duration', () => {
    useToastStore.getState().push({ severity: 'error', message: 'boom' });
    expect(useToastStore.getState().toasts[0].durationMs).toBe(6000); // ERROR_DURATION_MS
  });

  it('durationMs 0 is preserved — sticky, no auto-dismiss semantics', () => {
    useToastStore.getState().push({ severity: 'warning', message: 'sticky', durationMs: 0 });
    expect(useToastStore.getState().toasts[0].durationMs).toBe(0);
  });

  it('push passes title through for the notification center', () => {
    useToastStore.getState().push({
      severity: 'warning',
      title: 'COM1 matched rule A',
      message: 'ALERT PAYLOAD',
      durationMs: 0,
    });
    const toast = useToastStore.getState().toasts[0];
    expect(toast.title).toBe('COM1 matched rule A');
    expect(toast.message).toBe('ALERT PAYLOAD');
  });

  // issue #7-1：串口来源消息携带 portId；每条通知自带 createdAt 时间戳。
  it('push passes portId through for the notification center', () => {
    useToastStore.getState().push({
      severity: 'warning',
      message: 'port lost',
      portId: 'COM3',
      durationMs: 8000,
    });
    const toast = useToastStore.getState().toasts[0];
    expect(toast.portId).toBe('COM3');
  });

  it('push without portId leaves it undefined (non-serial messages)', () => {
    useToastStore.getState().push({ severity: 'info', messageKey: 'toast.some.info' });
    expect(useToastStore.getState().toasts[0].portId).toBeUndefined();
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

  it('setCenterOpen toggles the notification center visibility', () => {
    expect(useToastStore.getState().centerOpen).toBe(false);
    useToastStore.getState().setCenterOpen(true);
    expect(useToastStore.getState().centerOpen).toBe(true);
    useToastStore.getState().setCenterOpen(false);
    expect(useToastStore.getState().centerOpen).toBe(false);
  });
});
