import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_HTTP_RPC_TIMEOUT_MS, PLUGIN_RPC_TIMEOUT_MS, wrapPluginCode } from './pluginBridge';

type RpcReply = { seq: number; ok: boolean; result?: unknown; error?: string };
type WorkerScope = {
  plugin?: { api: Record<string, (args?: unknown) => Promise<unknown>> };
  onmessage?: (event: { data: RpcReply }) => void;
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
  const reply = (message: RpcReply) => scope.onmessage?.({ data: message });
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

  it('rejects immediately when posting cannot clone arguments', async () => {
    const worker = wrappedWorker('');
    worker.scope.postMessage = () => { throw new Error('clone failed'); };
    await expect(worker.scope.plugin!.api.log({ value: () => {} })).rejects.toThrow('clone failed');
  });
});
