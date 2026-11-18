import { validateSearchSpec } from './searchMatcher';
import { DEFAULT_SEARCH_SPEC, SEARCH_BATCH_BYTES, SEARCH_BATCH_RECORDS, SEARCH_MAX_TEXT_BYTES, SEARCH_RESULT_CAP,
  type SearchHit, type SearchRecord, type SearchSnapshot, type SearchSource, type SearchSourceState, type SearchSpec,
  type SearchWorkerRequest, type SearchWorkerResponse } from './searchTypes';

interface Cursor extends SearchSourceState { cursor: number }
const EMPTY: SearchSnapshot = { status: 'ready', hits: [], scanned: 0, truncated: false, incomplete: false };
const SPAN_CAP = 100_000;
/** Active-query only, one batch in flight, cooperative extraction and no RX hooks. */
export class TerminalSearchSession {
  private readonly spec: SearchSpec;
  private cursors = new Map<string, Cursor>();
  private hits: SearchHit[] = [];
  private keys = new Set<string>();
  private spanCount = 0;
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private inFlight: { sourceId: string; generation: number; configKey: string } | null = null;
  private roundRobin = 0;
  private started = false;
  private disposed = false;
  private snapshot: SearchSnapshot = EMPTY;
  private scanned = 0;
  private incomplete = false;
  private truncated = false;
  private saturated = false;
  private dirty = false;
  private lastPublish = -Infinity;

