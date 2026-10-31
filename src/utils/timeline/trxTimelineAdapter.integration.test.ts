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
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  it('LIVE follows actual appended rows in the very next render without waiting for a transport timer', async () => {
    // Keep the explicit rAF queue installed in beforeEach; fake only the LIVE clock/timers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = mount('a'), b = mount('b');
    await frame(2);
    const id = coordinator.createGroup({ name: 'append-live', memberSlots: ['tab:a', 'tab:b'] });
    await frame(5);
    coordinator.setMode(id, 'live');
    await frame(5);
    const snapshots = [a, b].map(view => vi.spyOn(view.manager.buffer, 'snapshot'));
    for (let batch = 0; batch < 3; batch++) {
      const previous = [a.container.scrollTop, b.container.scrollTop];
      a.manager.appendLines(Array.from({ length: 30 }, (_, i) => line(2000 + batch * 300 + i * 10)));
      b.manager.appendLines(Array.from({ length: 17 }, (_, i) => line(2000 + batch * 170 + i * 10)));
      // Flush exactly one manager rAF; do not advance Date or LIVE's 15Hz timer.
      await frame();
      for (const [index, view] of [a, b].entries()) {
        expect(view.container.scrollTop).toBeGreaterThan(previous[index]);
        expect(view.container.scrollTop).toBe(view.manager.getVisibleCount() * 18 - 180);
        expect(view.manager.readTimelineAnchor('end')?.recordKey).toBe(String(view.manager.buffer.lastSeq));
        expect(view.container.querySelector(`[data-seq="${view.manager.buffer.lastSeq}"]`)).not.toBeNull();
      }
    }
    snapshots.forEach(snapshot => expect(snapshot).not.toHaveBeenCalled());
  });

  it('a LIVE seek queued before an RX batch ACKs the newly rendered tail, never the old lookup seq', async () => {
    // Keep the explicit rAF queue installed in beforeEach; fake only the LIVE clock/timers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = mount('a');
    await frame(2);
    const id = coordinator.createGroup({ name: 'append-during-seek', memberSlots: ['tab:a'] });
    await frame(5);
    coordinator.setMode(id, 'live');
    await frame(5);
    const oldTail = a.manager.buffer.lastSeq;
    const seek = a.manager.seekTimeline({ timeMs: Date.now(), phase: 'commit', isCurrent: () => true });
    // Lookup has run, but the scheduled render/ACK has not.
    a.manager.appendLines(Array.from({ length: 50 }, (_, i) => line(2000 + i * 10)));
    await frame();
    const result = await seek;
    expect(a.manager.buffer.lastSeq).toBeGreaterThan(oldTail);
    expect(a.container.scrollTop).toBe(a.manager.getVisibleCount() * 18 - 180);
    expect(a.manager.readTimelineAnchor('end')?.recordKey).toBe(String(a.manager.buffer.lastSeq));
    expect(result.recordKey).toBe(String(a.manager.buffer.lastSeq));
    expect(result.actualTimeMs).toBe(2490);
  });

  it('LIVE append-follow pins the latest visible row rather than a filtered-out physical tail', async () => {
    // Keep the explicit rAF queue installed in beforeEach; fake only the LIVE clock/timers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = mount('a');
    a.manager.setFilter('RX', '');
    await frame(2);
    const id = coordinator.createGroup({ name: 'filtered-append', memberSlots: ['tab:a'] });
    await frame(5);
    coordinator.setMode(id, 'live');
    await frame(5);
    a.manager.appendLines([
      line(2000),
      { ...line(2010), direction: 'TX' },
      line(2020),
      { ...line(2030), direction: 'TX' },
    ]);
    await frame();
    const latestVisibleSeq = a.manager.buffer.lastSeq - 1;
    expect(a.manager.getVisibleCount()).toBe(202);
    expect(a.container.scrollTop).toBe(202 * 18 - 180);
    expect(a.manager.readTimelineAnchor('end')?.recordKey).toBe(String(latestVisibleSeq));
    expect(a.container.querySelector(`[data-seq="${latestVisibleSeq}"]`)).not.toBeNull();
    expect(a.container.querySelector(`[data-seq="${a.manager.buffer.lastSeq}"]`)).toBeNull();
  });

  it('BROWSE revokes append-follow immediately even if independent scrollLocked was true', async () => {
    // Keep the explicit rAF queue installed in beforeEach; fake only the LIVE clock/timers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = mount('a');
    a.manager.setLocked(true);
    await frame(2);
    const id = coordinator.createGroup({ name: 'stop-append', memberSlots: ['tab:a'] });
    await frame(5);
    coordinator.setMode(id, 'live');
    await frame(5);
    coordinator.setMode(id, 'browse');
    a.manager.scrollToSeq(70, 'center');
    const before = a.container.scrollTop;
    a.manager.appendLines(Array.from({ length: 40 }, (_, i) => line(2000 + i * 10)));
    await frame();
    expect(a.container.scrollTop).toBe(before);
    expect(a.manager.readTimelineAnchor('end')?.recordKey).not.toBe(String(a.manager.buffer.lastSeq));
  });

  it.each(['pause', 'selection'] as const)('LIVE native follow respects %s while RX continues', async protection => {
    // Keep the explicit rAF queue installed in beforeEach; fake only the LIVE clock/timers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = mount('a');
    await frame(2);
    const id = coordinator.createGroup({ name: `protected-${protection}`, memberSlots: ['tab:a'] });
    await frame(5);
    coordinator.setMode(id, 'live');
    await frame(5);
    if (protection === 'pause') a.manager.setPaused(true);
    else a.manager.setSelectedRange({ start: 70, end: 71 });
    a.manager.scrollToSeq(70, 'center');
    const before = a.container.scrollTop;
    a.manager.appendLines(Array.from({ length: 40 }, (_, i) => line(2000 + i * 10)));
    await frame();
    expect(a.manager.buffer.length).toBe(240);
    expect(a.container.scrollTop).toBe(before);
    if (protection === 'pause') a.manager.setPaused(false);
    else a.manager.setSelectedRange(null);
    a.manager.appendLine(line(2400));
    await frame();
    expect(a.container.scrollTop).toBe(a.manager.getVisibleCount() * 18 - 180);
    expect(a.manager.readTimelineAnchor('end')?.recordKey).toBe(String(a.manager.buffer.lastSeq));
  });

  it('LIVE append-follow and seek ACK remain effective with search open or a query being edited', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = mount('a');
    await frame(2);
    const id = coordinator.createGroup({ name: 'live-search', memberSlots: ['tab:a'] });
    await frame(5);
    coordinator.setMode(id, 'live');
    await frame(5);
    let timestamp = 2000;
    for (const [open, query] of [[true, ''], [true, 'time:'], [true, 'no match'], [false, '']] as const) {
      a.manager.setSearch(open, query, false);
      const seek = a.manager.seekTimeline({ timeMs: Date.now(), phase: 'commit', isCurrent: () => true });
      a.manager.appendLines(Array.from({ length: 20 }, () => line(timestamp += 10)));
      await frame();
      const result = await seek;
      expect(coordinator.groupForSlot('tab:a')?.mode).toBe('live');
      expect(a.container.scrollTop).toBe(a.manager.getVisibleCount() * 18 - 180);
      expect(a.manager.readTimelineAnchor('end')?.recordKey).toBe(String(a.manager.buffer.lastSeq));
      expect(result.status).not.toBe('held');
      expect(result.recordKey).toBe(String(a.manager.buffer.lastSeq));
      expect(result.actualTimeMs).toBe(timestamp);
    }
  });

  it('relative timeline offsets keep shifted members on time alignment instead of pinning their local newest row', async () => {
    // Keep the explicit rAF queue installed in beforeEach; fake only the LIVE clock/timers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = mount('a'), b = mount('b');
    await frame(2);
    const id = coordinator.createGroup({
      name: 'relative-append', memberSlots: ['tab:a', 'tab:b'], referenceSourceId: 'serial:a',
    });
    await frame(5);
    coordinator.setMapping(id, { sourceId: 'serial:a', sourceTimeMs: 1000, groupTimeMs: 0 });
    coordinator.setMapping(id, { sourceId: 'serial:b', sourceTimeMs: 1500, groupTimeMs: 0 });
    coordinator.setMode(id, 'live');
    await frame(5);
    const beforeB = b.container.scrollTop;
    a.manager.appendLines(Array.from({ length: 40 }, (_, i) => line(2000 + i * 10)));
    b.manager.appendLines(Array.from({ length: 40 }, (_, i) => line(2000 + i * 10)));
    await frame();
    expect(a.container.scrollTop).toBe(a.manager.getVisibleCount() * 18 - 180);
    expect(b.container.scrollTop).toBe(beforeB);
    expect(b.manager.readTimelineAnchor('end')?.recordKey).not.toBe(String(b.manager.buffer.lastSeq));
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
