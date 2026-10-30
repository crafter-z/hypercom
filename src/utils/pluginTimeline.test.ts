import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginTimeline } from './pluginTimeline';
import { timelineCoordinator } from './timeline/coordinator';
import type { TimelineSeekRequest } from './timeline/types';
import type { PluginViewBinding, PluginViewDeclaration, PluginViewHostMessage } from '../types/pluginViews';

const binding: PluginViewBinding = { tabId: 'tab', placement: 'workspace-tab', boundPortId: 'COM3', portMode: 'trx', pluginId: 'com.example.demo', installGeneration: 'install', viewId: 'table', tabSessionId: 'session', viewInstanceId: 'instance', workerEpoch: 1, streamEpoch: 7 };
const declaration: PluginViewDeclaration = { id: 'table', label: 'Table', entry: 'ui.js', styles: [], assets: [], modes: ['trx'], input: 'bytes', placements: ['workspace-tab'], portBinding: 'required', restoreOnStartup: false };
const lanes: PluginTimeline[] = [];
function lane(workerless = false, slotId = 'tab') {
  const sent: PluginViewHostMessage[] = [];
  const record = new PluginTimeline({ binding: workerless ? { ...binding, tabId: slotId, viewInstanceId: `instance-${slotId}`, workerEpoch: 0, boundPortId: null } : { ...binding, tabId: slotId, viewInstanceId: `instance-${slotId}` }, declaration: workerless ? { ...declaration, input: 'none', worker: false } : declaration, documentId: 'document', send: async message => { sent.push(message); } });
  lanes.push(record); record.setVisible(true);
  const generation = crypto.randomUUID();
  const send = (action: string, fields: object = {}) => record.receive({ action, capabilityGeneration: generation, ...fields });
  send('register', { registration: { version: 1, clock: workerless ? { kind: 'custom', id: 'uptime' } : { kind: 'bound-input' }, capabilities: { preview: 'bounded', canDrive: true } } });
  const participant = () => timelineCoordinator.participantForSlot(slotId)!;
  const request = (extra: Partial<TimelineSeekRequest> = {}): TimelineSeekRequest => ({ groupId: 'group', navigationEpoch: 1, gestureId: 'gesture', requestSeq: 1, phase: 'commit', mappingRevision: 2, participantGeneration: participant().generation, sourceGeneration: 7, timeMs: 1234, signal: new AbortController().signal, isCurrent: () => true, ...extra });
  const seek = (extra: Partial<TimelineSeekRequest> = {}) => Promise.resolve(participant().seek(request(extra)));
  const ack = (index = 0, result: object = { status: 'nearest', actualTimeMs: 1230 }) => send('ack', { requestId: sent.filter(m => m.type === 'timeline-seek')[index].timeline!.requestId, result });
  return { record, sent, generation, send, participant, seek, ack };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { lanes.splice(0).forEach(l => l.dispose()); timelineCoordinator.getSnapshot().groups.forEach(g => timelineCoordinator.deleteGroup(g.id)); vi.useRealTimers(); });

