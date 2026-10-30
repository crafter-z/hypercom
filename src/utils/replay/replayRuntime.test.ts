import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileService, type ReplayPickedSources } from '../../services/file';
import { getActivePortId, getTabPortId, useAppStore } from '../../stores/useAppStore';
import { resetStoresForTests } from '../../stores/resetStores';
import { timelineCoordinator } from '../timeline/coordinator';
import { importReplaySources, openReplaySession, closeReplayTab, getReplayTransport, getReplayTimeRange, getReplayDisplayTime, pauseReplayAtGroup, toggleReplayTransport, seekReplayTransport, exportReplayDescriptions, restoreReplayDescriptions, getReplaySession, selectReplaySegment, replaySourceId, type ReplaySession } from './replayRuntime';
vi.mock('../../services/file', () => ({ fileService: { readReplaySourceChunk: vi.fn(), releaseReplaySources: vi.fn(async () => {}) } }));
const text = new Map<string, string>();
function picked(...files: Array<[string, string]>): ReplayPickedSources {
  return { grantId: crypto.randomUUID(), sources: files.map(([sourceId, content]) => { text.set(sourceId, content); return { sourceId, name: `${sourceId}.log`, path: `C:/${sourceId}.log`, size: new TextEncoder().encode(content).length, fingerprint: 'a'.repeat(64) }; }) };
}
async function importFiles(selection: ReplayPickedSources): Promise<ReplaySession> {
  return importReplaySources(selection, selection.sources.map(source => ({ title: source.name, sourceIds: [source.sourceId], options: { encoding: 'UTF-8', format: 'text', timezoneOffsetMinutes: 0 } })), new AbortController().signal);
}
function register(tabId: string, session: ReplaySession) {
  const tab = useAppStore.getState().tabs.find(t => t.id === tabId)!;
  if (tab.kind !== 'replay') throw new Error('replay required');
  return timelineCoordinator.registerParticipant({ participantId: `p:${tabId}`, slotId: tabId, sourceId: replaySourceId(tab.sessionId, tab.trackId), generation: 1, sourceGeneration: 1, sourceKind: 'replay', clockId: `replay:${tab.sessionId}`, capabilities: { preview: 'bounded', canDrive: true }, readAnchor: () => ({ timeMs: session.clock.getSnapshot().timeMs }), seek: request => ({ status: 'nearest', actualTimeMs: request.timeMs }), onUserNavigation: () => pauseReplayAtGroup(session, tabId) });
}
beforeEach(() => {
  resetStoresForTests(); vi.clearAllMocks(); text.clear();
  vi.mocked(fileService.readReplaySourceChunk).mockImplementation(async (_grant, id, offset) => {
    const bytes = new TextEncoder().encode(text.get(id) ?? '');
    const part = bytes.slice(offset, offset + 7); // deliberately split timestamps and UTF-8 codepoints
    return { base64: btoa(String.fromCharCode(...part)), nextOffset: offset + part.length, done: offset + part.length === bytes.length };
  });
});
afterEach(() => {
  for (const tab of [...useAppStore.getState().tabs]) if (tab.kind === 'replay') { closeReplayTab(tab.id); useAppStore.getState().closeTab(tab.id); }
  timelineCoordinator.restoreState({ version: 1, groups: [] });
  vi.useRealTimers();
});
describe('independent replay runtime', () => {
  it('imports explicit ordered shards without fabricated blank rows or real-port identities', async () => {
    const selection = picked(['a', 'RX one\n'], ['b', 'TX 中'], ['c', 'RX third\n']);
    const session = await importReplaySources(selection, [{ title: 'joined', sourceIds: ['b', 'a'], options: { encoding: 'UTF-8', format: 'text' } }, { title: 'separate', sourceIds: ['c'], options: { encoding: 'UTF-8', format: 'text' } }], new AbortController().signal);
    expect([...session.tracks.values()][0].document.snapshot().map(line => line.content)).toEqual(['中', 'one']);
    const ids = openReplaySession(session);
    expect(ids).toHaveLength(2); expect(useAppStore.getState().ports).toEqual([]);
    expect(getTabPortId(useAppStore.getState().tabs[0])).toBeNull(); expect(getActivePortId(useAppStore.getState())).toBeNull();
    expect(fileService.releaseReplaySources).toHaveBeenCalledWith(selection.grantId);
  });
  it('shares exactly one group clock across tracks and across imported sessions', async () => {
    const a = await importFiles(picked(['a', '[2026-01-01 00:00:00Z] RX a\n[2026-01-01 00:00:20Z] RX end']));
    const b = await importFiles(picked(['b', '[2026-01-01 00:00:05Z] RX b\n[2026-01-01 00:00:30Z] RX end']));
    const [aid] = openReplaySession(a), [bid] = openReplaySession(b);
    const ah = register(aid, a), bh = register(bid, b);
    const group = timelineCoordinator.groupForSlot(aid)!; timelineCoordinator.addMember(group.id, bid);
    timelineCoordinator.setMapping(group.id, { sourceId: timelineCoordinator.participantForSlot(bid)!.sourceId, sourceTimeMs: 0, groupTimeMs: 0 });
    const clock = getReplayTransport(aid);
    expect(getReplayTransport(bid)).toBe(clock); expect(clock).not.toBe(a.clock); expect(clock).not.toBe(b.clock);
    expect(getReplayTimeRange(aid)).toEqual({ start: Date.parse('2026-01-01T00:00:00Z'), end: Date.parse('2026-01-01T00:00:30Z') });
    ah.dispose(); bh.dispose();
  });
  it('navigation pause never commits the old cursor or steals a new gesture', async () => {
    const session = await importFiles(picked(['a', '[2026-01-01 00:00:00Z] RX a\n[2026-01-01 01:00:00Z] RX end']));
    const [id] = openReplaySession(session), handle = register(id, session);
    const clock = getReplayTransport(id)!;
    toggleReplayTransport(id); expect(clock.getSnapshot().playing).toBe(true);
    const token = timelineCoordinator.beginNavigation(handle.participantId)!;
    const group = timelineCoordinator.groupForSlot(id)!;
    expect(clock.getSnapshot().playing).toBe(false); expect(group.ownerParticipantId).toBe(handle.participantId);
    timelineCoordinator.updateNavigation(token, { timeMs: Date.parse('2026-01-01T00:20:00Z') });
    timelineCoordinator.endNavigation(token, { timeMs: Date.parse('2026-01-01T00:20:00Z') });
    expect(timelineCoordinator.groupForSlot(id)?.committedAnchor?.timeMs).toBe(Date.parse('2026-01-01T00:20:00Z'));
    handle.dispose();
  });
  it('displays group preview/commit after external seek while leaving the paused clock untouched', async () => {
    const session = await importFiles(picked(['a', '[2026-01-01 00:00:00Z] RX a\n[2026-01-01 01:00:00Z] RX end']));
    const [id] = openReplaySession(session), handle = register(id, session);
    const clock = getReplayTransport(id)!, oldCursor = clock.getSnapshot().timeMs;
    const group = timelineCoordinator.groupForSlot(id)!;
    const target = oldCursor + 20_000;
    timelineCoordinator.seek(group.id, target, 'commit');
    expect(getReplayDisplayTime(id)).toBe(target);
    expect(clock.getSnapshot().timeMs).toBe(oldCursor);
    timelineCoordinator.seek(group.id, target + 1000, 'preview');
    expect(getReplayDisplayTime(id)).toBe(target + 1000);
    expect(clock.getSnapshot().timeMs).toBe(oldCursor);
    const token = timelineCoordinator.beginNavigation(handle.participantId)!;
    timelineCoordinator.updateNavigation(token, { timeMs: target + 2000 });
    expect(getReplayDisplayTime(id)).toBe(target + 2000);
    timelineCoordinator.endNavigation(token, { timeMs: target + 3000 });
    expect(getReplayDisplayTime(id)).toBe(target + 3000);
    expect(clock.getSnapshot().timeMs).toBe(oldCursor);
    timelineCoordinator.setMapping(group.id, { sourceId: timelineCoordinator.participantForSlot(id)!.sourceId, sourceTimeMs: oldCursor, groupTimeMs: 0 });
    timelineCoordinator.seek(group.id, 0);
    expect(getReplayDisplayTime(id)).toBe(0);
    handle.dispose();
  });
  it('uses union range, preserves long gaps, seeks once and invalidates clocks on remapping', async () => {
    const session = await importFiles(picked(['a', '[2026-01-01 00:00:00Z] RX a\n[2026-01-02 00:00:00Z] RX b']));
    const [id] = openReplaySession(session), handle = register(id, session);
    const clock = getReplayTransport(id)!;
    const middle = Date.parse('2026-01-01T12:00:00Z'); seekReplayTransport(id, middle);
    expect(clock.getSnapshot().timeMs).toBe(middle); expect(timelineCoordinator.groupForSlot(id)?.committedAnchor?.timeMs).toBe(middle);
    const group = timelineCoordinator.groupForSlot(id)!;
    timelineCoordinator.setMapping(group.id, { sourceId: timelineCoordinator.participantForSlot(id)!.sourceId, sourceTimeMs: 0, groupTimeMs: 100 });
    expect(getReplayTransport(id)).not.toBe(clock); handle.dispose();
  });
  it('requires segment selection for rollback tracks and retains whole original history', async () => {
    const session = await importFiles(picked(['a', '[2026-01-01 00:00:02Z] RX a\n[2026-01-01 00:00:01Z] RX b']));
    const [id] = openReplaySession(session), track = [...session.tracks.values()][0];
    expect(getReplayTimeRange(id)).toBeNull();
    selectReplaySegment(session.description.id, track.description.id, 1);
    expect(getReplayTimeRange(id)).toMatchObject({ start: Date.parse('2026-01-01T00:00:01Z') });
    expect(track.document.length).toBe(2); expect(exportReplayDescriptions().find(d => d.id === session.description.id)?.tracks[0].selectedSegment).toBe(1);
  });
  it('restores only missing/paused descriptors without opening files or ports', () => {
    const descriptor = { id: 'missing', name: 'missing', tracks: [{ id: 'track', title: 'file', files: [{ path: 'C:/file', name: 'file', size: 1, fingerprint: 'a'.repeat(64) }], options: { encoding: 'UTF-8' as const, format: 'text' as const } }] };
    restoreReplayDescriptions([descriptor]);
    const session = getReplaySession('missing')!; expect(session.missing).toBe(true); expect(session.clock.getSnapshot().playing).toBe(false); expect(session.tracks.size).toBe(0);
    const id = useAppStore.getState().addReplayTab({ sessionId: descriptor.id, trackId: 'track', title: 'file' });
    expect(getReplayTransport(id)).toBeNull(); expect(fileService.readReplaySourceChunk).not.toHaveBeenCalled();
  });
  it('rejects duplicate shard assignment and publishes no partial session on failure', async () => {
    const selection = picked(['a', 'hello']);
    await expect(importReplaySources(selection, [{ title: 'bad', sourceIds: ['a', 'a'], options: { encoding: 'UTF-8', format: 'text' } }], new AbortController().signal)).rejects.toThrow('exactly one');
    expect(useAppStore.getState().tabs).toHaveLength(0); expect(fileService.releaseReplaySources).toHaveBeenCalledWith(selection.grantId);
  });
});
