/**
 * Bidirectional plugin view binary transport.
 *
 * Native IPC envelopes stay small (8 KiB raw / ~11 KiB base64 JSON), so a
 * transfer is a sequence of `binary-chunk` messages. The sender keeps exactly
 * one chunk in flight and waits for its `binary-ack`; the receiver only
 * exposes a complete byte string after every ordered chunk arrived. There is
 * no total-size limit and no interaction/rate token bucket on this path.
 */
import type { PluginViewBinaryBytes } from '../types/pluginViews';

export const VIEW_BINARY_CHUNK_BYTES = 8 * 1024;
const MAX_TRANSFER_TYPE = 128;
const MAX_ACTIVE_INBOUND = 4;

export interface ViewBinaryChunkMessage {
  type: 'binary-chunk';
  documentId: string;
  transferId: string;
  transferType: string;
  seq: number;
  done: boolean;
  data: string;
}

export interface ViewBinaryAckMessage {
  type: 'binary-ack';
  documentId: string;
  transferId: string;
  seq: number;
  done: boolean;
  ok: boolean;
  error?: string;
}

export interface ViewBinaryAck {
  documentId: string;
  transferId: string;
  seq: number;
  done: boolean;
  ok: boolean;
  error?: string;
}

export interface IncomingViewBinaryChunk {
  documentId: string;
  transferId: string;
  transferType: string;
  seq: number;
  done: boolean;
  data: string;
}

export type InboundBinaryResult =
  | { kind: 'buffered' }
  | { kind: 'complete'; transferType: string; bytes: Uint8Array }
  | { kind: 'error'; error: string };

export function viewBinaryBytes(value: PluginViewBinaryBytes): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError('binary view data must be Uint8Array or ArrayBuffer');
}

export function encodeViewBinaryBase64(bytes: Uint8Array): string {
  let binary = '';
  // 0x8000 bytes per call keeps String.fromCharCode argument counts bounded.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function decodeViewBinaryBase64(value: string): Uint8Array {
  if (typeof value !== 'string') throw new TypeError('binary chunk data must be base64 text');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function viewBinaryType(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_TRANSFER_TYPE) throw new TypeError('invalid binary view type');
  return value;
}

function validTransferId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface SenderJob {
  transferType: string;
  bytes: Uint8Array;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface AckWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface ViewBinarySenderOptions {
  documentId: () => string | null;
  ready: () => boolean;
  send: (message: ViewBinaryChunkMessage) => Promise<void>;
}

/** Serializes complete transfers for one view instance; one chunk in flight. */
export class ViewBinarySender {
  private readonly options: ViewBinarySenderOptions;
  private queue: SenderJob[] = [];
  private active: SenderJob | null = null;
  private waiters = new Map<string, AckWaiter>();
  private pumping = false;
  private closed = false;
  private closedError: Error | null = null;

  constructor(options: ViewBinarySenderOptions) {
    this.options = options;
  }

  send(type: string, value: PluginViewBinaryBytes): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError ?? new Error('view binary channel closed'));
    const transferType = viewBinaryType(type);
    const bytes = viewBinaryBytes(value);
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ transferType, bytes, resolve, reject });
      void this.pump();
    });
  }

  /** Called whenever the current document may have become ready. */
  pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    void this.drain().finally(() => { this.pumping = false; });
  }

  private async drain(): Promise<void> {
    while (!this.closed && !this.active && this.queue.length > 0) {
      if (!this.options.ready()) return;
      const documentId = this.options.documentId();
      if (!documentId) return;
      const job = this.queue.shift()!;
      this.active = job;
      try {
        await this.transfer(job, documentId);
        if (!this.closed) job.resolve();
      } catch (error) {
        job.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.active = null;
      }
    }
  }

  private async transfer(job: SenderJob, documentId: string): Promise<void> {
    const transferId = crypto.randomUUID();
    const total = Math.max(1, Math.ceil(job.bytes.length / VIEW_BINARY_CHUNK_BYTES));
    for (let seq = 0; seq < total; seq++) {
      if (this.closed) throw this.closedError ?? new Error('view binary channel closed');
      const start = seq * VIEW_BINARY_CHUNK_BYTES;
      const end = Math.min(job.bytes.length, start + VIEW_BINARY_CHUNK_BYTES);
      const done = seq === total - 1;
      const key = `${transferId}:${seq}`;
      const acknowledged = new Promise<void>((resolve, reject) => { this.waiters.set(key, { resolve, reject }); });
      // Cancellation may reject while the native send is still pending; observe
      // that rejection immediately and still surface it from the await below.
      acknowledged.catch(() => {});
      const chunk: ViewBinaryChunkMessage = {
        type: 'binary-chunk', documentId, transferId, transferType: job.transferType,
        seq, done, data: encodeViewBinaryBase64(job.bytes.subarray(start, end)),
      };
      try {
        await this.options.send(chunk);
      } catch (error) {
        this.waiters.delete(key);
        throw error;
      }
      await acknowledged;
    }
  }

  /** Route a native `binary-ack` event; unrelated/late acknowledgements are ignored. */
  acknowledge(message: ViewBinaryAck): boolean {
    const seq = nonNegativeInteger(message.seq);
    const transferId = validTransferId(message.transferId);
    const currentDocument = this.options.documentId();
    if (!transferId || seq === null || !currentDocument || message.documentId !== currentDocument) return false;
    const key = `${transferId}:${seq}`;
    const waiter = this.waiters.get(key);
    if (!waiter) return false;
    this.waiters.delete(key);
    if (message.ok) waiter.resolve();
    else waiter.reject(new Error(message.error || 'view binary receiver rejected the transfer'));
    return true;
  }

  cancel(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedError = new Error(reason);
    const pending = this.queue.splice(0);
    for (const job of pending) job.reject(this.closedError);
    for (const waiter of this.waiters.values()) waiter.reject(this.closedError);
    this.waiters.clear();
    if (this.active) { this.active.reject(this.closedError); this.active = null; }
  }
}

