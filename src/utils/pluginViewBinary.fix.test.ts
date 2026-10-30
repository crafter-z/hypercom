/**
 * Binary view-channel resource boundaries: shared aggregate budgets, a 256 MiB
 * transfer cap, active idle expiry and explicit per-chunk/handler ACK deadlines.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  MAX_ACTIVE_VIEW_BINARY_TRANSFERS,
  MAX_VIEW_BINARY_TRANSFER_BYTES,
  VIEW_BINARY_CHUNK_BYTES,
  VIEW_BINARY_TRANSFER_IDLE_MS,
  ViewBinaryReceiver,
  ViewBinarySender,
  ViewBinaryBudget,
  VIEW_BINARY_ACK_TIMEOUT_MS,
  VIEW_BINARY_TRANSFER_TIMEOUT_MS,
} from './pluginViewBinary';
import type { ViewBinaryAbort } from './pluginViewBinary';

function chunk(overrides: Partial<Parameters<ViewBinaryReceiver['push']>[0]> = {}) {
  return {
    documentId: 'doc-1',
    transferId: 't-1',
    transferType: 'blob',
    seq: 0,
    done: false,
    data: btoa('ab'),
    ...overrides,
  };
}

function receiver(now: () => number, aborts: ViewBinaryAbort[] = []) {
  return new ViewBinaryReceiver({ now, abort: abort => aborts.push(abort) });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

describe('view binary aggregate resource ownership', () => {
  it('shares per-plugin/global bytes and slot budgets across both directions and views', () => {
    const budget = new ViewBinaryBudget(8, 12, 2, 3);
    const releaseA = budget.reserve('plugin-a', 6, 1);
    const releaseB = budget.reserve('plugin-b', 6, 1);
    expect(() => budget.reserve('plugin-a', 1)).toThrow('aggregate');
    releaseB(); releaseB();
    const releaseOtherView = budget.reserve('plugin-a', 2, 1);
    expect(() => budget.reserve('plugin-a', 0, 1)).toThrow('aggregate');
    const releaseGlobal = budget.reserve('plugin-b', 0, 1);
    expect(() => budget.reserve('plugin-c', 0, 1)).toThrow('aggregate');
    releaseA(); releaseOtherView(); releaseGlobal();
    budget.reserve('plugin-c', 8, 2)();
  });

  it('accounts the join peak and keeps the completed buffer lease until explicit Worker ACK release', () => {
    const budget = new ViewBinaryBudget(6, 6, 2, 2);
    const rx = new ViewBinaryReceiver({ budget, owner: 'plugin-a' });
    const outgoing = budget.reserve('plugin-a', 2, 1);
    expect(rx.push(chunk({ done: true, data: btoa('abc') })).kind).toBe('error');
    outgoing();
    const completed = rx.push(chunk({ done: true, data: btoa('abc') }));
    expect(completed.kind).toBe('complete');
    if (completed.kind !== 'complete') return;
    expect(() => budget.reserve('plugin-a', 4)).toThrow('aggregate');
    completed.release(); completed.release();
    budget.reserve('plugin-a', 6)();
  });

  it('moves a completed transfer lease without requiring an extra aggregate slot', () => {
    const budget = new ViewBinaryBudget(4, 4, 1, 1);
    const rx = new ViewBinaryReceiver({ budget, owner: 'plugin-a' });
    const completed = rx.push(chunk({ done: true }));
    expect(completed.kind).toBe('complete');
    if (completed.kind !== 'complete') return;
    expect(() => budget.reserve('plugin-a', 0, 1)).toThrow('aggregate');
    completed.release(); budget.reserve('plugin-a', 0, 1)();
  });

  it('actively expires idle receivers and returns shared bytes/slots without another push', async () => {
    const budget = new ViewBinaryBudget(2, 2, 1, 1); const abort = vi.fn();
    const rx = new ViewBinaryReceiver({ budget, owner: 'plugin-a', abort });
    expect(rx.push(chunk()).kind).toBe('buffered');
    expect(() => budget.reserve('plugin-b', 1, 1)).toThrow('aggregate');
    await vi.advanceTimersByTimeAsync(VIEW_BINARY_TRANSFER_IDLE_MS);
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ transferId: 't-1', reason: 'binary transfer timed out' }));
    budget.reserve('plugin-b', 2, 1)();
  });

  it.each(['unready', 'unacknowledged', 'native-hung'])('reclaims sender resources when %s', async mode => {
    const budget = new ViewBinaryBudget(2, 2, 1, 1);
    const sender = new ViewBinarySender({ documentId: () => 'doc-1', ready: () => mode !== 'unready',
      send: () => mode === 'native-hung' ? new Promise(() => {}) : Promise.resolve() }, { budget, owner: 'plugin-a' });
    const pending = sender.send('blob', new Uint8Array([1, 2]));
    const rejected = expect(pending).rejects.toThrow(mode === 'unready' ? 'queue timed out' : 'ACK timed out');
    await vi.advanceTimersByTimeAsync(mode === 'unready' ? VIEW_BINARY_TRANSFER_IDLE_MS : VIEW_BINARY_ACK_TIMEOUT_MS);
    await rejected; budget.reserve('plugin-b', 2, 1)(); sender.cancel('closed');
  });

  it('serializes chunks, ignores stale/wrong ACKs, then drains queued transfers in order', async () => {
    const messages: Parameters<ConstructorParameters<typeof ViewBinarySender>[0]['send']>[0][] = [];
    const sender = new ViewBinarySender({ documentId: () => 'doc-1', ready: () => true, send: async message => { messages.push(message); } });
    const first = sender.send('first', new Uint8Array(VIEW_BINARY_CHUNK_BYTES + 1));
    const second = sender.send('second', new Uint8Array(0));
    await settle(); expect(messages).toHaveLength(1);
    expect(sender.acknowledge({ ...messages[0], documentId: 'stale', ok: true })).toBe(false);
    expect(sender.acknowledge({ ...messages[0], done: true, ok: true })).toBe(false);
    sender.acknowledge({ ...messages[0], ok: true }); await settle();
    expect(messages).toHaveLength(2); expect(messages[1].done).toBe(true);
    sender.acknowledge({ ...messages[1], ok: true }); await first; await settle();
    expect(messages[2].transferType).toBe('second');
    sender.acknowledge({ ...messages[2], ok: true }); await second; sender.cancel('closed');
  });
});

describe('view binary absolute resource deadline', () => {
  it('expires despite continuous ACK progress, releases ownership, ignores late ACKs and drains a healthy successor', async () => {
    expect(VIEW_BINARY_TRANSFER_TIMEOUT_MS).toBe(600_000);
    const size = 31 * VIEW_BINARY_CHUNK_BYTES;
    const budget = new ViewBinaryBudget(size + 1, size + 1, 2, 2);
    const messages: Parameters<ConstructorParameters<typeof ViewBinarySender>[0]['send']>[0][] = [];
    const sender = new ViewBinarySender({ documentId: () => 'doc-1', ready: () => true,
      send: async message => { messages.push(message); } }, { budget, owner: 'plugin-a' });
    const stalled = sender.send('slow-progress', new Uint8Array(size));
    const rejected = expect(stalled).rejects.toThrow('view binary transfer timed out');
    await settle();
    // Every chunk progresses in 20s, below the 30s ACK idle deadline. Progress
    // must never extend the absolute ownership lifetime beyond ten minutes.
    for (let index = 0; index < 29; index++) {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sender.acknowledge({ ...messages[messages.length - 1], ok: true })).toBe(true);
      await settle();
    }
    const late = messages[messages.length - 1];
    expect(late.done).toBe(false);
    const healthy = sender.send('healthy', new Uint8Array([7]));
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    // Only the expired job's bytes and slot were released; the queued healthy
    // transfer survived and now owns the sole live byte/slot.
    expect(sender.acknowledge({ ...late, ok: true })).toBe(false);
    budget.reserve('plugin-a', size, 1)();
    const next = messages[messages.length - 1];
    expect(next.transferType).toBe('healthy');
    expect(sender.acknowledge({ ...next, ok: true })).toBe(true);
    await healthy;
    budget.reserve('plugin-a', size + 1, 2)();
    expect(vi.getTimerCount()).toBe(0);
    sender.cancel('closed');
  });

  it('does not strand a healthy transfer enqueued by the preceding completion handler', async () => {
    const messages: Parameters<ConstructorParameters<typeof ViewBinarySender>[0]['send']>[0][] = [];
    const sender = new ViewBinarySender({ documentId: () => 'doc-1', ready: () => true,
      send: async message => { messages.push(message); } });
    const first = sender.send('first', new Uint8Array([1]));
    const successor = first.then(() => sender.send('healthy', new Uint8Array([2])));
    sender.acknowledge({ ...messages[0], ok: true }); await settle();
    expect(messages).toHaveLength(2); expect(messages[1].transferType).toBe('healthy');
    sender.acknowledge({ ...messages[1], ok: true }); await successor;
    expect(vi.getTimerCount()).toBe(0); sender.cancel('closed');
  });

  it('counts queue time in each job deadline without cancelling another active job', async () => {
    const messages: Parameters<ConstructorParameters<typeof ViewBinarySender>[0]['send']>[0][] = [];
    const sender = new ViewBinarySender({ documentId: () => 'doc-1', ready: () => true,
      send: async message => { messages.push(message); } }, { totalMs: 100, idleMs: 1000, ackMs: 1000 });
    const first = sender.send('first', new Uint8Array([1]));
    const firstRejected = expect(first).rejects.toThrow('transfer timed out');
    await vi.advanceTimersByTimeAsync(40);
    const second = sender.send('second', new Uint8Array([2]));
    const secondRejected = expect(second).rejects.toThrow('transfer timed out');
    await vi.advanceTimersByTimeAsync(60); await firstRejected;
    expect(messages).toHaveLength(2); expect(messages[1].transferType).toBe('second');
    await vi.advanceTimersByTimeAsync(39);
    expect(sender.acknowledge({ ...messages[0], ok: true })).toBe(false);
    // The successor spent 60ms queued and has only 40ms active, not a reset 100ms.
    await vi.advanceTimersByTimeAsync(1); await secondRejected;
    expect(sender.acknowledge({ ...messages[1], ok: true })).toBe(false);
    expect(vi.getTimerCount()).toBe(0); sender.cancel('closed');
  });

  it.each(['unready', 'native-hung'])('cleans both timers and the exact job budget when the absolute deadline catches %s', async mode => {
    const budget = new ViewBinaryBudget(2, 2, 1, 1);
    const sender = new ViewBinarySender({ documentId: () => 'doc-1', ready: () => mode !== 'unready',
      send: () => new Promise(() => {}) }, { totalMs: 100, idleMs: 1000, ackMs: 1000, budget, owner: 'plugin-a' });
    const request = sender.send('blob', new Uint8Array([1, 2]));
    const rejected = expect(request).rejects.toThrow('transfer timed out');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    budget.reserve('plugin-a', 2, 1)();
    expect(vi.getTimerCount()).toBe(0); sender.cancel('closed');
  });

  it('rejects a cutoff ACK even when the deadline timer has not run yet', async () => {
    const messages: Parameters<ConstructorParameters<typeof ViewBinarySender>[0]['send']>[0][] = [];
    const sender = new ViewBinarySender({ documentId: () => 'doc-1', ready: () => true,
      send: async message => { messages.push(message); } }, { totalMs: 100, ackMs: 1000 });
    const request = sender.send('blob', new Uint8Array([1]));
    const rejected = expect(request).rejects.toThrow('transfer timed out');
    vi.setSystemTime(Date.now() + 100);
    expect(sender.acknowledge({ ...messages[0], ok: true })).toBe(false);
    await rejected; await settle(); expect(vi.getTimerCount()).toBe(0); sender.cancel('closed');
  });
});

describe('view binary sender admission', () => {
  it('adopts exact host-owned RPC buffers without a second full copy but copies ordinary callers', async () => {
    const sender = new ViewBinarySender({ documentId: () => null, ready: () => false, send: vi.fn() });
    const owned = new Uint8Array([1, 2]); const ownedCopy = vi.spyOn(owned, 'slice');
    const caller = new Uint8Array([3, 4]); const callerCopy = vi.spyOn(caller, 'slice');
    const a = expect(sender.send('owned', owned, true)).rejects.toThrow('closed');
    const b = expect(sender.send('caller', caller)).rejects.toThrow('closed');
    expect(ownedCopy).not.toHaveBeenCalled(); expect(callerCopy).toHaveBeenCalledOnce();
    sender.cancel('closed'); await Promise.all([a, b]);
  });

  it('rejects an oversized payload before allocating an owned copy', async () => {
    const sender = new ViewBinarySender({ documentId: () => null, ready: () => false, send: vi.fn() }, {
      maxTransferBytes: 2, maxQueueBytes: 2,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const copy = vi.spyOn(bytes, 'slice');
    await expect(sender.send('blob', bytes)).rejects.toThrow('transfer exceeds');
    expect(copy).not.toHaveBeenCalled();
    sender.cancel('closed');
  });

  it('rejects an over-capacity payload before copying it', async () => {
    const sender = new ViewBinarySender({ documentId: () => null, ready: () => false, send: vi.fn() }, {
      maxTransferBytes: 4, maxQueueBytes: 2,
    });
    const pending = sender.send('blob', new Uint8Array([1, 2]));
    const outcome = expect(pending).rejects.toThrow('closed');
    const bytes = new Uint8Array([3]);
    const copy = vi.spyOn(bytes, 'slice');
    await expect(sender.send('blob', bytes)).rejects.toThrow('queue capacity');
    expect(copy).not.toHaveBeenCalled();
    sender.cancel('closed');
    await outcome;
  });
});

describe('view binary receiver bounds', () => {
  it('keeps the documented 8 KiB chunk / 256 MiB transfer / 60 s idle constants', () => {
    expect(VIEW_BINARY_CHUNK_BYTES).toBe(8 * 1024);
    expect(MAX_VIEW_BINARY_TRANSFER_BYTES).toBe(256 * 1024 * 1024);
    expect(VIEW_BINARY_TRANSFER_IDLE_MS).toBe(60_000);
    expect(MAX_ACTIVE_VIEW_BINARY_TRANSFERS).toBe(4);
  });

  it('reassembles ordered chunks and completes on the done chunk', () => {
    const rx = receiver(() => 0);
    expect(rx.push(chunk()).kind).toBe('buffered');
    const done = rx.push(chunk({ seq: 1, done: true, data: btoa('cd') }));
    expect(done.kind).toBe('complete');
    if (done.kind !== 'complete') return;
    expect(new TextDecoder().decode(done.bytes)).toBe('abcd');
  });

  it('rejects out-of-order chunks and drops the half transfer', () => {
    const rx = receiver(() => 0);
    expect(rx.push(chunk({ seq: 0 })).kind).toBe('buffered');
    expect(rx.push(chunk({ seq: 2 })).kind).toBe('error');
    // A retry from seq 0 is accepted again (the broken state was dropped).
    expect(rx.push(chunk({ seq: 0 })).kind).toBe('buffered');
  });

  it('nacks half-open transfers after the idle window and reports the abort', () => {
    let now = 0;
    const aborts: ViewBinaryAbort[] = [];
    const rx = receiver(() => now, aborts);
    expect(rx.push(chunk({ transferId: 'stale' })).kind).toBe('buffered');
    now = VIEW_BINARY_TRANSFER_IDLE_MS + 1;
    // Any push (even a new transfer) prunes the expired one first.
    expect(rx.push(chunk({ transferId: 'fresh' })).kind).toBe('buffered');
    expect(aborts.map(abort => [abort.transferId, abort.reason])).toEqual([
      ['stale', 'binary transfer timed out'],
    ]);
    expect(rx.push(chunk({ transferId: 'fresh', seq: 1, done: true, data: btoa('x') })).kind)
      .toBe('complete');
  });

  it('evicts the oldest transfer instead of refusing new ones when slots are full', () => {
    const aborts: ViewBinaryAbort[] = [];
    const rx = receiver(() => 0, aborts);
    for (let i = 0; i < MAX_ACTIVE_VIEW_BINARY_TRANSFERS; i++) {
      expect(rx.push(chunk({ transferId: `t-${i}` })).kind).toBe('buffered');
    }
    // The fifth transfer evicts the least recently updated one (t-0) and is accepted.
    expect(rx.push(chunk({ transferId: 't-new' })).kind).toBe('buffered');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({ transferId: 't-0', reason: 'too many binary transfers' });
  });

  it('rejects a single transfer above the 256 MiB cap without buffering it', () => {
    const rx = new ViewBinaryReceiver({ now: () => 0, maxTransferBytes: 1024 });
    expect(rx.push(chunk({ data: btoa('a'.repeat(700)) })).kind).toBe('buffered');
    const over = rx.push(chunk({ seq: 1, data: btoa('b'.repeat(700)) }));
    expect(over.kind).toBe('error');
    if (over.kind === 'error') expect(over.error).toContain('exceeds');
  });
});
