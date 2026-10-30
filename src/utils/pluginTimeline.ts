import type { PluginViewBinding, PluginViewDeclaration, PluginViewHostMessage, PluginTimelineAnchor, PluginTimelineResult, PluginTimelineSeek } from '../types/pluginViews';
import { timelineCoordinator } from './timeline/coordinator';
import type { TimelineAvailability, TimelineCapabilities, TimelineNavigationToken, TimelineParticipantHandle, TimelineSeekRequest, TimelineSeekResult } from './timeline/types';
import { HOST_CLOCK_ID, serialSourceId, TIMELINE_BUDGET } from './timeline/types';

/** The time lane has its own physical in-flight slot. Timeout settles the
 * coordinator waiter, not the executing page callback: that slot is released
 * only by its eventual ACK (or document/capability disposal). */
interface Waiter {
  wire: PluginTimelineSeek;
  request: TimelineSeekRequest;
  resolve: (result: TimelineSeekResult) => void;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
  settled: boolean;
}
let nextParticipantGeneration = 0;
const statuses = new Set(['exact', 'nearest', 'before-range', 'after-range', 'no-time', 'filtered', 'held', 'loading', 'unsupported']);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid timeline object');
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
function anchor(value: unknown): PluginTimelineAnchor {
  const item = object(value);
  if (typeof item.timeMs !== 'number' || !Number.isFinite(item.timeMs) || (item.recordKey !== undefined && (typeof item.recordKey !== 'string' || item.recordKey.length > 128))) throw new Error('invalid timeline anchor');
  return { timeMs: item.timeMs, ...(item.recordKey === undefined ? {} : { recordKey: item.recordKey as string }) };
}
function capabilities(value: unknown): TimelineCapabilities {
  const item = object(value);
  if (!['bounded', 'commit-only'].includes(item.preview as string) || typeof item.canDrive !== 'boolean') throw new Error('invalid timeline capabilities');
  return { preview: item.preview as TimelineCapabilities['preview'], canDrive: item.canDrive };
}

