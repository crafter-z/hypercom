import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineCoordinator } from './coordinator';
import type {
  TimelineParticipant,
  TimelineSeekRequest,
  TimelineSeekResult,
} from './types';
import { toGroupTime, toSourceTime } from './types';

const owned: TimelineCoordinator[] = [];
afterEach(() => {
  owned.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
});
function setup() {
  let now = 0;
  const frames: (() => void)[] = [];
  const c = new TimelineCoordinator({
    now: () => now,
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancel: () => {},
  });
  owned.push(c);
  const frame = async (elapsed = 100) => {
    now += elapsed;
    frames.splice(0).forEach((cb) => cb());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    c,
    frame,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function participant(
  id: string,
  seek?: TimelineParticipant['seek'],
): TimelineParticipant {
  return {
    participantId: id,
    slotId: id,
    sourceId: id,
    generation: 1,
    sourceGeneration: 1,
    clockId: 'host-epoch-ms',
    sourceKind: 'live',
    capabilities: { preview: 'bounded', canDrive: true },
    readAnchor: () => ({ timeMs: 100, recordKey: `${id}:record` }),
    seek: seek ?? ((r) => ({ status: 'exact', actualTimeMs: r.timeMs })),
    setGrouped: vi.fn(),
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
describe('timeline coordinator', () => {
  it('maps source/group time with one reversible constant mapping', () => {
    const m = { sourceId: 'a', sourceTimeMs: 1000, groupTimeMs: 0 };
    expect(toGroupTime(1250, m)).toBe(250);
    expect(toSourceTime(250, m)).toBe(1250);
  });
  it('supports three drivers, isolated groups and never reseeks the driving duplicate record', async () => {
    const { c, frame } = setup();
    const calls = [
      vi.fn((r: TimelineSeekRequest) => ({
        status: 'exact' as const,
        actualTimeMs: r.timeMs,
      })),
      vi.fn((r: TimelineSeekRequest) => ({
        status: 'exact' as const,
        actualTimeMs: r.timeMs,
      })),
      vi.fn((r: TimelineSeekRequest) => ({
        status: 'exact' as const,
        actualTimeMs: r.timeMs,
      })),
    ];
    ['a', 'b', 'c'].forEach((id, i) =>
      c.registerParticipant(participant(id, calls[i])),
    );
    c.registerParticipant(participant('d'));
    const group = c.createGroup({ name: 'ABC', memberSlots: ['a', 'b', 'c'] });
    const other = c.createGroup({ name: 'D', memberSlots: ['d'] });
    await frame();
    calls.forEach((fn) => fn.mockClear());
    for (let i = 0; i < 3; i++) {
      const token = c.beginNavigation(['a', 'b', 'c'][i])!;
      c.endNavigation(token, {
        timeMs: 300 + i,
        recordKey: 'same-millisecond-user-row',
      });
      await frame();
      expect(
        c.getSnapshot().groups.find((g) => g.id === group)?.committedAnchor
          ?.timeMs,
      ).toBe(300 + i);
    }
    expect(
      c.getSnapshot().groups.find((g) => g.id === other)?.committedAnchor
        ?.timeMs,
    ).toBe(100);
    expect(calls[0]).toHaveBeenCalledTimes(2);
    expect(calls[1]).toHaveBeenCalledTimes(2);
    expect(calls[2]).toHaveBeenCalledTimes(2);
  });
  it('on-release never moves followers until one final valid commit', async () => {
    const { c, frame } = setup();
    const seek = vi.fn((r: TimelineSeekRequest) => ({
      status: 'nearest' as const,
      actualTimeMs: r.timeMs - 10,
    }));
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    const id = c.createGroup({
      name: 'test',
      memberSlots: ['a', 'b'],
      dragSyncPolicy: 'on-release',
    });
    await frame();
    seek.mockClear();
    const token = c.beginNavigation('a')!;
    for (let i = 0; i < 100; i++) c.updateNavigation(token, { timeMs: i });
    await frame();
    expect(seek).not.toHaveBeenCalled();
    c.endNavigation(token, { timeMs: 999 });
    c.endNavigation(token, { timeMs: 5 });
    await frame();
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek.mock.calls[0][0].phase).toBe('commit');
    const group = c.getSnapshot().groups.find((g) => g.id === id)!;
    expect(group.committedAnchor?.timeMs).toBe(999);
    expect(group.members[1].deltaMs).toBe(-10);
  });
  it.each([8, 16, 33])('keeps healthy %ims render ACKs continuous across a long gesture', async latencyMs => {
    for (const dragSyncPolicy of ['continuous', 'auto'] as const) {
      const { c, frame, advance } = setup();
      const seek = vi.fn(async (request: TimelineSeekRequest) => {
        advance(latencyMs); // Model async render ACK latency, not admission CPU time.
        return { status: 'exact' as const, actualTimeMs: request.timeMs };
      });
      c.registerParticipant(participant('a'));
      c.registerParticipant(participant('b', seek));
      c.createGroup({ name: 'healthy', memberSlots: ['a', 'b'], dragSyncPolicy });
      await frame();
      seek.mockClear();
      const token = c.beginNavigation('a')!;
      for (let i = 0; i < 10; i++) {
        c.updateNavigation(token, { timeMs: 500 + i });
        await frame();
        expect(seek).toHaveBeenCalledTimes(i + 1);
        expect(c.getSnapshot().groups[0].members[1].preview).toBe('continuous');
      }
      c.endNavigation(token, { timeMs: 999 });
      await frame();
      expect(seek.mock.calls[seek.mock.calls.length - 1]?.[0]).toMatchObject({ phase: 'commit', timeMs: 999 });
    }
  });

  it.each(['continuous', 'auto'] as const)('%s honors its policy under sustained frame pressure', async dragSyncPolicy => {
    const { c, frame } = setup();
    const seek = vi.fn((request: TimelineSeekRequest) => ({ status: 'exact' as const, actualTimeMs: request.timeMs }));
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    c.createGroup({ name: 'pressure', memberSlots: ['a', 'b'], dragSyncPolicy });
    await frame();
    seek.mockClear();
    const token = c.beginNavigation('a')!;
    for (let i = 0; i < 3; i++) c.scheduler.observeFrame(33);
    expect(c.scheduler.previewsPaused).toBe(true);
    for (let i = 0; i < 5; i++) {
      c.updateNavigation(token, { timeMs: 500 + i });
      await frame(300);
      expect(seek).toHaveBeenCalledTimes(dragSyncPolicy === 'continuous' ? i + 1 : 0);
      expect(c.getSnapshot().groups[0].members[1].preview).toBe(dragSyncPolicy === 'continuous' ? 'continuous' : 'on-release');
    }
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(seek.mock.calls[seek.mock.calls.length - 1]?.[0]).toMatchObject({ phase: 'commit', timeMs: 999 });
  });

  it('auto still degrades genuinely slow ACKs without swallowing the final commit', async () => {
    const { c, frame, advance } = setup();
    const seek = vi.fn(async (request: TimelineSeekRequest) => {
      if (request.phase === 'preview') advance(80); // Slow preview ACK, below the hard timeout.
      return { status: 'exact' as const, actualTimeMs: request.timeMs };
    });
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    c.createGroup({ name: 'slow', memberSlots: ['a', 'b'], dragSyncPolicy: 'auto' });
    await frame();
    seek.mockClear();
    const token = c.beginNavigation('a')!;
    c.updateNavigation(token, { timeMs: 500 });
    await frame();
    expect(c.getSnapshot().groups[0].members[1].preview).toBe('throttled');
    c.updateNavigation(token, { timeMs: 600 });
    await frame(300);
    expect(c.getSnapshot().groups[0].members[1].preview).toBe('on-release');
    c.updateNavigation(token, { timeMs: 700 });
    await frame(300);
    expect(seek).toHaveBeenCalledTimes(2);
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(seek.mock.calls[seek.mock.calls.length - 1]?.[0]).toMatchObject({ phase: 'commit', timeMs: 999 });
    expect(seek).toHaveBeenCalledTimes(3);
  });

  it('continuous throttles repeated slow ACKs but keeps moving before release', async () => {
    const { c, frame, advance } = setup();
    const seek = vi.fn(async (request: TimelineSeekRequest) => {
      advance(80);
      return { status: 'exact' as const, actualTimeMs: request.timeMs };
    });
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    c.createGroup({ name: 'continuous-slow', memberSlots: ['a', 'b'], dragSyncPolicy: 'continuous' });
    await frame();
    seek.mockClear();
    const token = c.beginNavigation('a')!;
    for (let i = 0; i < 5; i++) {
      c.updateNavigation(token, { timeMs: 500 + i });
      await frame(300);
      expect(seek).toHaveBeenCalledTimes(i + 1);
      expect(c.getSnapshot().groups[0].members[1].preview).toBe('throttled');
    }
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(seek.mock.calls[5][0]).toMatchObject({ phase: 'commit', timeMs: 999 });
  });

  it('continuous keeps timeout backpressure and then applies the latest preview before release', async () => {
    vi.useFakeTimers();
    const { c, frame } = setup();
    const pending = deferred<TimelineSeekResult>();
    let block = false;
    const seek = vi.fn((request: TimelineSeekRequest) => block ? pending.promise
      : Promise.resolve({ status: 'exact' as const, actualTimeMs: request.timeMs }));
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    c.createGroup({ name: 'timeout', memberSlots: ['a', 'b'], dragSyncPolicy: 'continuous' });
    await frame();
    seek.mockClear();
    block = true;
    const token = c.beginNavigation('a')!;
    c.updateNavigation(token, { timeMs: 500 });
    await frame();
    c.updateNavigation(token, { timeMs: 600 });
    vi.advanceTimersByTime(200);
    expect(seek.mock.calls[0][0].signal.aborted).toBe(true);
    expect(c.getSnapshot().groups[0].members[1].preview).toBe('throttled');
    await frame(300);
    expect(seek).toHaveBeenCalledTimes(1); // Timeout cannot free a physically active lane.
    block = false;
    pending.resolve({ status: 'exact', actualTimeMs: 500 });
    await frame(300);
    await frame(300);
    expect(seek).toHaveBeenCalledTimes(2);
    expect(seek.mock.calls[1][0]).toMatchObject({ phase: 'preview', timeMs: 600 });
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(seek.mock.calls[2][0]).toMatchObject({ phase: 'commit', timeMs: 999 });
  });

  it('changing a cached on-release policy to continuous immediately resumes the current preview', async () => {
    const { c, frame } = setup();
    const seek = vi.fn((request: TimelineSeekRequest) => ({ status: 'exact' as const, actualTimeMs: request.timeMs }));
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    const id = c.createGroup({ name: 'switch', memberSlots: ['a', 'b'], dragSyncPolicy: 'on-release' });
    await frame();
    seek.mockClear();
    const token = c.beginNavigation('a')!;
    c.updateNavigation(token, { timeMs: 500 });
    await frame();
    expect(seek).not.toHaveBeenCalled();
    c.setDragSyncPolicy(id, 'continuous');
    await frame();
    expect(seek.mock.calls[0][0]).toMatchObject({ phase: 'preview', timeMs: 500 });
    c.setDragSyncPolicy(id, 'on-release');
    c.updateNavigation(token, { timeMs: 600 });
    await frame();
    expect(seek).toHaveBeenCalledTimes(1);
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(seek.mock.calls[1][0]).toMatchObject({ phase: 'commit', timeMs: 999 });
  });

  it.each(['continuous', 'on-release'] as const)('late async ACKs respect a new %s policy', async nextPolicy => {
    const { c, frame } = setup();
    const pending = deferred<TimelineSeekResult>();
    let block = false;
    const seek = vi.fn((request: TimelineSeekRequest) => block ? pending.promise
      : Promise.resolve({ status: 'exact' as const, actualTimeMs: request.timeMs }));
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    const id = c.createGroup({ name: 'switch-in-flight', memberSlots: ['a', 'b'],
      dragSyncPolicy: nextPolicy === 'continuous' ? 'auto' : 'continuous' });
    await frame();
    seek.mockClear();
    block = true;
    const token = c.beginNavigation('a')!;
    c.updateNavigation(token, { timeMs: 500 });
    await frame();
    c.setDragSyncPolicy(id, nextPolicy);
    block = false;
    pending.resolve({ status: 'exact', actualTimeMs: 500 });
    await frame(300);
    await frame(300);
    c.updateNavigation(token, { timeMs: 600 });
    await frame(300);
    if (nextPolicy === 'on-release') {
      expect(seek).toHaveBeenCalledTimes(1);
      expect(c.getSnapshot().groups[0].members[1].preview).toBe('on-release');
    } else {
      expect(seek.mock.calls[seek.mock.calls.length - 1]?.[0]).toMatchObject({ phase: 'preview', timeMs: 600 });
      expect(c.getSnapshot().groups[0].members[1].preview).not.toBe('on-release');
    }
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(seek.mock.calls[seek.mock.calls.length - 1]?.[0]).toMatchObject({ phase: 'commit', timeMs: 999 });
  });

  it('keeps one in-flight plus latest pending; commit cannot overlap cancelled preview', async () => {
    const { c, frame } = setup();
    const pending = deferred<TimelineSeekResult>();
    const requests: TimelineSeekRequest[] = [];
    let block = false;
    const seek = vi.fn((r: TimelineSeekRequest) => {
      requests.push(r);
      return block
        ? pending.promise
        : Promise.resolve({ status: 'exact' as const, actualTimeMs: r.timeMs });
    });
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', seek));
    c.createGroup({ name: 'test', memberSlots: ['a', 'b'] });
    await frame();
    seek.mockClear();
    block = true;
    const token = c.beginNavigation('a')!;
    c.updateNavigation(token, { timeMs: 200 });
    await frame();
    for (let i = 0; i < 100; i++)
      c.updateNavigation(token, { timeMs: 201 + i });
    c.endNavigation(token, { timeMs: 900 });
    await frame();
    expect(seek).toHaveBeenCalledTimes(1);
    expect(requests[requests.length - 1]?.signal.aborted).toBe(true);
    block = false;
    pending.resolve({ status: 'exact', actualTimeMs: 200 });
    await frame();
    await frame();
    expect(seek).toHaveBeenCalledTimes(2);
    expect(seek.mock.calls[1][0].timeMs).toBe(900);
    expect(seek.mock.calls[1][0].phase).toBe('commit');
  });
  it('preempted leases and mapping/source generations reject old settle and ACK', async () => {
    const { c, frame } = setup();
    const late = deferred<TimelineSeekResult>();
    let blocking = false;
    c.registerParticipant(participant('a'));
    const b = c.registerParticipant(
      participant('b', (r) =>
        blocking ? late.promise : { status: 'exact', actualTimeMs: r.timeMs },
      ),
    );
    const id = c.createGroup({ name: 'test', memberSlots: ['a', 'b'] });
    await frame();
    blocking = true;
    const old = c.beginNavigation('a')!;
    c.updateNavigation(old, { timeMs: 500 });
    await frame();
    const newer = c.beginNavigation('b')!;
    c.endNavigation(old, { timeMs: 999 });
    c.endNavigation(newer, { timeMs: 250 });
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(250);
    c.setMapping(id, { sourceId: 'b', sourceTimeMs: 1000, groupTimeMs: 0 });
    b.updateSourceGeneration(2);
    late.resolve({ status: 'exact', actualTimeMs: 500 });
    await frame();
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(250);
  });
  it('joining aligns without stealing driver, hidden/detached slots resume only latest', async () => {
    const { c, frame } = setup();
    c.registerParticipant(participant('a'));
    const seek = vi.fn((r: TimelineSeekRequest) => ({
      status: 'exact' as const,
      actualTimeMs: r.timeMs,
    }));
    const b = c.registerParticipant(participant('b', seek));
    const id = c.createGroup({ name: 'test', memberSlots: ['a'] });
    const token = c.beginNavigation('a')!;
    c.updateNavigation(token, { timeMs: 200 });
    c.addMember(id, 'b');
    expect(c.getSnapshot().groups[0].ownerParticipantId).toBe('a');
    b.setAvailability({ available: true, visible: false });
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(seek).not.toHaveBeenCalled();
    b.setAvailability({ available: true, visible: true });
    await frame();
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek.mock.calls[0][0].timeMs).toBe(999);
    c.setDetached('b', true);
    c.seek(id, 2000);
    await frame();
    expect(seek).toHaveBeenCalledTimes(1);
    c.setDetached('b', false);
    await frame();
    expect(seek.mock.calls[seek.mock.calls.length - 1]?.[0].timeMs).toBe(2000);
  });
  it('requires explicit mapping for custom clocks, shares source mapping and rejects mixed playback/live', async () => {
    const { c, frame } = setup();
    const custom = participant('b');
    custom.clockId = 'device-uptime';
    custom.sourceKind = 'custom';
    const seek = vi.fn((r: TimelineSeekRequest) => ({
      status: 'exact' as const,
      actualTimeMs: r.timeMs,
    }));
    custom.seek = seek;
    c.registerParticipant(participant('a'));
    c.registerParticipant(custom);
    const id = c.createGroup({ name: 'test', memberSlots: ['a', 'b'] });
    await frame();
    expect(seek).not.toHaveBeenCalled();
    expect(c.getSnapshot().groups[0].members[1].reason).toBe(
      'mapping-required',
    );
    c.setMapping(id, { sourceId: 'b', sourceTimeMs: 1000, groupTimeMs: 0 });
    await frame();
    expect(seek.mock.calls[seek.mock.calls.length - 1]?.[0].timeMs).toBe(1100);
    expect(() => c.setMode(id, 'live')).toThrow();
    expect(() => c.setMode(id, 'playback')).toThrow();
  });
  it('does not let an old registration dispose a replacement in the same slot', () => {
    const { c } = setup();
    const first = c.registerParticipant(participant('a'));
    const newer = participant('a');
    newer.generation = 2;
    c.registerParticipant(newer);
    first.dispose();
    expect(c.participantForSlot('a')?.generation).toBe(2);
  });
  it('restores descriptors only and does not restore owner, preview or transport', () => {
    const { c } = setup();
    c.registerParticipant(participant('a'));
    const id = c.createGroup({ name: 'test', memberSlots: ['a', 'missing'] });
    c.updateNavigation(c.beginNavigation('a')!, { timeMs: 900 });
    const state = c.exportState();
    const { c: restored } = setup();
    restored.restoreState(state, new Set(['a']));
    expect(restored.getSnapshot().groups[0]).toMatchObject({
      id,
      mode: 'browse',
      memberSlots: ['a'],
      committedAnchor: null,
      previewAnchor: null,
      ownerParticipantId: null,
    });
  });
  it('slow async members do not block healthy members and timeout never frees the occupied lane', async () => {
    vi.useFakeTimers();
    const { c, frame } = setup();
    const never = new Promise<TimelineSeekResult>(() => {});
    let slow = false;
    const bad = vi.fn((r: TimelineSeekRequest) =>
      slow
        ? never
        : Promise.resolve({ status: 'exact' as const, actualTimeMs: r.timeMs }),
    );
    const good = vi.fn((r: TimelineSeekRequest) => ({
      status: 'exact' as const,
      actualTimeMs: r.timeMs,
    }));
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b', bad));
    c.registerParticipant(participant('c', good));
    c.createGroup({ name: 'test', memberSlots: ['a', 'b', 'c'] });
    await frame();
    bad.mockClear();
    good.mockClear();
    slow = true;
    const token = c.beginNavigation('a')!;
    c.updateNavigation(token, { timeMs: 700 });
    await frame();
    vi.advanceTimersByTime(250);
    c.endNavigation(token, { timeMs: 999 });
    await frame();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good.mock.calls[good.mock.calls.length - 1]?.[0].timeMs).toBe(999);
    expect(c.getSnapshot().groups[0].members[1]).toMatchObject({
      status: 'slow',
      inFlight: true,
      pending: true,
      preview: 'on-release',
    });
  });
});
