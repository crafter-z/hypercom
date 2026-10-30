// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalViewportManager } from '../terminal/viewportManager';
import type { TerminalLine } from '../../types';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { TimelineCoordinator } from './coordinator';
import {
  createTrxTimelineAdapter,
  type TrxTimelineAdapterHandle,
} from './trxTimelineAdapter';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let monotonic: number;
const managers: TerminalViewportManager[] = [];
const adapters: TrxTimelineAdapterHandle[] = [];
let coordinator: TimelineCoordinator;
const line = (timestamp: number): TerminalLine => ({
  timestamp,
  direction: 'RX',
  rawData: new TextEncoder().encode(`time:${timestamp}`),
  isHex: false,
});
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  monotonic = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  useTerminalStore.setState({ terminals: {} });
  coordinator = new TimelineCoordinator({ now: () => monotonic });
});
afterEach(() => {
  adapters.splice(0).forEach((a) => a.dispose());
  coordinator.dispose();
  managers.splice(0).forEach((m) => m.dispose());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function frame(count = 1) {
  for (let i = 0; i < count; i++) {
    monotonic += 16;
    const current = [...frames.values()];
    frames.clear();
    current.forEach((cb) => cb(monotonic));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}
function mount(id: string, count = 200) {
  const manager = new TerminalViewportManager(id, { maxLines: 1000 });
  managers.push(manager);
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { value: 180 });
  document.body.appendChild(container);
  manager.attachRenderer(container, {
    rowHeight: 18,
    showTimestamp: true,
    displayFormat: 'string',
    encoding: 'UTF-8',
    timestampFormat: 'absolute',
    timestampMode: 'perLine',
    highlightRuleSets: [],
    connectedAt: null,
  });
  manager.appendLines(Array.from({ length: count }, (_, i) => line(i * 10)));
  const adapter = createTrxTimelineAdapter({
    slotId: `tab:${id}`,
    portId: id,
    manager,
    coordinator,
  });
  adapters.push(adapter);
  return { manager, container, adapter };
}
describe('TRX adapter with the real terminal engine (jsdom geometry model)', () => {
  it('three real TRX members drive each other while a second two-member group stays put', async () => {
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id) => mount(id));
    await frame(2);
    const first = coordinator.createGroup({
      name: 'abc',
      memberSlots: ['tab:a', 'tab:b', 'tab:c'],
      originSlotId: 'tab:a',
    });
    const second = coordinator.createGroup({
      name: 'de',
      memberSlots: ['tab:d', 'tab:e'],
      originSlotId: 'tab:d',
    });
    await frame(5);
    const snapshots = [a, b, c, d, e].map((view) =>
      vi.spyOn(view.manager.buffer, 'snapshot'),
    );
    const otherAnchor = coordinator
      .getSnapshot()
      .groups.find((g) => g.id === second)?.committedAnchor?.timeMs;
    for (const [view, seq] of [
      [a, 40],
      [b, 80],
      [c, 120],
    ] as const) {
      const token = view.adapter.beginNavigation()!;
      view.manager.scrollToSeq(seq, 'center');
      const anchor = view.adapter.readAnchor()!;
      view.adapter.endNavigation(token, anchor);
      await frame(5);
      const group = coordinator
        .getSnapshot()
        .groups.find((g) => g.id === first)!;
      expect(group.committedAnchor?.timeMs).toBe(anchor.timeMs);
      expect(group.members.every((m) => m.actualTimeMs === anchor.timeMs)).toBe(
        true,
      );
      expect([a, b, c].map((v) => v.adapter.readAnchor()?.timeMs)).toEqual([
        anchor.timeMs,
        anchor.timeMs,
        anchor.timeMs,
      ]);
    }
    expect(
      coordinator.getSnapshot().groups.find((g) => g.id === second)
        ?.committedAnchor?.timeMs,
    ).toBe(otherAnchor);
    snapshots.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });
  it('holds external positioning for selection then applies only the latest target after local realign', async () => {
    const a = mount('a'),
      b = mount('b');
    await frame(2);
    const id = coordinator.createGroup({
      name: 'held',
      memberSlots: ['tab:a', 'tab:b'],
    });
    await frame(4);
    b.manager.setSelectedRange({ start: 0, end: 1 });
    const before = b.container.scrollTop;
    coordinator.seek(id, 700);
    await frame(4);
    coordinator.seek(id, 1200);
    await frame(4);
    expect(b.container.scrollTop).toBe(before);
    expect(coordinator.getSnapshot().groups[0].members[1].status).toBe('held');
    b.manager.setSelectedRange(null);
    coordinator.realign('tab:b');
    await frame(5);
    expect(b.adapter.readAnchor()?.timeMs).toBe(1200);
    expect(coordinator.getSnapshot().groups[0].members[1].actualTimeMs).toBe(
      1200,
    );
    expect(a.adapter.readAnchor()?.timeMs).toBe(1200);
  });
  it('clear to an empty source invalidates the old driving lease and keeps group time through reconnect data', async () => {
    const a = mount('a'),
      b = mount('b');
    await frame(2);
    coordinator.createGroup({ name: 'clear', memberSlots: ['tab:a', 'tab:b'] });
    await frame(4);
    const committed =
      coordinator.getSnapshot().groups[0].committedAnchor?.timeMs;
    const old = a.adapter.beginNavigation()!;
    a.adapter.updateNavigation(old, { timeMs: 800 });
    a.manager.clear();
    await frame(4);
    a.adapter.endNavigation(old, { timeMs: 99999 });
    expect(coordinator.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(
      committed,
    );
    expect(a.adapter.readAnchor()).toBeNull();
    a.manager.appendLines([line(2000), line(2100)]);
    await frame(4);
    expect(coordinator.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(
      committed,
    );
    expect(b.adapter.readAnchor()?.timeMs).not.toBe(99999);
  });
});