  constructor(private readonly sources: SearchSource[], spec: SearchSpec = DEFAULT_SEARCH_SPEC,
    private readonly listener: (snapshot: SearchSnapshot) => void = () => undefined) {
    this.spec = { ...DEFAULT_SEARCH_SPEC, ...spec, directions: [...spec.directions] };
  }
  start(): void {
    if (this.disposed || this.started || !this.spec.query) return;
    this.started = true;
    const error = validateSearchSpec(this.spec);
    if (error) { this.fail(error); return; }
    if (typeof Worker === 'undefined') { this.fail('terminal.search.error.workerUnavailable'); return; }
    try {
      const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = event => { if (this.worker === worker) this.receive(event.data); };
      worker.onerror = () => this.fail('terminal.search.error.workerFailed');
      worker.onmessageerror = () => this.fail('terminal.search.error.workerFailed');
      this.publish('scanning', true);
      this.schedule(0);
    } catch { this.fail('terminal.search.error.workerUnavailable'); }
  }
  cancel(): void {
    if (this.disposed || !this.started || this.snapshot.status === 'cancelled') return;
    this.stop(); this.incomplete = true; this.publish('cancelled', true);
  }
  clear(): void {
    if (this.disposed) return;
    const restart = this.started && this.snapshot.status !== 'cancelled' && this.snapshot.status !== 'error';
    this.stop(); this.started = false; this.hits = []; this.keys.clear(); this.cursors.clear();
    this.scanned = 0; this.spanCount = 0; this.truncated = false; this.saturated = false; this.incomplete = false; this.dirty = true;
    this.publish('ready', true);
    if (restart) this.start();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.stop(); this.cursors.clear(); this.hits = []; this.keys.clear(); this.spanCount = 0;
    this.snapshot = { ...EMPTY, status: 'cancelled' };
  }
  getSnapshot(): SearchSnapshot { return this.snapshot; }
  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.timer = null; this.watchdog = null; this.inFlight = null;
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
  }
  private fail(error: string): void {
    if (this.disposed || this.snapshot.status === 'cancelled') return;
    this.stop(); this.incomplete = true; this.publish('error', true, error);
  }
  private publish(status: SearchSnapshot['status'], force = false, error?: string): void {
    if (this.disposed) return;
    const now = performance.now();
    if (!force && status === 'scanning' && now - this.lastPublish < 50) return;
    if (!this.dirty && this.snapshot.status === status && this.snapshot.scanned === this.scanned &&
      this.snapshot.incomplete === this.incomplete && this.snapshot.truncated === this.truncated && !error) return;
    let hits = this.snapshot.hits;
    if (this.dirty) {
      // Group by source and sort only published metadata, not on every RX frame.
      hits = [...this.hits].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.startSeq - b.startSeq);
      this.dirty = false;
    }
    this.snapshot = { status, hits, scanned: this.scanned, truncated: this.truncated, incomplete: this.incomplete, ...(error ? { error } : {}) };
    this.lastPublish = now; this.listener(this.snapshot);
  }
  private schedule(delay: number): void {
    if (this.disposed || !this.worker || this.snapshot.status === 'cancelled' || this.snapshot.status === 'error') return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay);
  }
  private post(message: SearchWorkerRequest): void { this.worker?.postMessage(message); }
  private prune(predicate: (hit: SearchHit) => boolean): void {
    const kept = this.hits.filter(predicate);
    if (kept.length === this.hits.length) return;
    this.hits = kept; this.keys = new Set(kept.map(this.key)); this.saturated = false;
    this.spanCount = kept.reduce((sum, hit) => sum + hit.spans.length, 0); this.dirty = true;
  }
  private key(hit: SearchHit): string { return `${hit.sourceId}:${hit.generation}:${hit.startSeq}`; }
  private refresh(): void {
    const changed = new Set<string>();
    for (const source of this.sources) {
      const state = source.getState();
      const old = this.cursors.get(source.id);
      if (!old || old.generation !== state.generation || old.configKey !== state.configKey || state.lastSeq < old.lastSeq) {
        this.cursors.set(source.id, { ...state, cursor: state.firstSeq });
        this.post({ type: 'reset', sourceId: source.id, generation: state.generation });
        changed.add(source.id);
        // configKey is also an invalidation boundary even if a foreign source
        // did not advance its generation.
        if (old) this.prune(hit => hit.sourceId !== source.id);
      } else {
        if (state.firstSeq > old.firstSeq) {
          if (state.firstSeq > old.cursor) this.incomplete = true;
          old.cursor = Math.max(old.cursor, state.firstSeq);
          this.post({ type: 'trim', sourceId: source.id, generation: state.generation, firstSeq: state.firstSeq });
          changed.add(source.id);
        }
        if (state.available !== old.available) changed.add(source.id);
        Object.assign(old, state);
      }
    }
    // Ordinary append/revision changes never scan the accumulated hit list.
    if (changed.size) this.prune(hit => {
      if (!changed.has(hit.sourceId)) return true;
      const state = this.cursors.get(hit.sourceId)!;
      return state.available && hit.generation === state.generation && hit.startSeq >= state.firstSeq && hit.endSeq <= state.lastSeq;
    });
  }
  private pump(): void {
    if (this.disposed || this.inFlight || !this.worker) return;
    this.refresh();
    if (this.saturated || this.hits.length >= SEARCH_RESULT_CAP || this.spanCount >= SPAN_CAP) {
      this.truncated = true; this.incomplete = true;
      this.publish('ready'); this.schedule(100); return;
    }
    for (let offset = 0; offset < this.sources.length; offset++) {
      const index = (this.roundRobin + offset) % this.sources.length;
      const source = this.sources[index], cursor = this.cursors.get(source.id)!;
      if (!cursor.available || cursor.cursor > cursor.lastSeq) continue;
      const records: Array<SearchRecord | null> = [];
      let bytes = 0;
      const started = performance.now();
      while (cursor.cursor <= cursor.lastSeq && records.length < SEARCH_BATCH_RECORDS) {
        const record = source.readRecord(cursor.cursor, this.spec);
        const size = record ? record.text.length * 2 + (record.rawData?.byteLength ?? 0) : 1;
        // Never clone an arbitrarily large record to the Worker. A skipped row
        // is a hard boundary and is reported as incomplete, never concatenated.
        const oversized = !!record && (record.oversized || (this.spec.mode === 'fuzzy' ? record.text.length * 2 > 8192 : record.text.length * 2 > SEARCH_MAX_TEXT_BYTES) || size > SEARCH_BATCH_BYTES);
        if (!oversized && records.length && bytes + size > SEARCH_BATCH_BYTES) break;
        cursor.cursor++;
        records.push(oversized ? null : record);
        if (oversized) this.incomplete = true;
        bytes += oversized ? 1 : size;
        if (performance.now() - started >= 4) break;
      }
      this.roundRobin = (index + 1) % this.sources.length;
      this.scanned += records.length;
      this.inFlight = { sourceId: source.id, generation: cursor.generation, configKey: cursor.configKey };
      try { this.post({ type: 'batch', ...this.inFlight, records, spec: this.spec }); }
      catch { this.fail('terminal.search.error.workerFailed'); return; }
      this.watchdog = setTimeout(() => this.fail('terminal.search.error.timeout'), 2000);
      this.publish('scanning'); return;
    }
    this.publish('ready');
    if (this.sources.length) this.schedule(100);
  }
  private receive(response: SearchWorkerResponse): void {
    if (this.disposed || !this.worker || !this.inFlight || this.snapshot.status === 'cancelled' || this.snapshot.status === 'error') return;
    const pending = this.inFlight;
    if (response.type !== 'error' && (response.sourceId !== pending.sourceId || response.generation !== pending.generation || response.configKey !== pending.configKey)) return;
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null; this.inFlight = null;
    if (response.type === 'error') { this.fail(response.error); return; }
    const source = this.sources.find(item => item.id === pending.sourceId);
    const state = source?.getState();
    if (!state?.available || state.generation !== pending.generation || state.configKey !== pending.configKey) {
      this.refresh(); this.publish('scanning'); this.schedule(0); return;
    }
    // Trim may advance during a batch. Keep surviving hits from this response;
    // dropping the whole batch would lose records behind the advanced cursor.
    for (const hit of response.hits) {
      if (hit.sourceId !== source!.id || hit.generation !== state.generation || hit.startSeq < state.firstSeq || hit.endSeq > state.lastSeq) continue;
      const key = this.key(hit);
      if (this.keys.has(key)) continue;
      if (this.hits.length >= SEARCH_RESULT_CAP || this.spanCount + hit.spans.length > SPAN_CAP) { this.truncated = true; this.saturated = true; this.incomplete = true; break; }
      this.keys.add(key); this.hits.push(hit); this.spanCount += hit.spans.length; this.dirty = true;
    }
    this.incomplete ||= !!response.incomplete;
    this.refresh(); this.publish('scanning'); this.schedule(4);
  }
}
