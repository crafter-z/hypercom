import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sdkSource from '../../src-tauri/src/plugin/view_runtime/sdk.js?raw';
import type { PluginTimelineAnchor, PluginTimelineResult, PluginTimelineSeek } from '../types/pluginViews';

type Wire = Record<string, unknown> & { type: string; documentId?: string; payload?: Record<string, unknown> };
interface TimelineHandle {
  dispose(): void;
  updateCapabilities(value: { preview: string; canDrive: boolean }): void;
  setAvailability(value: { available: boolean; range?: { startMs: number; endMs: number } }): void;
  beginNavigation(intent: string): { update(anchor: PluginTimelineAnchor): void; end(anchor?: PluginTimelineAnchor): void; cancel(): void };
}
function page(hasWorker = false, start = true) {
  const sent: Wire[] = [];
  const scope = { ipc: { postMessage: (encoded: string) => sent.push(JSON.parse(encoded)) } } as unknown as {
    view: { timeline: { register: (options: object) => TimelineHandle }; onState(cb: () => unknown): void; send(type: string, payload: unknown): void };
    __hypercomViewDocumentStart(id: string): void;
    __hypercomViewDispatch(message: Wire): void;
  };
  const source = sdkSource.replace('__HOST_TRUSTED_WEB__', 'true').replace('__HOST_HAS_WORKER__', String(hasWorker)).replace('__HOST_VIEW_CONTEXT__', JSON.stringify({ viewInstanceId: 'instance', boundPortId: hasWorker ? 'COM3' : null }));
  new Function('globalThis', 'addEventListener', source)(scope, () => {});
  if (start) scope.__hypercomViewDocumentStart('doc');
  const dispatch = (message: Wire) => scope.__hypercomViewDispatch({ documentId: 'doc', ...message });
  dispatch({ type: 'init', context: { viewInstanceId: 'instance', boundPortId: hasWorker ? 'COM3' : null }, environment: {} });
  const controls = () => sent.filter(m => m.type === 'timeline').map(m => m.payload!);
  const register = (onSeek: (request: PluginTimelineSeek & { signal: AbortSignal }) => PluginTimelineResult | Promise<PluginTimelineResult>, capabilities = { preview: 'bounded', canDrive: true }) => {
    const handle = scope.view.timeline.register({ version: 1, clock: { kind: 'custom', id: 'device' }, capabilities, onSeek });
    const messages = controls();
    const generation = messages[messages.length - 1]!.capabilityGeneration as string;
    return { handle, generation };
  };
  const seek = (generation: string, requestId: string, phase = 'preview', extra = {}) => dispatch({ type: 'timeline-seek', timeline: { capabilityGeneration: generation, requestId, phase, timeMs: 123, navigationEpoch: 1, ...extra } });
  return { scope, sent, dispatch, controls, register, seek };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('independent optional timeline page lane', () => {
  it('announces pre-ready registration and only the latest availability/capabilities summary', async () => {
    const p = page(false, false);
    const handle = p.scope.view.timeline.register({ version: 1, clock: { kind: 'custom', id: 'device' }, capabilities: { preview: 'bounded', canDrive: true }, onSeek: () => ({ status: 'no-time' }) });
    handle.setAvailability({ available: true, range: { startMs: 1, endMs: 10 } });
    handle.setAvailability({ available: true, range: { startMs: 2, endMs: 20 } });
    handle.updateCapabilities({ preview: 'commit-only', canDrive: false });
    expect(p.sent).toHaveLength(0);
    p.scope.__hypercomViewDocumentStart('doc'); await settle();
    expect(p.controls()).toEqual([
      expect.objectContaining({ action: 'register', registration: expect.objectContaining({ capabilities: { preview: 'commit-only', canDrive: false } }) }),
      expect.objectContaining({ action: 'availability', availability: { available: true, range: { startMs: 2, endMs: 20 } } }),
    ]);
    handle.setAvailability({ available: true, range: { startMs: 2, endMs: 20 } });
    handle.updateCapabilities({ preview: 'commit-only', canDrive: false });
    expect(p.controls()).toHaveLength(2);
  });
  it('works without a Worker and does not queue behind a stalled state callback', async () => {
    const p = page(); await settle();
    expect(() => p.scope.view.send('message', null)).toThrow('no Worker');
    p.scope.view.onState(() => new Promise(() => {}));
    p.dispatch({ type: 'state', revision: 1, snapshot: {} }); await settle();
    const callback = vi.fn(async () => ({ status: 'nearest' as const, actualTimeMs: 120 }));
    const { generation } = p.register(callback);
    p.seek(generation, 'seek-1', 'commit'); await settle();
    expect(callback).toHaveBeenCalledOnce();
    expect(p.controls()).toContainEqual(expect.objectContaining({ action: 'ack', requestId: 'seek-1', result: { status: 'nearest', actualTimeMs: 120 } }));
    expect(p.sent.some(m => m.type === 'state-ack')).toBe(false);
  });
  it('coalesces source updates and delivers the final anchor immediately despite preview throttle', async () => {
    const p = page(); await settle(); const { handle } = p.register(() => ({ status: 'exact' }));
    const navigation = handle.beginNavigation('scrollbar');
    for (let i = 0; i < 10000; i++) navigation.update({ timeMs: i, recordKey: String(i) });
    expect(p.controls().filter(m => m.action === 'update')).toHaveLength(0);
    navigation.end();
    expect(p.controls().filter(m => m.action === 'end')).toEqual([expect.objectContaining({ anchor: { timeMs: 9999, recordKey: '9999' } })]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.controls().filter(m => m.action === 'update')).toHaveLength(0);
    navigation.end({ timeMs: 0 }); expect(p.controls().filter(m => m.action === 'end')).toHaveLength(1);
  });
  it('holds one active callback and one latest target, cooperatively aborts, and preserves commit', async () => {
    const p = page(); await settle(); let finish!: (v: PluginTimelineResult) => void;
    const requests: Array<PluginTimelineSeek & { signal: AbortSignal }> = [];
    const { generation } = p.register(request => { requests.push(request); return requests.length === 1 ? new Promise(resolve => { finish = resolve; }) : { status: 'exact', actualTimeMs: request.timeMs }; });
    p.seek(generation, 'one'); await settle();
    for (let i = 0; i < 1000; i++) p.seek(generation, `preview-${i}`);
    p.seek(generation, 'final', 'commit', { timeMs: 999 }); p.seek(generation, 'late-preview'); await settle();
    expect(requests).toHaveLength(1); expect(requests[0].signal.aborted).toBe(true);
    finish({ status: 'exact', actualTimeMs: 123 }); await settle();
    expect(requests.map(r => r.requestId)).toEqual(['one', 'final']);
    expect(p.controls()).toContainEqual(expect.objectContaining({ action: 'ack', requestId: 'one', result: { status: 'held' } }));
    expect(p.controls()).toContainEqual(expect.objectContaining({ action: 'ack', requestId: 'final', result: { status: 'exact', actualTimeMs: 999 } }));
  });
  it('rejects stale documents/capabilities and cancellation never pretends to preempt running JavaScript', async () => {
    const p = page(); await settle(); let finish!: (v: PluginTimelineResult) => void; let signal!: AbortSignal;
    const callback = vi.fn(request => { signal = request.signal; return new Promise<PluginTimelineResult>(resolve => { finish = resolve; }); });
    const { handle, generation } = p.register(callback);
    p.seek('stale-generation', 'ignored'); p.seek(generation, 'ignored-doc', 'preview', { documentId: 'unused' });
    await settle();
    p.dispatch({ type: 'timeline-cancel', capabilityGeneration: generation, requestId: 'ignored-doc' });
    expect(signal.aborted).toBe(true);
    handle.dispose(); const replacement = p.register(() => ({ status: 'exact', actualTimeMs: 777 }));
    p.seek(replacement.generation, 'replacement', 'commit'); await settle(); expect(callback).toHaveBeenCalledTimes(1);
    finish({ status: 'exact', actualTimeMs: 123 }); await settle();
    expect(p.controls().some(m => m.action === 'ack' && m.requestId === 'ignored-doc')).toBe(false);
    expect(p.controls()).toContainEqual(expect.objectContaining({ action: 'ack', requestId: 'replacement' }));
  });
  it('ACKs a cancelled not-yet-started seek when an old capability callback is still running', async () => {
    const p = page(); await settle(); let finish!: (v: PluginTimelineResult) => void;
    const old = p.register(() => new Promise(resolve => { finish = resolve; })); p.seek(old.generation, 'old'); await settle();
    old.handle.dispose();
    const next = p.register(() => ({ status: 'exact', actualTimeMs: 777 }));
    p.seek(next.generation, 'queued-new', 'commit');
    p.dispatch({ type: 'timeline-cancel', capabilityGeneration: next.generation, requestId: 'queued-new' });
    expect(p.controls()).toContainEqual(expect.objectContaining({ action: 'ack', requestId: 'queued-new', result: { status: 'held' } }));
    p.seek(next.generation, 'retry-new', 'commit');
    finish({ status: 'exact', actualTimeMs: 123 }); await settle();
    expect(p.controls()).toContainEqual(expect.objectContaining({ action: 'ack', requestId: 'retry-new', result: { status: 'exact', actualTimeMs: 777 } }));
  });
  it('rejects malformed record keys and keeps truncated error ACKs valid for native JSON decoding', async () => {
    const p = page(); await settle();
    const bad = p.register(() => ({ status: 'exact', actualTimeMs: 1, recordKey: '\uD800' }));
    p.seek(bad.generation, 'bad-key', 'commit'); await settle();
    expect(p.controls()).toContainEqual(expect.objectContaining({ action: 'ack', requestId: 'bad-key', result: { status: 'unsupported' } }));
    const throwing = p.register(() => { throw 'x'.repeat(511) + '😀'; });
    p.seek(throwing.generation, 'unicode-error', 'commit'); await settle();
    const ack = p.controls().find(m => m.requestId === 'unicode-error')!;
    expect(ack.result).toEqual({ status: 'unsupported' }); expect(/[\uD800-\uDFFF]/u.test(ack.error as string)).toBe(false);
    const nav = throwing.handle.beginNavigation('align'); expect(() => nav.update({ timeMs: 1, recordKey: '\uD800' })).toThrow('anchor');
    expect(() => nav.update({ timeMs: 1, recordKey: '😀'.repeat(33) })).toThrow('anchor'); nav.cancel();
    const unicode = p.register(() => ({ status: 'exact', actualTimeMs: 1, recordKey: '😀'.repeat(32) }));
    p.seek(unicode.generation, 'valid-utf8-key', 'commit'); await settle();
    expect(p.controls()).toContainEqual(expect.objectContaining({ requestId: 'valid-utf8-key', result: { status: 'exact', actualTimeMs: 1, recordKey: '😀'.repeat(32) } }));
  });
  it('validates capabilities, summaries and anchors without killing ordinary page channels', async () => {
    const p = page(); await settle(); const { handle } = p.register(() => ({ status: 'no-time' }));
    expect(() => handle.setAvailability({ available: true, range: { startMs: 2, endMs: 1 } })).toThrow('availability');
    handle.setAvailability({ available: false }); handle.updateCapabilities({ preview: 'commit-only', canDrive: false });
    expect(() => handle.beginNavigation('scrollbar')).toThrow('cannot drive');
    handle.updateCapabilities({ preview: 'bounded', canDrive: true });
    const n = handle.beginNavigation('align'); expect(() => n.update({ timeMs: NaN })).toThrow('anchor'); n.cancel();
    expect(p.sent.some(m => m.type === 'error')).toBe(false);
  });
});
