import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineCoordinator } from './coordinator';
import type { TimelineParticipant, TimelineSeekRequest } from './types';
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
  return {
    c,
    frame: async () => {
      now += 100;
      frames.splice(0).forEach((cb) => cb());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
function participant(id: string) {
  const seek = vi.fn((r: TimelineSeekRequest) => ({
    status: 'exact' as const,
    actualTimeMs: r.timeMs,
  }));
  const onUserNavigation = vi.fn();
  const value: TimelineParticipant = {
    participantId: id,
    slotId: id,
    sourceId: id,
    generation: 1,
    sourceGeneration: 1,
    clockId: 'host-epoch-ms',
    sourceKind: 'live',
    capabilities: { preview: 'bounded', canDrive: true },
    readAnchor: () => ({ timeMs: 100, recordKey: 'user-duplicate-record' }),
    seek,
    onUserNavigation,
  };
  return { value, seek, onUserNavigation };
}
describe('timeline transport and restoration', () => {
  it('preserves the creating origin record while aligning other members once', async () => {
    const { c, frame } = setup();
    const a = participant('a'),
      b = participant('b');
    c.registerParticipant(a.value);
    c.registerParticipant(b.value);
    c.createGroup({
      name: 'origin',
      memberSlots: ['a', 'b'],
      anchor: { timeMs: 500, recordKey: 'origin-row' },
      originSlotId: 'a',
    });
    await frame();
    expect(a.seek).not.toHaveBeenCalled();
    expect(b.seek).toHaveBeenCalledOnce();
    expect(b.seek.mock.calls[0][0].timeMs).toBe(500);
  });
  it('same-session replay tracks share their confirmed clock without per-track mappings', async () => {
    const { c, frame } = setup();
    const a = participant('a'),
      b = participant('b');
    for (const p of [a, b]) {
      p.value.sourceKind = 'replay';
      p.value.clockId = 'replay:session';
      c.registerParticipant(p.value);
    }
    const id = c.createGroup({ name: 'replay', memberSlots: ['a', 'b'] });
    await frame();
    expect(b.seek).toHaveBeenCalledOnce();
    expect(
      c.getSnapshot().groups[0].members.every((m) => m.state === 'active'),
    ).toBe(true);
    c.setMode(id, 'playback');
    c.seek(id, 400, 'preview');
    expect(c.getSnapshot().groups[0].mode).toBe('playback');
    expect(a.onUserNavigation).not.toHaveBeenCalled();
    c.seek(id, 500);
    expect(c.getSnapshot().groups[0].mode).toBe('browse');
    expect(a.onUserNavigation).toHaveBeenCalledOnce();
    expect(b.onUserNavigation).toHaveBeenCalledOnce();
  });
  it('auto defers an unknown-cost target until a completed final seek sample', async () => {
    const { c, frame } = setup();
    const a = participant('a'),
      b = participant('b');
    a.value.readAnchor = () => null;
    b.value.readAnchor = () => null;
    c.registerParticipant(a.value);
    c.registerParticipant(b.value);
    c.createGroup({ name: 'unknown', memberSlots: ['a', 'b'] });
    const first = c.beginNavigation('a')!;
    c.updateNavigation(first, { timeMs: 500 });
    await frame();
    expect(b.seek).not.toHaveBeenCalled();
    expect(c.getSnapshot().groups[0].members[1].preview).toBe('on-release');
    c.endNavigation(first, { timeMs: 500 });
    await frame();
    b.seek.mockClear();
    const next = c.beginNavigation('a')!;
    c.updateNavigation(next, { timeMs: 600 });
    await frame();
    expect(b.seek).toHaveBeenCalledOnce();
    expect(b.seek.mock.calls[0][0].phase).toBe('preview');
  });
  it('uses current host time for LIVE even when all devices are quiet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { c, frame } = setup();
    const a = participant('a'),
      b = participant('b');
    c.registerParticipant(a.value);
    c.registerParticipant(b.value);
    const id = c.createGroup({
      name: 'live',
      memberSlots: ['a', 'b'],
      dragSyncPolicy: 'on-release',
    });
    await frame();
    c.setMode(id, 'live');
    const start = Date.now();
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(start);
    vi.advanceTimersByTime(500);
    expect(c.getSnapshot().groups[0].committedAnchor!.timeMs).toBeGreaterThan(
      start + 400,
    );
    expect(c.getSnapshot().groups[0].mode).toBe('live');
    c.beginNavigation('a');
    expect(c.getSnapshot().groups[0].mode).toBe('browse');
    const final = c.getSnapshot().groups[0].committedAnchor?.timeMs;
    vi.advanceTimersByTime(1000);
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(final);
  });
  it('restores with an already registered participant without sampling, rendering or replaying transport', async () => {
    const { c, frame } = setup();
    const a = participant('a');
    c.registerParticipant(a.value);
    c.restoreState({
      version: 1,
      groups: [
        {
          id: 'g',
          name: 'restore',
          color: '#abc',
          memberSlots: ['a'],
          mappings: [],
          dragSyncPolicy: 'auto',
        },
      ],
    });
    await frame();
    expect(a.seek).not.toHaveBeenCalled();
    expect(c.getSnapshot().groups[0]).toMatchObject({
      mode: 'browse',
      committedAnchor: null,
      previewAnchor: null,
    });
  });
  it('realigns only one member after local filtering without changing the common anchor', async () => {
    const { c, frame } = setup();
    const a = participant('a'),
      b = participant('b');
    c.registerParticipant(a.value);
    c.registerParticipant(b.value);
    const id = c.createGroup({ name: 'local', memberSlots: ['a', 'b'] });
    await frame();
    c.seek(id, 400);
    await frame();
    a.seek.mockClear();
    b.seek.mockClear();
    c.realign('b');
    await frame();
    expect(a.seek).not.toHaveBeenCalled();
    expect(b.seek).toHaveBeenCalledOnce();
    expect(c.getSnapshot().groups[0].committedAnchor?.timeMs).toBe(400);
  });
});
