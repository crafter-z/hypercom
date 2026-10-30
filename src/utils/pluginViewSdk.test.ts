import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sdkSource from '../../src-tauri/src/plugin/view_runtime/sdk.js?raw';
import { VIEW_BINARY_ACK_TIMEOUT_MS, VIEW_BINARY_TRANSFER_IDLE_MS } from './pluginViewBinary';

type Wire = { type: string; documentId?: string; transferId?: string; transferType?: string; seq?: number; done?: boolean; data?: string; ok?: boolean; error?: string; revision?: number; [key: string]: unknown };
interface Page {
  view: { sendBinary: (type: string, bytes: Uint8Array) => Promise<void>; onBinary: (callback: (payload: { type: string; bytes: Uint8Array }) => unknown) => () => void; onState: (callback: (snapshot: unknown) => unknown) => () => void };
  __hypercomViewDocumentStart: (id: string) => void;
  __hypercomViewDispatch: (message: Wire) => void;
}
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function page(hasWorker = true, small = false) {
  const sent: Wire[] = [];
  const scope = { ipc: { postMessage: (encoded: string) => sent.push(JSON.parse(encoded) as Wire) } } as unknown as Page;
  let source = sdkSource.replace('__HOST_TRUSTED_WEB__', 'false').replace('__HOST_HAS_WORKER__', String(hasWorker)).replace('__HOST_VIEW_CONTEXT__', JSON.stringify({ viewInstanceId: 'view-a' }));
  // Run production code with tiny budgets to exercise peak accounting without
  // allocating hundreds of MiB in the test runner. Other cases use exact constants.
  if (small) source = source.replace(/const MAX_BINARY_TRANSFER_BYTES = [^;]+;/, 'const MAX_BINARY_TRANSFER_BYTES = 8;').replace(/const MAX_BINARY_BYTES = [^;]+;/, 'const MAX_BINARY_BYTES = 12;');
  new Function('globalThis', 'addEventListener', source)(scope, () => {});
  scope.__hypercomViewDocumentStart('doc-a');
  const dispatch = (message: Wire) => scope.__hypercomViewDispatch({ documentId: 'doc-a', ...message });
  dispatch({ type: 'init', context: { viewInstanceId: 'view-a' }, environment: {} });
  return { scope, sent, dispatch };
}
function chunk(overrides: Partial<Wire> = {}): Wire {
  return { type: 'binary-chunk', transferId: 'in-a', transferType: 'blob', seq: 0, done: false, data: btoa('ab'), ...overrides };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('real injected page SDK execution', () => {
  it('performs exact multi-chunk roundtrips against the production script and waits for the final handler ACK', async () => {
    const p = page(); await settle();
    const input = new Uint8Array(8192 + 37).map((_, index) => index % 256);
    const outbound = p.scope.view.sendBinary('blob', input);
    let settled = false; void outbound.then(() => { settled = true; });
    const first = p.sent.find(message => message.type === 'binary-chunk')!;
    expect(atob(first.data!).length).toBe(8192); expect(first.done).toBe(false);
    p.dispatch({ ...first, type: 'binary-ack', ok: true, documentId: 'stale' }); await settle();
    expect(p.sent.filter(message => message.type === 'binary-chunk')).toHaveLength(1);
    p.dispatch({ ...first, type: 'binary-ack', ok: true }); await settle();
    const last = p.sent.filter(message => message.type === 'binary-chunk')[1];
    expect(last.seq).toBe(1); expect(last.done).toBe(true); expect(settled).toBe(false);
    const encoded = first.data! + ''; // Each base64 frame is decoded separately.
    const actual = [...atob(encoded), ...atob(last.data!)].map(value => value.charCodeAt(0));
    expect(actual).toEqual([...input]);
    p.dispatch({ ...last, type: 'binary-ack', ok: true }); await outbound;

    let complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    const received: Uint8Array[] = [];
    p.scope.view.onBinary(payload => { received.push(payload.bytes); return gate; });
    p.dispatch({ ...first, transferId: 'roundtrip' }); await settle();
    expect(p.sent).toContainEqual(expect.objectContaining({ type: 'binary-ack', transferId: 'roundtrip', seq: 0, ok: true }));
    p.dispatch({ ...last, transferId: 'roundtrip' }); await settle();
    expect([...received[0]]).toEqual([...input]);
    expect(p.sent.some(message => message.type === 'binary-ack' && message.transferId === 'roundtrip' && message.done)).toBe(false);
    complete(); await settle();
    expect(p.sent).toContainEqual(expect.objectContaining({ type: 'binary-ack', transferId: 'roundtrip', seq: 1, ok: true }));
  });

  it('expires outbound ACK waits, ignores late ACKs, and restores all four slots', async () => {
    const p = page(); await settle();
    const waiting = Array.from({ length: 4 }, () => p.scope.view.sendBinary('blob', new Uint8Array(0)));
    const outcomes = waiting.map(result => expect(result).rejects.toThrow('ACK timed out'));
    await expect(p.scope.view.sendBinary('blob', new Uint8Array(0))).rejects.toThrow('aggregate capacity');
    await vi.advanceTimersByTimeAsync(VIEW_BINARY_ACK_TIMEOUT_MS); await Promise.all(outcomes);
    const old = p.sent.find(message => message.type === 'binary-chunk')!;
    const next = p.scope.view.sendBinary('blob', new Uint8Array([9]));
    p.dispatch({ ...old, type: 'binary-ack', ok: true });
    const fresh = p.sent.filter(message => message.type === 'binary-chunk').slice(-1)[0]!;
    p.dispatch({ ...fresh, type: 'binary-ack', ok: true }); await next;
  });

  it('actively reclaims all idle half-transfers without new traffic', async () => {
    const p = page(); await settle();
    for (let index = 0; index < 4; index++) p.dispatch(chunk({ transferId: `idle-${index}` }));
    await settle();
    await expect(p.scope.view.sendBinary('blob', new Uint8Array(0))).rejects.toThrow('aggregate capacity');
    await vi.advanceTimersByTimeAsync(VIEW_BINARY_TRANSFER_IDLE_MS);
    expect(p.sent.filter(message => message.type === 'binary-ack' && !message.ok && message.error?.includes('timed out'))).toHaveLength(4);
    const next = p.scope.view.sendBinary('blob', new Uint8Array(0));
    const wire = p.sent.filter(message => message.type === 'binary-chunk').slice(-1)[0]!;
    p.dispatch({ ...wire, type: 'binary-ack', ok: true }); await next;
  });

  it('accounts inbound/outbound bytes jointly and reserves the transient joined copy', async () => {
    const p = page(true, true); await settle();
    const outgoing = p.scope.view.sendBinary('blob', new Uint8Array(5));
    const outgoingWire = p.sent.find(message => message.type === 'binary-chunk')!;
    const rejectedCopy = new Uint8Array(8); const copy = vi.spyOn(rejectedCopy, 'slice');
    await expect(p.scope.view.sendBinary('blob', rejectedCopy)).rejects.toThrow('aggregate capacity'); expect(copy).not.toHaveBeenCalled();
    p.dispatch(chunk({ done: true, data: btoa('12345') })); await settle();
    expect(p.sent).toContainEqual(expect.objectContaining({ type: 'binary-ack', transferId: 'in-a', ok: false, error: expect.stringContaining('aggregate capacity') }));
    p.dispatch({ ...outgoingWire, type: 'binary-ack', ok: true }); await outgoing;
    p.dispatch(chunk({ transferId: 'in-b', done: true, data: btoa('123456') })); await settle();
    expect(p.sent).toContainEqual(expect.objectContaining({ type: 'binary-ack', transferId: 'in-b', ok: true }));
    await expect(p.scope.view.sendBinary('blob', new Uint8Array(9))).rejects.toThrow('transfer exceeds');
  });

  it('bounds a stalled async binary handler without blocking the independent state ACK lane', async () => {
    const p = page(); await settle();
    p.scope.view.onBinary(() => new Promise(() => {}));
    p.dispatch(chunk({ done: true })); await settle();
    p.dispatch({ type: 'state', revision: 1, snapshot: { value: 1 } }); await settle();
    expect(p.sent).toContainEqual({ type: 'state-ack', documentId: 'doc-a', revision: 1 });
    await vi.advanceTimersByTimeAsync(VIEW_BINARY_ACK_TIMEOUT_MS);
    expect(p.sent).toContainEqual(expect.objectContaining({ type: 'binary-ack', ok: false, error: expect.stringContaining('handler ACK timed out') }));
    expect(p.sent).toContainEqual({ type: 'state-ack', documentId: 'doc-a', revision: 1 });
  });

  it('rejects malformed chunks and no-Worker pages without corrupting the next transfer', async () => {
    const p = page(); await settle();
    p.dispatch(chunk({ data: '' })); await settle();
    expect(p.sent).toContainEqual(expect.objectContaining({ type: 'binary-ack', ok: false }));
    p.dispatch(chunk({ transferId: 'valid', done: true })); await settle();
    expect(p.sent).toContainEqual(expect.objectContaining({ type: 'binary-ack', transferId: 'valid', ok: true }));
    const independent = page(false); await settle();
    await expect(independent.scope.view.sendBinary('blob', new Uint8Array(1))).rejects.toThrow('no Worker');
  });
});
