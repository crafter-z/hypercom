import { fileService, type ReplayPickedSources, type ReplaySourceDescriptor } from '../../services/file';
import { useAppStore } from '../../stores/useAppStore';
import { createDecoder } from '../lineText';
import { ReplayClock } from '../timeline/ReplayClock';
import { timelineCoordinator } from '../timeline/coordinator';
import { toGroupTime, type TimelineGroupSnapshot } from '../timeline/types';
import { ReplayDocument, REPLAY_LIMITS, type ReplayImportOptions, type ReplayBudget } from './ReplayDocument';

export interface ReplayFileDescription { name: string; path: string; size: number; fingerprint: string }
export interface ReplayTrackDescription { id: string; title: string; files: ReplayFileDescription[]; options: ReplayImportOptions; selectedSegment?: number }
export interface ReplaySessionDescription { id: string; name: string; tracks: ReplayTrackDescription[] }
export interface ReplayTrack { description: ReplayTrackDescription; document: ReplayDocument }
export interface ReplaySession { description: ReplaySessionDescription; tracks: Map<string, ReplayTrack>; clock: ReplayClock; groupId?: string; missing?: boolean }
const sessions = new Map<string, ReplaySession>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = () => { revision++; for (const listener of listeners) listener(); };
export const subscribeReplay = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getReplayRevision = (): number => revision;
export const getReplaySession = (id: string): ReplaySession | undefined => sessions.get(id);
export const replaySourceId = (sessionId: string, trackId: string, segment?: number): string => `replay:${sessionId}:${trackId}${segment === undefined ? '' : `:segment-${segment}`}`;
export function exportReplayDescriptions(): ReplaySessionDescription[] { return [...sessions.values()].map(s => s.description); }

