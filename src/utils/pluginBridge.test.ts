import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_HTTP_RPC_TIMEOUT_MS, PLUGIN_RPC_TIMEOUT_MS, wrapPluginCode } from './pluginBridge';

type RpcReply = { seq: number; ok: boolean; result?: unknown; error?: string };
type HostEvent = { type: string; payload?: unknown; eventId?: number };
type WorkerScope = {
  plugin?: {
    api: Record<string, (args?: unknown) => Promise<unknown>>;
    on: (type: string, callback: (payload: unknown) => unknown) => () => void;
  };
  onmessage?: (event: { data: RpcReply | HostEvent }) => void;
  postMessage: (message: unknown) => void;
  addEventListener: (type: string, handler: (event: { reason: unknown }) => void) => void;
  request?: Promise<unknown>;
};

function wrappedWorker(source: string) {
  const sent: unknown[] = [];
  const scope: WorkerScope = {
    postMessage: (message) => { sent.push(message); },
    addEventListener: () => {},
  };
  new Function('self', wrapPluginCode(source))(scope);
  const reply = (message: RpcReply | HostEvent) => scope.onmessage?.({ data: message });
  return { scope, sent, reply };
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

  it('leaves 15-second HTTP and user-controlled file picker work pending until host reply', async () => {
    vi.useFakeTimers();
    const worker = wrappedWorker('self.http = self.plugin.api["http.request"]({}); self.dialog = self.plugin.api["fs.openDialog"]({});');
    const http = (worker.scope as WorkerScope & { http: Promise<unknown> }).http;
    const dialog = (worker.scope as WorkerScope & { dialog: Promise<unknown> }).dialog;
    await vi.advanceTimersByTimeAsync(15_500);
    worker.reply({ seq: 1, ok: true, result: 'http success' });
    await expect(http).resolves.toBe('http success');
    await vi.advanceTimersByTimeAsync(PLUGIN_HTTP_RPC_TIMEOUT_MS + 100_000);
    worker.reply({ seq: 2, ok: true, result: 'selected' });
    await expect(dialog).resolves.toBe('selected');
  });

  it('leaves user-controlled panel export pending until the host finishes', async () => {
    vi.useFakeTimers();
    const worker = wrappedWorker('self.request = self.plugin.api["ui.panel.export"]();');
    const outcome = vi.fn();
    const request = worker.scope.request!.then(outcome, outcome);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(outcome).not.toHaveBeenCalled();
    worker.reply({ seq: 1, ok: true, result: 'exported' });
    await request;
    expect(outcome).toHaveBeenCalledWith('exported');
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
