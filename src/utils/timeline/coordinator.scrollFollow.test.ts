import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineCoordinator } from './coordinator';
import { HOST_CLOCK_ID, type TimelineParticipant, type TimelineSeekRequest } from './types';

const coordinators: TimelineCoordinator[] = [];
afterEach(() => {
  coordinators.splice(0).forEach(coordinator => coordinator.dispose());
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
  const frames: (() => void)[] = [];
  const coordinator = new TimelineCoordinator({
    schedule: callback => { frames.push(callback); return frames.length; },
    cancel: () => {},
  });
  coordinators.push(coordinator);
  return {
    coordinator,
    frame: async () => {
      frames.splice(0).forEach(callback => callback());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
function participant(slotId: string, patch: Partial<TimelineParticipant> = {}): TimelineParticipant {
  return {
    participantId: slotId, slotId, sourceId: slotId,
    generation: 1, sourceGeneration: 1,
    sourceKind: 'live', clockId: HOST_CLOCK_ID,
    capabilities: { preview: 'bounded', canDrive: true },
    readAnchor: () => ({ timeMs: 100 }),
    seek: request => ({ status: 'exact', actualTimeMs: request.timeMs }),
    ...patch,
  };
}

describe('existing scroll-lock Pin controls group follow', () => {
  it('toggles the whole group from either member and holds its anchor when turned off', () => {
    const { coordinator: c } = setup();
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b'));
    const id = c.createGroup({ name: 'linked', memberSlots: ['a', 'b'] });
    expect(c.canSetLive(id)).toBe(true);
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    c.toggleSlotFollow('a');
    expect(c.groupForSlot('b')?.mode).toBe('live');
    vi.advanceTimersByTime(200);
    const anchor = c.groupForSlot('a')?.committedAnchor;
    c.toggleSlotFollow('b');
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    vi.advanceTimersByTime(500);
    expect(c.groupForSlot('a')?.committedAnchor).toEqual(anchor);
  });

  it('Pin supersedes a pending navigation; its old preview/release cannot undo LIVE', () => {
    const { coordinator: c } = setup();
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b'));
    c.createGroup({ name: 'linked', memberSlots: ['a', 'b'] });
    const old = c.beginNavigation('b')!;
    c.updateNavigation(old, { timeMs: 900 });
    c.toggleSlotFollow('a');
    const live = c.groupForSlot('a')!;
    expect(live.mode).toBe('live');
    c.updateNavigation(old, { timeMs: 999 });
    c.endNavigation(old, { timeMs: 999 });
    expect(c.groupForSlot('a')).toMatchObject({
      mode: 'live', navigationEpoch: live.navigationEpoch,
      committedAnchor: live.committedAnchor, previewAnchor: null,
    });
    const next = c.beginNavigation('b')!;
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    c.endNavigation(next, { timeMs: 1200 });
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    expect(c.groupForSlot('a')?.committedAnchor?.timeMs).toBe(1200);
  });

  it.each([
    { sourceKind: 'replay' as const, clockId: 'replay:session' },
    { sourceKind: 'custom' as const, clockId: HOST_CLOCK_ID },
    { sourceKind: 'live' as const, clockId: 'unconfirmed-clock' },
  ])('does not enter LIVE for incompatible sources: %o', patch => {
    const { coordinator: c } = setup();
    c.registerParticipant(participant('a', patch));
    const id = c.createGroup({ name: 'unsupported', memberSlots: ['a'] });
    expect(c.canSetLive(id)).toBe(false);
    expect(() => c.toggleSlotFollow('a')).toThrow('LIVE requires compatible live sources');
    expect(c.groupForSlot('a')?.mode).toBe('browse');
  });

  it('a replay joining a LIVE group stops transport and invalidates pending work', () => {
    const { coordinator: c } = setup();
    c.registerParticipant(participant('a'));
    c.registerParticipant(participant('replay', { sourceKind: 'replay', clockId: 'replay:session' }));
    const id = c.createGroup({ name: 'mixed', memberSlots: ['a'] });
    c.toggleSlotFollow('a');
    const epoch = c.groupForSlot('a')!.navigationEpoch;
    c.addMember(id, 'replay');
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    expect(c.groupForSlot('a')!.navigationEpoch).toBeGreaterThan(epoch);
    expect(c.canSetLive(id)).toBe(false);
    c.removeMember('replay');
    expect(c.canSetLive(id)).toBe(true);
    expect(c.groupForSlot('a')?.mode).toBe('browse');
  });

  it('late replay registration and replacement cannot leave a group marked LIVE', () => {
    const { coordinator: c } = setup();
    c.registerParticipant(participant('a'));
    const id = c.createGroup({ name: 'late', memberSlots: ['a', 'pending'] });
    c.toggleSlotFollow('a');
    c.registerParticipant(participant('pending', { sourceKind: 'replay', clockId: 'replay:session' }));
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    c.removeMember('pending');
    c.toggleSlotFollow('a');
    c.registerParticipant(participant('a', { participantId: 'replacement', sourceKind: 'replay' }));
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    expect(c.canSetLive(id)).toBe(false);
  });

  it('grants native append-follow synchronously only in LIVE and revokes it on navigation or membership changes', () => {
    const { coordinator: c } = setup();
    const followA = vi.fn(), followB = vi.fn();
    c.registerParticipant(participant('a', { setLiveFollow: followA }));
    c.registerParticipant(participant('b', { setLiveFollow: followB }));
    const id = c.createGroup({ name: 'native', memberSlots: ['a', 'b'] });
    // Programmatic creation remains browse even when native follow is supported.
    expect(c.groupForSlot('a')?.mode).toBe('browse');
    expect(followA).toHaveBeenLastCalledWith(false);
    expect(followB).toHaveBeenLastCalledWith(false);
    c.setMode(id, 'live');
    expect(followA).toHaveBeenLastCalledWith(true);
    expect(followB).toHaveBeenLastCalledWith(true);
    c.beginNavigation('a');
    expect(followA).toHaveBeenLastCalledWith(false);
    expect(followB).toHaveBeenLastCalledWith(false);
    c.setMode(id, 'live');
    c.setDetached('b', true);
    expect(followA).toHaveBeenLastCalledWith(true);
    expect(followB).toHaveBeenLastCalledWith(false);
    c.setDetached('b', false);
    expect(followB).toHaveBeenLastCalledWith(true);
    c.removeMember('b');
    expect(followB).toHaveBeenLastCalledWith(false);
    c.setMode(id, 'browse');
    expect(followA).toHaveBeenLastCalledWith(false);
  });

  it('relative event mappings grant tail-follow only at the reference source offset', () => {
    const { coordinator: c } = setup();
    const followA = vi.fn(), followB = vi.fn();
    c.registerParticipant(participant('a', { setLiveFollow: followA }));
    c.registerParticipant(participant('b', { setLiveFollow: followB }));
    const id = c.createGroup({ name: 'relative', memberSlots: ['a', 'b'], referenceSourceId: 'a' });
    c.setMapping(id, { sourceId: 'a', sourceTimeMs: 1000, groupTimeMs: 0 });
    c.setMapping(id, { sourceId: 'b', sourceTimeMs: 1500, groupTimeMs: 0 });
    c.setMode(id, 'live');
    expect(followA).toHaveBeenLastCalledWith(true);
    expect(followB).toHaveBeenLastCalledWith(false);
    // Different absolute event anchors with the same effective offset are equivalent.
    c.setMapping(id, { sourceId: 'b', sourceTimeMs: 2000, groupTimeMs: 1000 });
    expect(followB).toHaveBeenLastCalledWith(true);
    c.setMapping(id, { sourceId: 'b', sourceTimeMs: 2000, groupTimeMs: 900 });
    expect(followB).toHaveBeenLastCalledWith(false);
    c.setMode(id, 'browse');
    expect(followA).toHaveBeenLastCalledWith(false);
    expect(followB).toHaveBeenLastCalledWith(false);
  });

  it('hidden or unavailable participants cannot retain native follow and resume only while LIVE', () => {
    const { coordinator: c } = setup();
    const follow = vi.fn();
    const handle = c.registerParticipant(participant('a', { setLiveFollow: follow }));
    const id = c.createGroup({ name: 'visibility', memberSlots: ['a'] });
    c.setMode(id, 'live');
    expect(follow).toHaveBeenLastCalledWith(true);
    handle.setAvailability({ available: true, visible: false });
    expect(follow).toHaveBeenLastCalledWith(false);
    handle.setAvailability({ available: true, visible: true });
    expect(follow).toHaveBeenLastCalledWith(true);
    handle.setAvailability({ available: false });
    expect(follow).toHaveBeenLastCalledWith(false);
    c.setMode(id, 'browse');
    handle.setAvailability({ available: true, visible: true });
    expect(follow).toHaveBeenLastCalledWith(false);
    c.setMode(id, 'live');
    handle.dispose();
    expect(follow).toHaveBeenLastCalledWith(false);
  });

  it('replay joining LIVE immediately revokes native tail-follow on all members', () => {
    const { coordinator: c } = setup();
    const liveFollow = vi.fn(), replayFollow = vi.fn();
    c.registerParticipant(participant('a', { setLiveFollow: liveFollow }));
    c.registerParticipant(participant('replay', {
      sourceKind: 'replay', clockId: 'replay:session', setLiveFollow: replayFollow,
    }));
    const id = c.createGroup({ name: 'mixed-native', memberSlots: ['a'] });
    c.setMode(id, 'live');
    expect(liveFollow).toHaveBeenLastCalledWith(true);
    c.addMember(id, 'replay');
    expect(liveFollow).toHaveBeenLastCalledWith(false);
    expect(replayFollow).toHaveBeenLastCalledWith(false);
    expect(c.groupForSlot('a')?.mode).toBe('browse');
  });

  it('invalidates in-flight seeks without bypassing per-target backpressure', async () => {
    const { coordinator: c, frame } = setup();
    let finish: (() => void) | undefined;
    const requests: TimelineSeekRequest[] = [];
    c.registerParticipant(participant('a', {
      seek: request => {
        requests.push(request);
        return new Promise(resolve => { finish = () => resolve({ status: 'exact', actualTimeMs: request.timeMs }); });
      },
    }));
    c.createGroup({ name: 'slow', memberSlots: ['a'] });
    await frame();
    expect(requests).toHaveLength(1);
    c.toggleSlotFollow('a');
    expect(requests[0].isCurrent()).toBe(false);
    expect(requests[0].signal.aborted).toBe(true);
    await frame();
    expect(requests).toHaveLength(1);
    finish!();
    await frame();
    await frame();
    expect(requests).toHaveLength(2);
    expect(requests[1].timeMs).toBe(Date.now());
    expect(c.groupForSlot('a')?.mode).toBe('live');
    finish!();
  });
});
