import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineCoordinator } from './coordinator';
import type { TimelineParticipant, TimelineParticipantHandle } from './types';
const owned: TimelineCoordinator[] = [];
afterEach(() => {
  owned.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
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
  return {
    c,
    frame: async () => {
      frames.splice(0).forEach((cb) => cb());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
function participant(id: string): TimelineParticipant {
  return {
    participantId: id,
    slotId: id,
    sourceId: id,
    sourceKind: 'live',
    clockId: 'host-epoch-ms',
    generation: 1,
    sourceGeneration: 1,
    capabilities: { preview: 'bounded', canDrive: true },
    readAnchor: () => ({ timeMs: 100 }),
    seek: (r) => ({ status: 'exact', actualTimeMs: r.timeMs }),
  };
}
describe('timeline lease and resource lifecycle', () => {
  it('clears alignment results when old raw content is replaced by an unavailable plugin', async () => {
    const { c, frame } = setup();
    const old = c.registerParticipant(participant('a'));
    c.createGroup({ name: 'replace', memberSlots: ['a'] });
    await frame();
    expect(c.getSnapshot().groups[0].members[0].status).toBe('exact');
    old.dispose();
    const plugin = participant('plugin-document');
    plugin.slotId = 'a';
    plugin.availability = { available: false, visible: true };
    c.registerParticipant(plugin);
    expect(c.getSnapshot().groups[0].members[0]).toMatchObject({
      state: 'unavailable',
      participantId: 'plugin-document',
    });
    expect(c.getSnapshot().groups[0].members[0].status).toBeUndefined();
    expect(c.getSnapshot().groups[0].members[0].actualTimeMs).toBeUndefined();
  });
  it('rechecks the final lease when readAnchor itself changes source generation', async () => {
    const { c, frame } = setup();
    let handle!: TimelineParticipantHandle;
    let changeOnRead = false;
    const source = participant('a');
    source.readAnchor = () => {
      if (changeOnRead) {
        changeOnRead = false;
        handle.updateSourceGeneration(2);
      }
      return { timeMs: 999 };
    };
    handle = c.registerParticipant(source);
    c.createGroup({
      name: 'reentrant',
      memberSlots: ['a'],
      anchor: { timeMs: 100 },
    });
    await frame();
    const token = c.beginNavigation('a')!;
    changeOnRead = true;
    c.endNavigation(token);
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(100);
    expect(c.getSnapshot().groups[0].ownerParticipantId).toBeNull();
    expect(c.participantForSlot('a')?.sourceGeneration).toBe(2);
  });
  it.each(['remove-member', 'unregister', 'delete-group'] as const)(
    'releases the last LIVE reference timer on %s',
    async (action) => {
      vi.useFakeTimers();
      const { c, frame } = setup();
      const handle = c.registerParticipant(participant('a'));
      const id = c.createGroup({ name: 'live', memberSlots: ['a'] });
      await frame();
      c.setMode(id, 'live');
      await frame();
      expect(vi.getTimerCount()).toBe(1);
      const before = c.getSnapshot().groups[0].committedAnchor?.timeMs;
      if (action === 'remove-member') c.removeMember('a');
      else if (action === 'unregister') handle.dispose();
      else c.deleteGroup(id);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10000);
      if (action !== 'delete-group')
        expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(before);
    },
  );
  it('revokes an active driver immediately and never revives its token after capability ABA', async () => {
    const { c, frame } = setup();
    const handle = c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b'));
    c.createGroup({ name: 'capability', memberSlots: ['a', 'b'], anchor: { timeMs: 100 } });
    await frame();
    const old = c.beginNavigation('a')!;
    c.updateNavigation(old, { timeMs: 200 });
    handle.updateCapabilities({ preview: 'bounded', canDrive: false });
    expect(c.getSnapshot().groups[0].ownerParticipantId).toBeNull();
    expect(c.getSnapshot().groups[0].previewAnchor).toBeNull();
    c.updateNavigation(old, { timeMs: 300 });
    c.endNavigation(old, { timeMs: 300 });
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(100);
    handle.updateCapabilities({ preview: 'bounded', canDrive: true });
    c.endNavigation(old, { timeMs: 400 });
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(100);
    const fresh = c.beginNavigation('a')!;
    c.endNavigation(fresh, { timeMs: 500 });
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(500);
  });
  it('requires confirmation for a changed clock segment without suspending unchanged healthy sources', async () => {
    const { c, frame } = setup();
    const a = c.registerParticipant(participant('a'));
    c.registerParticipant(participant('b'));
    const id = c.createGroup({ name: 'epochs', memberSlots: ['a', 'b'] });
    await frame();
    a.updateSourceGeneration(1, 'reset-2');
    expect(c.getSnapshot().groups[0].members[0]).toMatchObject({
      state: 'unavailable',
      reason: 'mapping-required',
    });
    expect(c.getSnapshot().groups[0].members[1].state).toBe('active');
    expect(c.beginNavigation('a')).toBeNull();
    c.setMapping(id, {
      sourceId: 'a',
      sourceTimeMs: 0,
      groupTimeMs: 1000,
      clockEpoch: 'reset-2',
    });
    expect(
      c.getSnapshot().groups[0].members.every((m) => m.state === 'active'),
    ).toBe(true);
  });
});
