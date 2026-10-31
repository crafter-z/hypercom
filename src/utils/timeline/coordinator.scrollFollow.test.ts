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
