import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_RPC_TIMEOUT_MS, PLUGIN_BINARY_RPC_TIMEOUT_MS, hasNoRpcDeadline, wrapPluginCode } from './pluginBridge';

type RpcReply = { seq: number; ok: boolean; result?: unknown; error?: string };
type HostEvent = { type: string; payload?: unknown; eventId?: number };
type WorkerScope = {
  plugin?: {
    api: Record<string, (args?: unknown) => Promise<unknown>>;
    http: {
      request: (options?: unknown) => Promise<unknown>;
      stream: (options?: unknown) => Promise<{
        status: number; headers: Record<string, string>; url: string;
        body: AsyncIterable<Uint8Array>; cancel: () => Promise<void>;
      }>;
    };
    on: (type: string, callback: (payload: unknown) => unknown) => () => void;
  };
  onmessage?: (event: { data: RpcReply | HostEvent }) => void;
  postMessage: (message: unknown) => void;
  crypto?: Crypto;
  addEventListener: (type: string, handler: (event: { reason: unknown }) => void) => void;
  request?: Promise<unknown>;
  stream?: Promise<{ status: number; headers: Record<string, string>; url: string; body: AsyncIterable<Uint8Array>; cancel: () => Promise<void> }>;
};

function wrappedWorker(source: string) {
  const sent: unknown[] = [];
  const listeners = new Map<string, Array<(event: { reason: unknown }) => void>>();
  const scope: WorkerScope = {
    postMessage: (message) => { sent.push(message); },
    crypto: globalThis.crypto,
    addEventListener: (type, handler) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
  };
  new Function('self', wrapPluginCode(source))(scope);
  const reply = (message: RpcReply | HostEvent) => scope.onmessage?.({ data: message });
  const emit = (type: string, event: { reason: unknown }) => {
    for (const handler of listeners.get(type) ?? []) handler(event);
  };
  return { scope, sent, reply, emit };
}

function sentMessages(sent: unknown[]): Array<{ seq?: number; op?: string; type?: string; args?: Record<string, unknown>; eventAck?: number }> {
  return sent as Array<{ seq?: number; op?: string; type?: string; args?: Record<string, unknown>; eventAck?: number }>;
}

afterEach(() => { vi.useRealTimers(); });

describe('wrapped worker RPC lifecycle', () => {
  it('times out an ordinary unanswered request, ignores a late reply, and still handles later calls', async () => {
    vi.useFakeTimers();
    const worker = wrappedWorker('self.request = self.plugin.api["ports.list"]();');
    const request = worker.scope.request!;
    const outcome = expect(request).rejects.toThrow('plugin RPC timed out');
    await vi.advanceTimersByTimeAsync(PLUGIN_RPC_TIMEOUT_MS + 1001);
    await outcome;
    worker.reply({ seq: 1, ok: true, result: 'late' });
    const next = worker.scope.plugin!.api['ports.list']();
    worker.reply({ seq: 2, ok: true, result: 'new' });
    await expect(next).resolves.toBe('new');
  });

  it('keeps HTTP and user-controlled work pending with no host RPC deadline', async () => {
    vi.useFakeTimers();
    const worker = wrappedWorker('self.http = self.plugin.http.request({url: "https://example.com"}); self.dialog = self.plugin.api["fs.openDialog"]({});');
    const http = (worker.scope as WorkerScope & { http: Promise<unknown> }).http;
    const dialog = (worker.scope as WorkerScope & { dialog: Promise<unknown> }).dialog;
    await vi.advanceTimersByTimeAsync(600_000);
    worker.reply({ seq: 1, ok: true, result: 'http success' });
    await expect(http).resolves.toBe('http success');
    worker.reply({ seq: 2, ok: true, result: 'selected' });
    await expect(dialog).resolves.toBe('selected');
  });

  it.each(['ui.panel.export', 'fs.read'])('keeps %s pending until the host finishes', async op => {
    vi.useFakeTimers();
    const worker = wrappedWorker(`self.request = self.plugin.api[${JSON.stringify(op)}]({rel: 'assets/large.bin', format: 'binary'});`);
    const outcome = vi.fn();
    const request = worker.scope.request!.then(outcome, outcome);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(outcome).not.toHaveBeenCalled();
    worker.reply({ seq: 1, ok: true, result: 'exported' });
    await request;
    expect(outcome).toHaveBeenCalledWith('exported');
  });

  it('retires binary RPC promises at their dedicated resource deadline, not the network deadline', async () => {
    vi.useFakeTimers();
    expect(hasNoRpcDeadline('view.sendBinary')).toBe(false);
    expect(hasNoRpcDeadline('http.read')).toBe(true);
    const worker = wrappedWorker('self.request = self.plugin.api["view.sendBinary"]({});');
    const outcome = expect(worker.scope.request!).rejects.toThrow('plugin RPC timed out');
    await vi.advanceTimersByTimeAsync(PLUGIN_BINARY_RPC_TIMEOUT_MS + 1001); await outcome;
    worker.reply({ seq: 1, ok: true });
  });

  it('rejects immediately when posting cannot clone arguments', async () => {
    const worker = wrappedWorker('');
    worker.scope.postMessage = () => { throw new Error('clone failed'); };
    await expect(worker.scope.plugin!.api.log({ value: () => {} })).rejects.toThrow('clone failed');
  });
});

