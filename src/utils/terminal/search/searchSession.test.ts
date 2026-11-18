import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchWorkerHandler } from './searchWorker';
import { TerminalSearchSession } from './searchSession';
import { DEFAULT_SEARCH_SPEC, type SearchRecord, type SearchSource, type SearchWorkerRequest, type SearchWorkerResponse } from './searchTypes';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<SearchWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: SearchWorkerRequest[] = [];
  terminate = vi.fn();
  private handle = createSearchWorkerHandler();
  constructor(_url: URL, _options: WorkerOptions) { FakeWorker.instances.push(this); }
  postMessage(request: SearchWorkerRequest): void {
    this.requests.push(request);
    const response = this.handle(request);
    const callback = this.onmessage;
    // Capture the callback to deliberately simulate late callbacks after terminate.
    if (response) setTimeout(() => callback?.({ data: response } as MessageEvent<SearchWorkerResponse>), 1);
  }
}
function row(seq: number, text: string): SearchRecord { return { seq, text, timestamp: seq, direction: 'RX' }; }
function source(rows: SearchRecord[], id = 'source') {
  const values = new Map(rows.map(item => [item.seq, item]));
  let firstSeq = rows[0]?.seq ?? 1, lastSeq = rows[rows.length - 1]?.seq ?? 0, generation = 1, configKey = 'initial';
  const readRecord = vi.fn((seq: number) => values.get(seq) ?? null);
  return {
    id, readRecord,
    getState: () => ({ generation, revision: lastSeq, firstSeq, lastSeq, configKey, available: true }),
    append: (record: SearchRecord) => { values.set(record.seq, record); lastSeq = Math.max(lastSeq, record.seq); },
    trim: (first: number) => { firstSeq = first; for (const seq of values.keys()) if (seq < first) values.delete(seq); },
    changeConfig: (key: string, nextGeneration = generation) => { configKey = key; generation = nextGeneration; },
  };
}
const sessions: TerminalSearchSession[] = [];
function session(sources: SearchSource[], patch: Partial<typeof DEFAULT_SEARCH_SPEC>, listener = vi.fn()) {
  const value = new TerminalSearchSession(sources, { ...DEFAULT_SEARCH_SPEC, ...patch }, listener);
  sessions.push(value); return value;
}
beforeEach(() => { vi.useFakeTimers(); FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { sessions.splice(0).forEach(value => value.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('TerminalSearchSession with production Worker protocol', () => {
  it('matches across extraction batches and appends without rescanning old records', async () => {
    const rows = Array.from({ length: 129 }, (_, index) => row(index, index === 127 ? 'left' : index === 128 ? 'right' : 'x'));
    const registration = source(rows);
    const value = session([registration], { query: 'left\nright', multiline: true }); value.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(value.getSnapshot().hits).toEqual([expect.objectContaining({ startSeq: 127, endSeq: 128 })]);
    registration.append(row(129, 'left')); registration.append(row(130, 'right'));
    await vi.advanceTimersByTimeAsync(120);
    expect(value.getSnapshot().hits).toHaveLength(2);
    expect(registration.readRecord).toHaveBeenCalledTimes(131);
    const count = value.getSnapshot().scanned;
    await vi.advanceTimersByTimeAsync(300); expect(value.getSnapshot().scanned).toBe(count);
  });
  it('keeps valid hits when trim advances while a batch is in flight', async () => {
    const registration = source([row(1, 'needle'), row(2, 'needle')]);
    const value = session([registration], { query: 'needle' }); value.start();
    await vi.advanceTimersByTimeAsync(0); registration.trim(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(value.getSnapshot().hits.map(hit => hit.startSeq)).toEqual([2]);
  });
  it('resets a changed config during an in-flight batch instead of accepting stale offsets or timing out', async () => {
    const registration = source([row(1, 'needle')]);
    const value = session([registration], { query: 'needle' }); value.start();
    await vi.advanceTimersByTimeAsync(0); registration.changeConfig('changed', 2);
    await vi.advanceTimersByTimeAsync(120);
    expect(value.getSnapshot().status).toBe('ready');
    expect(value.getSnapshot().hits).toEqual([expect.objectContaining({ generation: 2 })]);
    expect(registration.readRecord).toHaveBeenCalledTimes(2);
  });
  it('terminates on cancel and ignores callbacks even when they arrive after termination', async () => {
    const value = session([source([row(1, 'needle')])], { query: 'needle' }); value.start();
    await vi.advanceTimersByTimeAsync(0);
    const worker = FakeWorker.instances[0]; value.cancel();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(value.getSnapshot().status).toBe('cancelled'); expect(value.getSnapshot().hits).toHaveLength(0);
    value.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('round-robins multiple sources, bounds each batch, and publishes no idle result copies', async () => {
    const a = source(Array.from({ length: 300 }, (_, seq) => row(seq, 'needle')), 'a');
    const b = source([row(0, 'needle')], 'b'); const listener = vi.fn();
    const value = session([a, b], { query: 'needle' }, listener); value.start();
    await vi.advanceTimersByTimeAsync(100);
    const batches = FakeWorker.instances[0].requests.filter(request => request.type === 'batch');
    expect(batches[0].sourceId).toBe('a'); expect(batches[1].sourceId).toBe('b');
    expect(batches.every(batch => batch.records.length <= 128)).toBe(true);
    expect(value.getSnapshot().hits).toHaveLength(301);
    const published = listener.mock.calls.length, hits = value.getSnapshot().hits;
    await vi.advanceTimersByTimeAsync(300);
    expect(listener).toHaveBeenCalledTimes(published); expect(value.getSnapshot().hits).toBe(hits);
  });
  it('skips oversized records as hard boundaries and reports partial results', async () => {
    const registration = source([row(0, 'left'), row(1, 'x'.repeat(100_000)), row(2, 'right')]);
    const value = session([registration], { query: 'left\nright', multiline: true }); value.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(value.getSnapshot().incomplete).toBe(true); expect(value.getSnapshot().hits).toHaveLength(0);
    const batch = FakeWorker.instances[0].requests.find(request => request.type === 'batch');
    expect(batch?.records[1]).toBeNull();
  });
  it('terminates a stalled Worker without blocking source appends or leaving timers', async () => {
    class StalledWorker extends FakeWorker {
      override postMessage(request: SearchWorkerRequest): void { if (request.type !== 'batch') super.postMessage(request); }
    }
    vi.stubGlobal('Worker', StalledWorker);
    const registration = source([row(0, 'needle')]);
    const value = session([registration], { query: 'needle', mode: 'regex' }); value.start();
    await vi.advanceTimersByTimeAsync(0); registration.append(row(1, 'RX continues'));
    await vi.advanceTimersByTimeAsync(2100);
    expect(value.getSnapshot().error).toBe('terminal.search.error.timeout');
    expect(value.getSnapshot().status).toBe('error');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(registration.getState().lastSeq).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('applies backpressure at the total span cap instead of retaining unbounded highlight metadata', async () => {
    const registration = source(Array.from({ length: 1000 }, (_, seq) => row(seq, 'a'.repeat(1024))));
    const value = session([registration], { query: 'a' }); value.start();
    await vi.advanceTimersByTimeAsync(1200);
    expect(value.getSnapshot().truncated).toBe(true);
    expect(value.getSnapshot().hits.reduce((sum, hit) => sum + hit.spans.length, 0)).toBeLessThanOrEqual(100_000);
    const reads = registration.readRecord.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300); expect(registration.readRecord).toHaveBeenCalledTimes(reads);
  });

  it('continues pruning expired results even when the result cap is saturated', async () => {
    const registration = source(Array.from({ length: 10_100 }, (_, seq) => row(seq, 'hit')));
    const value = session([registration], { query: 'hit' }); value.start();
    await vi.advanceTimersByTimeAsync(1200);
    expect(value.getSnapshot().hits).toHaveLength(10_000); expect(value.getSnapshot().truncated).toBe(true);
    registration.trim(9_900); await vi.advanceTimersByTimeAsync(200);
    expect(value.getSnapshot().hits.every(hit => hit.startSeq >= 9_900)).toBe(true);
    expect(value.getSnapshot().hits.length).toBeLessThanOrEqual(200);
  });
});