export interface PluginTimelineTransport {
  binding: PluginViewBinding;
  declaration: PluginViewDeclaration;
  documentId: string;
  send: (message: PluginViewHostMessage) => Promise<void>;
}
/** One instance per native document, including worker:false documents. */
export class PluginTimeline {
  private generation = '';
  private handle: TimelineParticipantHandle | null = null;
  private participantGeneration = 0;
  private availability: TimelineAvailability = { available: true, visible: false };
  private sourceAnchor: PluginTimelineAnchor | null = null;
  private navigation: { id: string; token: TimelineNavigationToken } | null = null;
  private flight: Waiter | null = null;
  private pending: Waiter | null = null;
  private alive = true;
  constructor(private readonly transport: PluginTimelineTransport) {}
  setVisible(visible: boolean): void {
    if (this.availability.visible === visible) return;
    this.availability = { ...this.availability, visible };
    this.handle?.setAvailability(this.availability);
    if (!visible) { if (this.flight) this.cancel(this.flight); if (this.pending) { this.settle(this.pending, { status: 'held', actualTimeMs: null }); this.pending = null; } }
    else this.pump();
  }
  updateSourceGeneration(generation: number): void {
    if (this.flight) this.cancel(this.flight);
    if (this.pending) { this.settle(this.pending, { status: 'held', actualTimeMs: null }); this.pending = null; }
    this.sourceAnchor = null;
    this.handle?.updateSourceGeneration(generation);
  }
  receive(value: unknown): void {
    if (!this.alive) return;
    const message = object(value);
    if (!uuid(message.capabilityGeneration)) throw new Error('invalid timeline capability identity');
    if (message.action === 'register') { this.register(message.capabilityGeneration, message.registration); return; }
    if (message.capabilityGeneration !== this.generation || !this.handle) return;
    if (message.action === 'dispose') { this.clear(); return; }
    if (message.action === 'ack') { this.acknowledge(message); return; }
    if (message.action === 'capabilities') { this.handle.updateCapabilities(capabilities(message.capabilities)); return; }
    if (message.action === 'availability') {
      const item = object(message.availability);
      if (typeof item.available !== 'boolean') throw new Error('invalid timeline availability');
      let range: { startTimeMs?: number; endTimeMs?: number } = {};
      if (item.range !== undefined) {
        const bounds = object(item.range);
        if (typeof bounds.startMs !== 'number' || typeof bounds.endMs !== 'number' || !Number.isFinite(bounds.startMs) || !Number.isFinite(bounds.endMs) || bounds.startMs > bounds.endMs) throw new Error('invalid timeline range');
        range = { startTimeMs: bounds.startMs, endTimeMs: bounds.endMs };
      }
      this.availability = { available: item.available, visible: this.availability.visible, ...range };
      this.handle.setAvailability(this.availability); return;
    }
    if (!uuid(message.gestureId)) throw new Error('invalid timeline gesture');
    if (message.action === 'begin') {
      if (!['scrollbar', 'wheel', 'keyboard', 'search', 'jump', 'align', 'scrub'].includes(message.intent as string) || !this.availability.visible) return;
      if (this.navigation) timelineCoordinator.cancelNavigation(this.navigation.token);
      const token = timelineCoordinator.beginNavigation(this.handle.participantId);
      this.navigation = token ? { id: message.gestureId, token } : null; return;
    }
    if (!this.navigation || this.navigation.id !== message.gestureId) return;
    const token = this.navigation.token;
    if (message.action === 'update') { const next = anchor(message.anchor); this.sourceAnchor = next; timelineCoordinator.updateNavigation(token, next); }
    else if (message.action === 'end') {
      const next = message.anchor === undefined ? undefined : anchor(message.anchor);
      if (next) this.sourceAnchor = next;
      this.navigation = null; timelineCoordinator.endNavigation(token, next);
    } else if (message.action === 'cancel') { this.navigation = null; timelineCoordinator.cancelNavigation(token); }
    else throw new Error('invalid timeline action');
  }
  private register(generation: string, value: unknown): void {
    if (generation === this.generation && this.handle) return;
    const item = object(value); const clock = object(item.clock); const caps = capabilities(item.capabilities);
    if (item.version !== 1 || !['bound-input', 'custom'].includes(clock.kind as string)) throw new Error('invalid timeline registration');
    const bound = clock.kind === 'bound-input'; const { binding, declaration } = this.transport;
    if (bound && (!binding.boundPortId || declaration.input === 'none' || binding.workerEpoch === 0)) throw new Error('bound-input requires a host input clock');
    if (!bound && !text(clock.id)) throw new Error('invalid custom timeline clock');
    this.clear(); this.generation = generation; this.participantGeneration = ++nextParticipantGeneration;
    const customSource = `plugin:${binding.pluginId}:${binding.installGeneration}:${String(clock.id)}`;
    this.handle = timelineCoordinator.registerParticipant({
      participantId: `plugin:${binding.viewInstanceId}:${this.transport.documentId}:${generation}`,
      slotId: binding.tabId,
      sourceId: bound ? serialSourceId(binding.boundPortId!) : customSource,
      sourceKind: bound ? 'live' : 'custom',
      generation: this.participantGeneration,
      sourceGeneration: binding.streamEpoch,
      clockId: bound ? HOST_CLOCK_ID : customSource,
      capabilities: caps,
      availability: this.availability,
      readAnchor: () => this.sourceAnchor,
      seek: request => this.seek(request),
    });
    // Registration can synchronously request a realignment before its handle
    // exists; re-admit once the complete capability binding is installed.
    this.handle.setAvailability(this.availability);
  }
  private seek(request: TimelineSeekRequest): Promise<TimelineSeekResult> {
    if (!this.alive || !this.handle || !this.availability.available || !this.availability.visible || request.signal.aborted || !request.isCurrent()) return Promise.resolve({ status: 'held', actualTimeMs: null });
    return new Promise(resolve => {
      const { signal: _signal, isCurrent: _current, ...identity } = request;
      const wire: PluginTimelineSeek = { ...identity, requestId: crypto.randomUUID(), capabilityGeneration: this.generation, align: 'center' };
      const waiter: Waiter = {
        wire, request, resolve, settled: false,
        timer: setTimeout(() => { this.settle(waiter, { status: 'slow', actualTimeMs: null }); if (this.flight === waiter) this.sendCancel(waiter); else if (this.pending === waiter) this.pending = null; }, request.phase === 'preview' ? TIMELINE_BUDGET.previewSlowMs : TIMELINE_BUDGET.commitSlowMs),
        abort: () => this.cancel(waiter),
      };
      request.signal.addEventListener('abort', waiter.abort, { once: true });
      // Coordinator already coalesces, but this additional physical lane protects
      // against a timed-out callback that is still executing in the native page.
      if (this.pending) {
        if (this.pending.wire.phase === 'commit' && wire.phase === 'preview' && wire.navigationEpoch <= this.pending.wire.navigationEpoch) { this.settle(waiter, { status: 'held', actualTimeMs: null }); return; }
        this.settle(this.pending, { status: 'held', actualTimeMs: null });
      }
      this.pending = waiter;
      if (this.flight) this.cancel(this.flight);
      this.pump();
    });
  }
  private pump(): void {
    if (this.flight || !this.pending || !this.alive || !this.availability.visible) return;
    const waiter = this.pending; this.pending = null;
    if (waiter.request.signal.aborted || !waiter.request.isCurrent() || waiter.settled) { this.settle(waiter, { status: 'held', actualTimeMs: null }); this.pump(); return; }
    this.flight = waiter;
    void this.transport.send({ type: 'timeline-seek', documentId: this.transport.documentId, timeline: waiter.wire }).catch(() => {
      this.settle(waiter, { status: 'unavailable', actualTimeMs: null });
      if (this.flight === waiter) { this.flight = null; this.pump(); }
    });
  }
  private sendCancel(waiter: Waiter): void {
    void this.transport.send({ type: 'timeline-cancel', documentId: this.transport.documentId, capabilityGeneration: waiter.wire.capabilityGeneration, requestId: waiter.wire.requestId }).catch(() => {});
  }
  private cancel(waiter: Waiter): void {
    this.settle(waiter, { status: 'held', actualTimeMs: null });
    if (this.flight === waiter) this.sendCancel(waiter);
    if (this.pending === waiter) this.pending = null;
  }
  private settle(waiter: Waiter, result: TimelineSeekResult): void {
    if (waiter.settled) return; waiter.settled = true; clearTimeout(waiter.timer);
    waiter.request.signal.removeEventListener('abort', waiter.abort); waiter.resolve(result);
  }
  private acknowledge(message: Record<string, unknown>): void {
    const waiter = this.flight;
    if (!waiter || waiter.wire.requestId !== message.requestId) return;
    const result = object(message.result);
    if (!statuses.has(result.status as string) || (['exact', 'nearest', 'before-range', 'after-range'].includes(result.status as string) && (typeof result.actualTimeMs !== 'number' || !Number.isFinite(result.actualTimeMs))) || (result.actualTimeMs !== undefined && (typeof result.actualTimeMs !== 'number' || !Number.isFinite(result.actualTimeMs))) || (result.recordKey !== undefined && (typeof result.recordKey !== 'string' || result.recordKey.length > 128))) throw new Error('invalid timeline result');
    const current = !waiter.request.signal.aborted && waiter.request.isCurrent();
    const actualTimeMs = typeof result.actualTimeMs === 'number' ? result.actualTimeMs : null;
    if (current && !waiter.settled) {
      if (actualTimeMs !== null) this.sourceAnchor = { timeMs: actualTimeMs, ...(typeof result.recordKey === 'string' ? { recordKey: result.recordKey } : {}) };
      this.settle(waiter, { status: result.status as PluginTimelineResult['status'], actualTimeMs, ...(typeof result.recordKey === 'string' ? { recordKey: result.recordKey } : {}) });
    } else this.settle(waiter, { status: 'held', actualTimeMs: null });
    this.flight = null; this.pump();
  }
  private clear(): void {
    if (this.navigation) timelineCoordinator.cancelNavigation(this.navigation.token);
    this.navigation = null;
    this.handle?.dispose(); this.handle = null;
    if (this.flight) { this.sendCancel(this.flight); this.settle(this.flight, { status: 'unavailable', actualTimeMs: null }); }
    if (this.pending) this.settle(this.pending, { status: 'unavailable', actualTimeMs: null });
    this.flight = null; this.pending = null; this.sourceAnchor = null; this.generation = '';
  }
  dispose(): void { if (this.alive) { this.clear(); this.alive = false; } }
}