async function* readChunks(picked: ReplayPickedSources, source: ReplaySourceDescriptor, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = createDecoder('UTF-8');
  let offset = 0;
  while (true) {
    if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
    const chunk = await fileService.readReplaySourceChunk(picked.grantId, source.sourceId, offset);
    if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
    if (chunk.nextOffset < offset || chunk.nextOffset > source.size || (!chunk.done && chunk.nextOffset === offset)) throw new Error('Invalid replay transport offset');
    const bytes = Uint8Array.from(atob(chunk.base64), char => char.charCodeAt(0));
    if (chunk.nextOffset - offset !== bytes.length) throw new Error('Invalid replay transport length');
    yield decoder.decode(bytes, { stream: !chunk.done });
    offset = chunk.nextOffset;
    if (chunk.done) { if (offset !== source.size) throw new Error('Replay source was truncated'); break; }
  }
}
/** Explicit ordered shards, never filename-based automatic merging. */
export interface ReplayTrackPlan { title: string; sourceIds: string[]; options: ReplayImportOptions }
export async function importReplaySources(picked: ReplayPickedSources, plans: ReplayTrackPlan[], signal: AbortSignal, replacing?: ReplaySessionDescription): Promise<ReplaySession> {
  try {
    if (!plans.length || plans.length > REPLAY_LIMITS.maxFiles) throw new Error('Select between 1 and 16 replay tracks');
    const allIds = plans.flatMap(p => p.sourceIds);
    if (new Set(allIds).size !== allIds.length || allIds.length !== picked.sources.length) throw new Error('Every selected source must belong to exactly one ordered track');
    if (picked.sources.some(s => s.size > REPLAY_LIMITS.fileBytes) || picked.sources.reduce((n, s) => n + s.size, 0) > REPLAY_LIMITS.sessionBytes) throw new Error('Replay file budget exceeded');
    const budget: ReplayBudget = { records: 0, decodedBytes: 0 };
    const id = replacing?.id ?? crypto.randomUUID(), tracks = new Map<string, ReplayTrack>();
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      if (plan.options.encoding !== 'UTF-8' || !['text', 'hex'].includes(plan.options.format)) throw new Error('Only UTF-8 text and HEX text are supported');
      const sources = plan.sourceIds.map(sourceId => { const source = picked.sources.find(s => s.sourceId === sourceId); if (!source) throw new Error('Missing replay source'); return source; });
      if (!sources.length) throw new Error('Replay track cannot be empty');
      const previous = replacing?.tracks[i];
      const description: ReplayTrackDescription = { id: previous?.id ?? crypto.randomUUID(), title: plan.title, files: sources.map(({ name, path, size, fingerprint }) => ({ name, path, size, fingerprint })), options: { ...plan.options }, ...(previous?.selectedSegment === undefined ? {} : { selectedSegment: previous.selectedSegment }) };
      async function* shards() {
        for (const source of sources) {
          let final = '', nonempty = false;
          for await (const chunk of readChunks(picked, source, signal)) { if (chunk) { final = chunk.slice(-1); nonempty = true; } yield chunk; }
          // A shard boundary ends a record, but must not fabricate a blank row.
          if (nonempty && final !== '\n' && final !== '\r') yield '\n';
        }
      }
      const document = await ReplayDocument.fromChunks(shards(), plan.options, signal, budget);
      if (description.selectedSegment !== undefined && !document.segments[description.selectedSegment]) delete description.selectedSegment;
      tracks.set(description.id, { description, document });
    }
    if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
    const timed = [...tracks.values()].filter(t => t.document.startTimeMs !== null);
    const start = timed.length ? Math.min(...timed.map(t => t.document.startTimeMs!)) : 0;
    const end = timed.length ? Math.max(...timed.map(t => t.document.endTimeMs!)) : 0;
    const description = { id, name: replacing?.name ?? plans[0].title, tracks: [...tracks.values()].map(t => t.description) };
    const session: ReplaySession = { description, tracks, clock: new ReplayClock({ startTimeMs: start, endTimeMs: end }) };
    session.clock.subscribe(publish); // fallback UI cursor only; never drives a group
    sessions.get(id)?.clock.dispose(); sessions.set(id, session); publish();
    return session;
  } finally { await fileService.releaseReplaySources(picked.grantId).catch(error => console.debug('[replay] grant release failed', error)); }
}
export function openReplaySession(session: ReplaySession): string[] {
  const tracks = [...session.tracks.values()];
  const ids = tracks.map((track, i) => useAppStore.getState().addReplayTab({ sessionId: session.description.id, trackId: track.description.id, title: track.description.title }, { activate: i === 0 }));
  const timedIds = ids.filter((_, i) => tracks[i].document.knownTimeCount > 0 && tracks[i].document.segments.length <= 1);
  if (timedIds.length) session.groupId = timelineCoordinator.createGroup({ name: session.description.name, memberSlots: timedIds, anchor: { timeMs: session.clock.getSnapshot().timeMs } });
  return ids;
}
export function restoreReplayDescriptions(descriptions: ReplaySessionDescription[]): void {
  for (const description of descriptions) if (!sessions.has(description.id)) sessions.set(description.id, { description, tracks: new Map(), clock: new ReplayClock({ startTimeMs: 0, endTimeMs: 0 }), missing: true });
  publish();
}
export function closeReplayTab(tabId: string): void {
  const state = useAppStore.getState(), tab = state.tabs.find(t => t.id === tabId);
  if (tab?.kind !== 'replay') return;
  timelineCoordinator.removeMember(tabId);
  if (!state.tabs.some(t => t.kind === 'replay' && t.sessionId === tab.sessionId && t.id !== tabId)) { sessions.get(tab.sessionId)?.clock.dispose(); sessions.delete(tab.sessionId); publish(); }
}
export function selectReplaySegment(sessionId: string, trackId: string, segment: number | undefined): void {
  const track = sessions.get(sessionId)?.tracks.get(trackId);
  if (!track || (segment !== undefined && !track.document.segments[segment])) return;
  track.description.selectedSegment = segment;
  for (const tab of useAppStore.getState().tabs) if (tab.kind === 'replay' && tab.sessionId === sessionId && tab.trackId === trackId) invalidateGroupClock(timelineCoordinator.groupForSlot(tab.id)?.id);
  publish();
}
function trackRange(sessionId: string, trackId: string): { start: number; end: number; sourceId: string } | null {
  const track = sessions.get(sessionId)?.tracks.get(trackId); if (!track) return null;
  const segmentIndex = track.description.selectedSegment;
  const segment = segmentIndex === undefined ? undefined : track.document.segments[segmentIndex];
  if (track.document.segments.length > 1 && !segment) return null;
  const start = segment ? segment.startTimeMs : track.document.startTimeMs, end = segment ? segment.endTimeMs : track.document.endTimeMs;
  return start === null || end === null ? null : { start, end, sourceId: replaySourceId(sessionId, trackId, segmentIndex) };
}
function groupRange(group: TimelineGroupSnapshot): { start: number; end: number } | null {
  const state = useAppStore.getState(), ranges: Array<{ start: number; end: number }> = [];
  for (const slot of group.memberSlots) {
    const member = state.tabs.find(t => t.id === slot);
    if (member?.kind !== 'replay') return null; // mixed groups are browse-only
    const range = trackRange(member.sessionId, member.trackId); if (!range) return null;
    const mapping = group.mappings.find(m => m.sourceId === range.sourceId);
    ranges.push({ start: toGroupTime(range.start, mapping), end: toGroupTime(range.end, mapping) });
  }
  return ranges.length ? { start: Math.min(...ranges.map(r => r.start)), end: Math.max(...ranges.map(r => r.end)) } : null;
}
export function getReplayTimeRange(tabId: string): { start: number; end: number } | null {
  const tab = useAppStore.getState().tabs.find(t => t.id === tabId); if (tab?.kind !== 'replay') return null;
  const group = timelineCoordinator.groupForSlot(tabId); return group ? groupRange(group) : trackRange(tab.sessionId, tab.trackId);
}
interface GroupClock { clock: ReplayClock; signature: string; topology: string; suppress: boolean }
const groupClocks = new Map<string, GroupClock>();
function invalidateGroupClock(id: string | undefined): void { if (!id) return; groupClocks.get(id)?.clock.dispose(); groupClocks.delete(id); }
export function getReplayTransport(tabId: string): ReplayClock | null {
  const tab = useAppStore.getState().tabs.find(t => t.id === tabId); if (tab?.kind !== 'replay') return null;
  const session = sessions.get(tab.sessionId), group = timelineCoordinator.groupForSlot(tabId);
  if (!session || session.missing) return null;
  if (!group) return session.clock;
  const range = groupRange(group); if (!range) { invalidateGroupClock(group.id); return null; }
  const topology = JSON.stringify([group.memberSlots, group.mappings]);
  const signature = JSON.stringify([topology, range]);
  let entry = groupClocks.get(group.id);
  if (!entry || entry.signature !== signature) {
    invalidateGroupClock(group.id);
    const clock = new ReplayClock({ startTimeMs: range.start, endTimeMs: range.end });
    if (group.committedAnchor) clock.seek(group.committedAnchor.timeMs);
    const created: GroupClock = { clock, signature, topology, suppress: false };
    let wasPlaying = false;
    clock.subscribe(() => {
      const current = clock.getSnapshot();
      if (!created.suppress) {
        if (current.playing) timelineCoordinator.seek(group.id, current.timeMs, 'preview');
        else if (wasPlaying && current.timeMs === range.end) timelineCoordinator.seek(group.id, current.timeMs, 'commit');
      }
      wasPlaying = current.playing; publish();
    });
    entry = created; groupClocks.set(group.id, entry);
  }
  return entry.clock;
}
/** Display follows the authoritative group axis, not a paused transport's stale cursor. */
export function getReplayDisplayTime(tabId: string): number | null {
  const group = timelineCoordinator.groupForSlot(tabId);
  return (group?.previewAnchor ?? group?.committedAnchor)?.timeMs ?? getReplayTransport(tabId)?.getSnapshot().timeMs ?? null;
}
/** User navigation only stops transport. It never seeks/commits an old clock cursor. */
export function pauseReplayAtGroup(session: ReplaySession, tabId: string): void {
  const group = timelineCoordinator.groupForSlot(tabId), entry = group ? groupClocks.get(group.id) : undefined;
  if (entry) { entry.suppress = true; entry.clock.pause(); entry.suppress = false; } else session.clock.pause();
}
function ensureReplayGroup(tabId: string): void {
  if (timelineCoordinator.groupForSlot(tabId)) return;
  const tab = useAppStore.getState().tabs.find(t => t.id === tabId); if (tab?.kind !== 'replay') return;
  const range = trackRange(tab.sessionId, tab.trackId); if (!range) return;
  timelineCoordinator.createGroup({ name: tab.title, memberSlots: [tabId], anchor: { timeMs: range.start } });
}
export function seekReplayTransport(tabId: string, timeMs: number): void {
  ensureReplayGroup(tabId);
  const clock = getReplayTransport(tabId); if (!clock) return;
  clock.pause(); clock.seek(timeMs);
  const group = timelineCoordinator.groupForSlot(tabId);
  if (group) timelineCoordinator.seek(group.id, clock.getSnapshot().timeMs, 'commit');
  publish();
}
export function toggleReplayTransport(tabId: string): void {
  ensureReplayGroup(tabId);
  const clock = getReplayTransport(tabId); if (!clock) return;
  const group = timelineCoordinator.groupForSlot(tabId);
  if (clock.getSnapshot().playing) { clock.pause(); if (group) timelineCoordinator.seek(group.id, clock.getSnapshot().timeMs, 'commit'); }
  else { if (group) { if (group.committedAnchor) clock.seek(group.committedAnchor.timeMs); timelineCoordinator.setMode(group.id, 'playback'); } clock.play(); }
  publish();
}
// Membership, mapping and source changes retire old clocks before another tick.
timelineCoordinator.subscribe(() => {
  for (const [id, entry] of groupClocks) {
    const group = timelineCoordinator.getSnapshot().groups.find(g => g.id === id);
    if (!group || JSON.stringify([group.memberSlots, group.mappings]) !== entry.topology) invalidateGroupClock(id);
    else if (group.mode !== 'playback' && entry.clock.getSnapshot().playing) { entry.suppress = true; entry.clock.pause(); entry.suppress = false; }
  }
});
