import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../terminal/viewportManager', () => ({ getViewportManager: vi.fn() }));
import type { TerminalViewportManager } from '../terminal/viewportManager';
import { TimelineCoordinator } from './coordinator';
import { createTrxTimelineAdapter } from './trxTimelineAdapter';
const owned: TimelineCoordinator[] = [];
afterEach(() => {
  owned.splice(0).forEach((c) => c.dispose());
});
function setup() {
  const frames: (() => void)[] = [];
  const c = new TimelineCoordinator({
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancel: () => {},
  });
  owned.push(c);
  let anchor: {
    timeMs: number;
    recordKey: string;
    sourceGeneration: number;
  } | null = { timeMs: 100, recordKey: '1', sourceGeneration: 1 };
  const listeners = new Set<() => void>();
  const manager = {
    sourceGeneration: 1,
    readTimelineAnchor: vi.fn(() => anchor),
    seekTimeline: vi.fn(async (r: { timeMs: number }) => ({
      status: 'exact' as const,
      actualTimeMs: r.timeMs,
    })),
    setTimelineGrouped: vi.fn(),
    subscribeReadouts: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  return {
    c,
    manager,
    frames,
    listeners,
    clear: () => {
      manager.sourceGeneration++;
      anchor = null;
      listeners.forEach((cb) => cb());
    },
    frame: async () => {
      frames.splice(0).forEach((cb) => cb());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
describe('TRX timeline adapter', () => {
  it('registers stable slot/source identities and delegates only scheduled seeks', async () => {
    const { c, manager, frame } = setup();
    const adapter = createTrxTimelineAdapter({
      slotId: 'tab',
      portId: 'COM3',
      manager: manager as unknown as TerminalViewportManager,
      coordinator: c,
    });
    expect(c.participantForSlot('tab')?.sourceId).toBe('serial:COM3');
    const id = c.createGroup({
      name: 'test',
      memberSlots: ['tab'],
      originSlotId: 'tab',
    });
    expect(manager.setTimelineGrouped).toHaveBeenLastCalledWith(true);
    c.seek(id, 900);
    await frame();
    expect(manager.seekTimeline).toHaveBeenCalledTimes(1);
    expect(manager.seekTimeline.mock.calls[0][0].timeMs).toBe(900);
    adapter.dispose();
    expect(manager.setTimelineGrouped).toHaveBeenLastCalledWith(false);
  });
  it('detects clear generations even when there is no anchor and releases its subscription', () => {
    const { c, manager, listeners, clear } = setup();
    const adapter = createTrxTimelineAdapter({
      slotId: 'tab',
      portId: 'COM3',
      manager: manager as unknown as TerminalViewportManager,
      coordinator: c,
    });
    c.createGroup({ name: 'test', memberSlots: ['tab'] });
    const token = adapter.beginNavigation()!;
    clear();
    expect(c.participantForSlot('tab')?.sourceGeneration).toBe(2);
    adapter.endNavigation(token, { timeMs: 999 });
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(100);
    expect(adapter.readAnchor()).toBeNull();
    adapter.dispose();
    expect(listeners.size).toBe(0);
  });
  it('accepts a read-only injected replay manager without fabricating a serial port', () => {
    const { c, manager } = setup();
    createTrxTimelineAdapter({
      slotId: 'replay-tab',
      sourceId: 'replay:session:track',
      sourceKind: 'replay',
      clockId: 'replay:session',
      manager: manager as unknown as TerminalViewportManager,
      coordinator: c,
    });
    expect(c.participantForSlot('replay-tab')).toMatchObject({
      sourceId: 'replay:session:track',
      sourceKind: 'replay',
      clockId: 'replay:session',
    });
    expect(() =>
      createTrxTimelineAdapter({
        slotId: 'bad',
        manager: manager as unknown as TerminalViewportManager,
        coordinator: c,
      }),
    ).toThrow();
  });
});