describe('host plugin timeline adapter', () => {
  it('binds identity/clock from host input and only completes after the corresponding applied ACK', async () => {
    const l = lane(); expect(l.participant()).toMatchObject({ slotId: 'tab', sourceId: 'serial:COM3', clockId: 'host-epoch-ms', sourceKind: 'live', sourceGeneration: 7 });
    let done = false; const result = l.seek(); void result.then(() => { done = true; }); await settle();
    expect(done).toBe(false); expect(l.sent[0]).toMatchObject({ type: 'timeline-seek', documentId: 'document', timeline: { mappingRevision: 2, sourceGeneration: 7, timeMs: 1234 } });
    l.send('ack', { requestId: 'stale', result: { status: 'exact', actualTimeMs: 100 } }); await settle(); expect(done).toBe(false);
    l.ack(); await expect(result).resolves.toEqual({ status: 'nearest', actualTimeMs: 1230 });
    expect(l.participant().readAnchor()).toEqual({ timeMs: 1230 });
  });
  it('supports worker:false custom clocks without claiming a shared host clock', async () => {
    const l = lane(true);
    expect(l.participant()).toMatchObject({ sourceKind: 'custom', clockId: 'plugin:com.example.demo:install:uptime' });
    const result = l.seek(); l.ack(); await expect(result).resolves.toMatchObject({ status: 'nearest' });
    expect(() => l.record.receive({ action: 'register', capabilityGeneration: crypto.randomUUID(), registration: { version: 1, clock: { kind: 'bound-input' }, capabilities: { preview: 'bounded', canDrive: true } } })).toThrow('host input clock');
  });
  it('keeps one physical request plus one latest commit and suppresses stale results after cancellation', async () => {
    const l = lane(); const first = l.seek({ phase: 'preview' }); const second = l.seek({ phase: 'preview', requestSeq: 2 }); const final = l.seek({ timeMs: 9000, requestSeq: 3 });
    await expect(first).resolves.toMatchObject({ status: 'held' }); await expect(second).resolves.toMatchObject({ status: 'held' });
    expect(l.sent.filter(m => m.type === 'timeline-seek')).toHaveLength(1);
    l.ack(0, { status: 'exact', actualTimeMs: 1234 }); await settle();
    expect(l.participant().readAnchor()).toBeNull(); expect(l.sent.filter(m => m.type === 'timeline-seek')).toHaveLength(2);
    l.ack(1, { status: 'exact', actualTimeMs: 9000 }); await expect(final).resolves.toMatchObject({ actualTimeMs: 9000 });
  });
  it('marks a stalled member slow, retains the physical slot, and lets a healthy view continue', async () => {
    const l = lane(); const result = l.seek({ phase: 'preview' });
    await vi.advanceTimersByTimeAsync(150); await expect(result).resolves.toEqual({ status: 'slow', actualTimeMs: null });
    expect(timelineCoordinator.participantForSlot('tab')).toBeDefined();
    const final = l.seek(); expect(l.sent.filter(m => m.type === 'timeline-seek')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); await expect(final).resolves.toMatchObject({ status: 'slow' });
    // The old callback has not stopped merely because its waiter expired.
    l.ack(); expect(l.sent.filter(m => m.type === 'timeline-seek')).toHaveLength(1);
    const healthy = l.seek(); l.ack(1); await expect(healthy).resolves.toMatchObject({ status: 'nearest' });
  });
  it('never lets a non-settling plugin callback block an independent healthy view', async () => {
    const slow = lane(false, 'slow-view'); const fast = lane(false, 'healthy-view');
    const stalled = slow.seek({ phase: 'preview' });
    await vi.advanceTimersByTimeAsync(150); await expect(stalled).resolves.toMatchObject({ status: 'slow' });
    const healthy = fast.seek({ timeMs: 777 }); fast.ack(0, { status: 'exact', actualTimeMs: 777 });
    await expect(healthy).resolves.toMatchObject({ status: 'exact', actualTimeMs: 777 });
    expect(slow.sent.filter(m => m.type === 'timeline-seek')).toHaveLength(1);
    expect(slow.participant()).toBeDefined(); expect(fast.participant().readAnchor()).toEqual({ timeMs: 777 });
  });
  it('handles cooperative AbortSignal without releasing the physical callback until ACK', async () => {
    const l = lane(); const controller = new AbortController(); const pending = l.seek({ signal: controller.signal }); controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'held' }); expect(l.sent.some(m => m.type === 'timeline-cancel')).toBe(true);
    const next = l.seek({ timeMs: 2000 }); l.ack(); l.ack(1, { status: 'exact', actualTimeMs: 2000 }); await expect(next).resolves.toMatchObject({ actualTimeMs: 2000 });
  });
  it('does not apply hidden history; capability replacement and disposal invalidate old ACKs', async () => {
    const l = lane(); const pending = l.seek(); l.record.setVisible(false); await expect(pending).resolves.toMatchObject({ status: 'held' });
    const hidden = l.seek(); await expect(hidden).resolves.toMatchObject({ status: 'held' });
    l.record.setVisible(true); const oldId = l.participant().participantId;
    const generation = crypto.randomUUID(); l.record.receive({ action: 'register', capabilityGeneration: generation, registration: { version: 1, clock: { kind: 'bound-input' }, capabilities: { preview: 'commit-only', canDrive: false } } });
    expect(l.participant().participantId).not.toBe(oldId); l.ack(); expect(l.participant().readAnchor()).toBeNull();
    l.record.dispose(); expect(timelineCoordinator.participantForSlot('tab')).toBeUndefined();
  });
  it('bridges explicit begin/update/final anchor and refuses stale gesture ends', () => {
    const l = lane(); const group = timelineCoordinator.createGroup({ name: 'Group', memberSlots: ['tab'], dragSyncPolicy: 'on-release' });
    const gesture = crypto.randomUUID(); l.send('begin', { gestureId: gesture, intent: 'align' });
    l.send('update', { gestureId: gesture, anchor: { timeMs: 5000 } });
    expect(timelineCoordinator.groupForSlot('tab')?.previewAnchor).toEqual({ timeMs: 5000 });
    l.send('end', { gestureId: crypto.randomUUID(), anchor: { timeMs: 0 } });
    expect(timelineCoordinator.groupForSlot('tab')?.committedAnchor).toBeNull();
    l.send('end', { gestureId: gesture, anchor: { timeMs: 6000, recordKey: 'last' } });
    expect(timelineCoordinator.getSnapshot().groups.find(g => g.id === group)?.committedAnchor).toEqual({ timeMs: 6000, recordKey: 'last' });
  });
  it('rejects forged capabilities and malformed summaries without trusting page identities', () => {
    const l = lane();
    expect(() => l.send('availability', { availability: { available: true, range: { startMs: 2, endMs: 1 } } })).toThrow('range');
    expect(() => l.send('capabilities', { capabilities: { preview: 'unbounded', canDrive: true } })).toThrow('capabilities');
    l.send('availability', { availability: { available: false } });
    expect(l.participant().availability?.available).toBe(false);
  });
});