interface InboundTransfer {
  next: number;
  transferType: string;
  chunks: Uint8Array[];
  total: number;
}

/** Reassembles UI -> Worker chunks; only complete transfers leave this object. */
export class ViewBinaryReceiver {
  private transfers = new Map<string, InboundTransfer>();

  push(chunk: IncomingViewBinaryChunk): InboundBinaryResult {
    const transferId = validTransferId(chunk.transferId);
    const seq = nonNegativeInteger(chunk.seq);
    const transferType = typeof chunk.transferType === 'string' && chunk.transferType && chunk.transferType.length <= MAX_TRANSFER_TYPE
      ? chunk.transferType : null;
    if (!transferId) return { kind: 'error', error: 'invalid binary chunk metadata' };
    const release = (): void => { this.transfers.delete(transferId); };
    if (seq === null || !transferType || typeof chunk.done !== 'boolean') {
      release();
      return { kind: 'error', error: 'invalid binary chunk metadata' };
    }
    let bytes: Uint8Array;
    try { bytes = decodeViewBinaryBase64(chunk.data); }
    catch { release(); return { kind: 'error', error: 'invalid binary chunk encoding' }; }
    if (bytes.length > VIEW_BINARY_CHUNK_BYTES) { release(); return { kind: 'error', error: 'binary chunk exceeds 8 KiB' }; }
    let state = this.transfers.get(transferId);
    if (!state) {
      if (seq !== 0) return { kind: 'error', error: 'binary chunk order mismatch' };
      if (this.transfers.size >= MAX_ACTIVE_INBOUND) return { kind: 'error', error: 'too many binary transfers' };
      state = { next: 0, transferType, chunks: [], total: 0 };
      this.transfers.set(transferId, state);
    }
    if (seq !== state.next || state.transferType !== transferType) {
      this.transfers.delete(transferId);
      return { kind: 'error', error: 'binary chunk order mismatch' };
    }
    state.chunks.push(bytes);
    state.total += bytes.length;
    state.next++;
    if (!chunk.done) return { kind: 'buffered' };
    this.transfers.delete(transferId);
    const joined = new Uint8Array(state.total);
    let offset = 0;
    for (const part of state.chunks) { joined.set(part, offset); offset += part.length; }
    return { kind: 'complete', transferType: state.transferType, bytes: joined };
  }

  reset(): void {
    this.transfers.clear();
  }
}