describe('wrapped worker event delivery', () => {
  it('dispatches a handler snapshot so self-unsubscription does not skip the next callback', async () => {
    const worker = wrappedWorker('');
    const second = vi.fn();
    const calls: string[] = [];
    const unsubscribe = worker.scope.plugin!.on('ui.buttonClick', () => {
      calls.push('first');
      unsubscribe();
    });
    worker.scope.plugin!.on('ui.buttonClick', second);
    worker.reply({ type: 'ui.buttonClick', payload: 'clicked', eventId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['first']);
    expect(second).toHaveBeenCalledWith('clicked');
    expect(worker.sent).toContainEqual({ eventAck: 1 });
    worker.reply({ type: 'ui.buttonClick', payload: 'again', eventId: 2 });
    expect(calls).toEqual(['first']);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('acknowledges only after every async handler in the snapshot settles', async () => {
    const worker = wrappedWorker('');
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    worker.scope.plugin!.on('rx.detached', () => pending);
    worker.reply({ type: 'rx.detached', eventId: 1 });
    await Promise.resolve();
    expect(worker.sent).not.toContainEqual({ eventAck: 1 });
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.sent).toContainEqual({ eventAck: 1 });
  });
});

describe('isolated view Worker processing', () => {
  it('resets a gapped stream before retained bytes and serializes async input batches', async () => {
    vi.useFakeTimers();
    const worker = wrappedWorker(`
      self.order = [];
      self.plugin.views.onOpen(function(view) {
        view.onDiscontinuity(function() { self.order.push('gap'); });
        view.onInput(async function(batch) {
          self.order.push('start-' + batch[0].value);
          await new Promise(function(done) { setTimeout(done, 10); });
          self.order.push('end-' + batch[0].value);
        });
      });
    `);
    worker.reply({ type: 'view.open', eventId: 1, payload: { context: { viewInstanceId: 'view-a' } } });
    worker.reply({ type: 'view.input', eventId: 2, payload: { instanceId: 'view-a', streamEpoch: 2, gapBefore: true, batch: [{ value: 1 }] } });
    worker.reply({ type: 'view.input', eventId: 3, payload: { instanceId: 'view-a', streamEpoch: 2, gapBefore: false, batch: [{ value: 2 }] } });
    await vi.advanceTimersByTimeAsync(25);
    expect((worker.scope as WorkerScope & { order: string[] }).order).toEqual(['gap', 'start-1', 'end-1', 'start-2', 'end-2']);
    expect(worker.sent).toContainEqual({ eventAck: 2 });
    expect(worker.sent).toContainEqual({ eventAck: 3 });
    worker.reply({ type: 'view.close', eventId: 4, payload: { instanceId: 'view-a' } });
    worker.reply({ type: 'view.input', eventId: 5, payload: { instanceId: 'view-a', batch: [{ value: 3 }] } });
    await vi.advanceTimersByTimeAsync(20);
    expect((worker.scope as WorkerScope & { order: string[] }).order).not.toContain('start-3');
  });

  it('closes and releases queued deliveries without waiting for stalled initialization', async () => {
    const worker = wrappedWorker(`
      self.closed = [];
      self.plugin.views.onOpen(function(view) {
        return new Promise(function(done) { self.finishOpen = done; });
      });
      self.plugin.views.onClose(function(event) { self.closed.push(event.view.context.viewInstanceId); });
    `);
    worker.reply({ type: 'view.open', eventId: 10, payload: { context: { viewInstanceId: 'stalled' } } });
    await Promise.resolve();
    worker.reply({ type: 'view.input', eventId: 11, payload: { instanceId: 'stalled', batch: [{ value: 1 }] } });
    worker.reply({ type: 'view.close', eventId: 12, payload: { instanceId: 'stalled' } });
    expect((worker.scope as WorkerScope & { closed: string[] }).closed).toEqual(['stalled']);
    expect(worker.sent).toContainEqual({ eventAck: 10 });
    expect(worker.sent).toContainEqual({ eventAck: 11 });
    (worker.scope as WorkerScope & { finishOpen: () => void }).finishOpen();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.sent).not.toContainEqual({ type: '__plugin_view_ready', payload: { instanceId: 'stalled' } });
  });
});

describe('wrapped worker startup and error grading', () => {
  it('posts ready only after synchronous user initialization completes', () => {
    const worker = wrappedWorker('self.init = "done";');
    const messages = sentMessages(worker.sent);
    expect(messages[messages.length - 1]).toEqual({ type: '__plugin_ready' });
    expect((worker.scope as WorkerScope & { init: string }).init).toBe('done');
  });

  it('never posts ready when synchronous initialization throws', () => {
    const sent: unknown[] = [];
    const scope = { postMessage: (message: unknown) => { sent.push(message); }, addEventListener: () => {} };
    expect(() => new Function('self', wrapPluginCode('self.init = 1; throw new Error("boom");'))(scope)).toThrow('boom');
    expect(sent).not.toContainEqual({ type: '__plugin_ready' });
  });

  it('reports an unhandled rejection as a diagnostic instead of a crash', () => {
    const worker = wrappedWorker('');
    worker.emit('unhandledrejection', { reason: new Error('oops') });
    expect(worker.sent).toContainEqual({
      type: '__plugin_error',
      payload: { kind: 'unhandledrejection', message: 'oops' },
    });
    expect(worker.sent).not.toContainEqual(expect.objectContaining({ type: '__plugin_crash' }));
  });
});

describe('wrapped worker HTTP pull streaming', () => {
  it('strips signal, carries a requestId, and cancels a pending open on abort', async () => {
    const worker = wrappedWorker(`
      self.controller = new AbortController();
      self.request = self.plugin.http.request({ url: 'https://example.com', signal: self.controller.signal });
    `);
    const scope = worker.scope as WorkerScope & { controller: AbortController };
    const open = sentMessages(worker.sent).find((message) => message.op === 'http.request')!;
    expect(open.args!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(open.args).not.toHaveProperty('signal');
    const request = scope.request!;
    scope.controller.abort();
    await expect(request).rejects.toThrow('aborted');
    const cancel = sentMessages(worker.sent).find((message) => message.op === 'http.cancel')!;
    expect(cancel.args).toEqual({ requestId: open.args!.requestId });
    worker.reply({ seq: open.seq!, ok: true, result: 'late' });
  });

  it('yields the final non-empty done chunk before ending and releases on return', async () => {
    const worker = wrappedWorker(`
      self.stream = self.plugin.http.stream({ url: 'https://example.com' });
    `);
    const open = sentMessages(worker.sent).find((message) => message.op === 'http.open')!;
    const requestId = open.args!.requestId as string;
    worker.reply({ seq: open.seq!, ok: true, result: { requestId, status: 200, headers: { a: 'b' }, url: 'https://example.com' } });
    const stream = await (worker.scope as WorkerScope & { stream: NonNullable<WorkerScope['stream']> }).stream;
    expect(stream.status).toBe(200);
    const iterator = stream.body[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();
    const read1 = sentMessages(worker.sent).find((message) => message.op === 'http.read')!;
    worker.reply({ seq: read1.seq!, ok: true, result: { bytes: new Uint8Array([1, 2]), done: false } });
    await expect(first).resolves.toEqual({ done: false, value: new Uint8Array([1, 2]) });
    const final = iterator.next();
    await Promise.resolve();
    const read2 = sentMessages(worker.sent).filter((message) => message.op === 'http.read')[1];
    worker.reply({ seq: read2.seq!, ok: true, result: { bytes: new Uint8Array([3]), done: true } });
    await expect(final).resolves.toEqual({ done: false, value: new Uint8Array([3]) });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('cancels the native request when the consumer returns early', async () => {
    const worker = wrappedWorker(`self.stream = self.plugin.http.stream({ url: 'https://example.com' });`);
    const open = sentMessages(worker.sent).find((message) => message.op === 'http.open')!;
    worker.reply({ seq: open.seq!, ok: true, result: { requestId: open.args!.requestId, status: 200, headers: {}, url: 'https://example.com' } });
    const stream = await (worker.scope as WorkerScope & { stream: NonNullable<WorkerScope['stream']> }).stream;
    const iterator = stream.body[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();
    const read = sentMessages(worker.sent).find((message) => message.op === 'http.read')!;
    worker.reply({ seq: read.seq!, ok: true, result: { bytes: new Uint8Array([1]), done: false } });
    await first;
    const returned = iterator.return!();
    const cancel = sentMessages(worker.sent).find((message) => message.op === 'http.cancel')!;
    expect(cancel.args).toEqual({ requestId: open.args!.requestId });
    worker.reply({ seq: cancel.seq!, ok: true, result: null });
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
  });

  it('rejects a pending next with AbortError and cancels the native request', async () => {
    const worker = wrappedWorker(`
      self.controller = new AbortController();
      self.stream = self.plugin.http.stream({ url: 'https://example.com', signal: self.controller.signal });
    `);
    const scope = worker.scope as WorkerScope & { controller: AbortController };
    const open = sentMessages(worker.sent).find((message) => message.op === 'http.open')!;
    worker.reply({ seq: open.seq!, ok: true, result: { requestId: open.args!.requestId, status: 200, headers: {}, url: 'https://example.com' } });
    const stream = await (scope as WorkerScope & { stream: NonNullable<WorkerScope['stream']> }).stream;
    const pending = stream.body[Symbol.asyncIterator]().next();
    await Promise.resolve();
    scope.controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = sentMessages(worker.sent).find((message) => message.op === 'http.cancel')!;
    expect(cancel.args).toEqual({ requestId: open.args!.requestId });
  });
});

describe('wrapped worker binary view transport', () => {
  it('delivers view.binary callbacks and acks ok after async handlers settle', async () => {
    const worker = wrappedWorker(`
      self.got = [];
      self.plugin.views.onOpen(function(view) {
        view.onBinary(function(message) { self.got.push(message); });
      });
    `);
    worker.reply({ type: 'view.open', eventId: 1, payload: { context: { viewInstanceId: 'view-a' }, documentId: 'doc' } });
    await vi.waitFor(() => expect(worker.sent).toContainEqual({
      type: '__plugin_view_ready', payload: { instanceId: 'view-a' },
    }));
    worker.reply({
      type: 'view.binary', eventId: 2,
      payload: { instanceId: 'view-a', transferId: 'transfer', type: 'data', bytes: new Uint8Array([9, 8]), documentId: 'doc' },
    });
    await vi.waitFor(() => expect(worker.sent).toContainEqual({ eventAck: 2, ok: true }));
    expect((worker.scope as WorkerScope & { got: Array<{ type: string; bytes: Uint8Array }> }).got)
      .toEqual([{ type: 'data', bytes: new Uint8Array([9, 8]) }]);
    expect(worker.sent).not.toContainEqual(expect.objectContaining({ type: '__plugin_view_error' }));
  });

  it('acks a binary handler rejection without retiring the view', async () => {
    const worker = wrappedWorker(`
      self.plugin.views.onOpen(function(view) {
        view.onBinary(function() { throw new Error('binary rejected'); });
      });
    `);
    worker.reply({ type: 'view.open', eventId: 1, payload: { context: { viewInstanceId: 'view-b' }, documentId: 'doc' } });
    await vi.waitFor(() => expect(worker.sent).toContainEqual({
      type: '__plugin_view_ready', payload: { instanceId: 'view-b' },
    }));
    worker.reply({
      type: 'view.binary', eventId: 3,
      payload: { instanceId: 'view-b', transferId: 'transfer', type: 'data', bytes: new Uint8Array([1]), documentId: 'doc' },
    });
    await vi.waitFor(() => expect(worker.sent).toContainEqual({ eventAck: 3, ok: false, error: 'binary rejected' }));
    expect(worker.sent).not.toContainEqual(expect.objectContaining({ type: '__plugin_view_error' }));
  });
});

describe('wrapped worker stream concurrency and explicit cancel', () => {
  async function openStream(worker: ReturnType<typeof wrappedWorker>) {
    const open = sentMessages(worker.sent).find((message) => message.op === 'http.open')!;
    worker.reply({ seq: open.seq!, ok: true, result: { requestId: open.args!.requestId, status: 200, headers: {}, url: 'https://example.com' } });
    return (worker.scope as WorkerScope & { stream: NonNullable<WorkerScope['stream']> }).stream;
  }

  it('serializes concurrent next() calls without losing a settlement', async () => {
    const worker = wrappedWorker(`self.stream = self.plugin.http.stream({ url: 'https://example.com' });`);
    const stream = await openStream(worker);
    const iterator = stream.body[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();
    await Promise.resolve();
    const read1 = sentMessages(worker.sent).find((message) => message.op === 'http.read')!;
    expect(sentMessages(worker.sent).filter((message) => message.op === 'http.read')).toHaveLength(1);
    worker.reply({ seq: read1.seq!, ok: true, result: { bytes: new Uint8Array([1]), done: false } });
    await expect(first).resolves.toEqual({ done: false, value: new Uint8Array([1]) });
    const read2 = sentMessages(worker.sent).filter((message) => message.op === 'http.read')[1];
    worker.reply({ seq: read2.seq!, ok: true, result: { bytes: new Uint8Array([2]), done: true } });
    await expect(second).resolves.toEqual({ done: false, value: new Uint8Array([2]) });
  });

  it('settles a pending next and surfaces cancel transport failure', async () => {
    const worker = wrappedWorker(`self.stream = self.plugin.http.stream({ url: 'https://example.com' });`);
    const stream = await openStream(worker);
    const pending = stream.body[Symbol.asyncIterator]().next();
    await Promise.resolve();
    const cancelled = stream.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = sentMessages(worker.sent).find((message) => message.op === 'http.cancel')!;
    worker.reply({ seq: cancel.seq!, ok: false, error: 'cancel transport failed' });
    await expect(cancelled).rejects.toThrow('cancel transport failed');
  });
});
