/** Bounded, document-scoped binary transport. Budgets cover owned raw buffers,
 * including the transient joined copy; application-retained bytes after ACK are
 * outside the transport's ownership. Neither budget is a file/HTTP quota. */
import type { PluginViewBinaryBytes } from '../types/pluginViews';

export const VIEW_BINARY_CHUNK_BYTES = 8 * 1024;
export const MAX_VIEW_BINARY_TRANSFER_BYTES = 256 * 1024 * 1024;
export const MAX_VIEW_BINARY_QUEUE_BYTES = MAX_VIEW_BINARY_TRANSFER_BYTES;
export const VIEW_BINARY_TRANSFER_IDLE_MS = 60_000;
export const VIEW_BINARY_ACK_TIMEOUT_MS = 30_000;
/** Absolute transport ownership lifetime, including queue time; unrelated to HTTP deadlines. */
export const VIEW_BINARY_TRANSFER_TIMEOUT_MS = 10 * 60_000;
export const MAX_ACTIVE_VIEW_BINARY_TRANSFERS = 4;
export const MAX_PLUGIN_VIEW_BINARY_BYTES = 512 * 1024 * 1024;
export const MAX_ALL_VIEW_BINARY_BYTES = 1024 * 1024 * 1024;
export const MAX_PLUGIN_VIEW_BINARY_TRANSFERS = 16;
export const MAX_ALL_VIEW_BINARY_TRANSFERS = 32;

/** One shared ledger for both directions and every view of an installation.
 * Reserve before allocating/copying. Release functions are idempotent. */
export class ViewBinaryBudget {
  private bytes = 0;
  private transfers = 0;
  private owners = new Map<string, { bytes: number; transfers: number }>();
  constructor(private maxOwnerBytes = MAX_PLUGIN_VIEW_BINARY_BYTES,
    private maxBytes = MAX_ALL_VIEW_BINARY_BYTES,
    private maxOwnerTransfers = MAX_PLUGIN_VIEW_BINARY_TRANSFERS,
    private maxTransfers = MAX_ALL_VIEW_BINARY_TRANSFERS) {}
  reserve(owner: string, bytes: number, transfers = 0): () => void {
    const entry = this.owners.get(owner) ?? { bytes: 0, transfers: 0 };
    if (entry.bytes + bytes > this.maxOwnerBytes || this.bytes + bytes > this.maxBytes ||
      entry.transfers + transfers > this.maxOwnerTransfers || this.transfers + transfers > this.maxTransfers) {
      throw new Error('plugin view binary aggregate capacity exceeded');
    }
    entry.bytes += bytes; entry.transfers += transfers;
    this.bytes += bytes; this.transfers += transfers; this.owners.set(owner, entry);
    let active = true;
    return () => {
      if (!active) return; active = false;
      entry.bytes -= bytes; entry.transfers -= transfers;
      this.bytes -= bytes; this.transfers -= transfers;
      if (!entry.bytes && !entry.transfers) this.owners.delete(owner);
    };
  }
}
export const viewBinaryBudget = new ViewBinaryBudget();

export interface ViewBinaryChunkMessage {
  type: 'binary-chunk'; documentId: string; transferId: string; transferType: string;
  seq: number; done: boolean; data: string;
}
export interface ViewBinaryAck {
  documentId: string; transferId: string; seq: number; done: boolean; ok: boolean; error?: string;
}
export interface IncomingViewBinaryChunk {
  documentId: string; transferId: string; transferType: string; seq: number; done: boolean; data: string;
}
export type InboundBinaryResult =
  | { kind: 'buffered' }
  | { kind: 'complete'; transferType: string; bytes: Uint8Array; release: () => void }
  | { kind: 'error'; error: string };
export interface ViewBinaryAbort { transferId: string; seq: number; done: boolean; reason: string }
export function viewBinaryBytes(value: PluginViewBinaryBytes): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError('binary view data must be Uint8Array or ArrayBuffer');
}
export function encodeViewBinaryBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
export function decodeViewBinaryBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(VIEW_BINARY_CHUNK_BYTES / 3) * 4) throw new TypeError('invalid binary chunk encoding');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export function viewBinaryType(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new TypeError('invalid binary view type');
  return value;
}
function validTransferId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : null;
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
interface SenderJob {
  transferType: string; bytes: Uint8Array; timer: ReturnType<typeof setTimeout>;
  deadline: number; deadlineTimer: ReturnType<typeof setTimeout>; error: Error | null;
  resolve: () => void; reject: (error: Error) => void; abort?: (error: Error) => void;
}
interface AckWaiter { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; done: boolean }
export interface ViewBinarySenderOptions {
  documentId: () => string | null; ready: () => boolean; send: (message: ViewBinaryChunkMessage) => Promise<void>;
}
export interface ViewBinarySenderLimits {
  maxTransferBytes?: number; maxQueueBytes?: number; ackMs?: number; idleMs?: number; totalMs?: number;
  budget?: ViewBinaryBudget; owner?: string;
}
/** Serializes transfers; each chunk has a transport/handler ACK deadline. */
export class ViewBinarySender {
  private queue: SenderJob[] = [];
  private active: SenderJob | null = null;
  private waiters = new Map<string, AckWaiter>();
  private pumping = false;
  private closedError: Error | null = null;
  private queuedBytes = 0;
  constructor(private options: ViewBinarySenderOptions, private limits: ViewBinarySenderLimits = {}) {}
  /** takeOwnership is only for a host-owned Worker RPC buffer, never a caller's mutable bytes. */
  send(type: string, value: PluginViewBinaryBytes, takeOwnership = false): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    const deadline = Date.now() + (this.limits.totalMs ?? VIEW_BINARY_TRANSFER_TIMEOUT_MS);
    const transferType = viewBinaryType(type);
    if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new TypeError('binary view data must be Uint8Array or ArrayBuffer');
    if (value.byteLength > (this.limits.maxTransferBytes ?? MAX_VIEW_BINARY_TRANSFER_BYTES)) return Promise.reject(new Error('view binary transfer exceeds capacity'));
    if (this.queuedBytes + value.byteLength > (this.limits.maxQueueBytes ?? MAX_VIEW_BINARY_QUEUE_BYTES) ||
      this.queue.length + (this.active ? 1 : 0) >= MAX_ACTIVE_VIEW_BINARY_TRANSFERS) return Promise.reject(new Error('view binary queue capacity exceeded'));
    let release: () => void;
    try { release = this.limits.budget?.reserve(this.limits.owner ?? '', value.byteLength, 1) ?? (() => {}); }
    catch (error) { return Promise.reject(error); }
    let bytes: Uint8Array;
    try {
      // Worker RPC already cloned these bytes into the main window. Adopt only
      // exact owned buffers; a subarray or SharedArrayBuffer needs a compact copy.
      bytes = takeOwnership && value instanceof ArrayBuffer ? new Uint8Array(value)
        : takeOwnership && value instanceof Uint8Array && value.buffer instanceof ArrayBuffer &&
          value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : viewBinaryBytes(value);
    } catch (error) { release(); throw error; }
    const size = bytes.byteLength;
    this.queuedBytes += size;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return; settled = true;
        clearTimeout(job.timer); clearTimeout(job.deadlineTimer);
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        if (error) {
          job.error = error;
          // Interrupt this job's current ACK/native-dispatch race, not the sender
          // or any other queued job. Retire its waiter synchronously for late ACKs.
          job.abort?.(error);
          if (this.active === job) {
            for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
            this.waiters.clear();
          }
        }
        release(); this.queuedBytes -= size;
        // Drop the sender's retained payload even if native send never settles.
        job.bytes = new Uint8Array(0);
        if (error) reject(error); else resolve();
      };
      const job: SenderJob = { transferType, bytes, deadline, error: null,
        timer: setTimeout(() => job.reject(new Error('view binary queue timed out')),
          this.limits.idleMs ?? VIEW_BINARY_TRANSFER_IDLE_MS),
        deadlineTimer: setTimeout(() => job.reject(new Error('view binary transfer timed out')),
          Math.max(0, deadline - Date.now())),
        resolve: () => finish(), reject: error => finish(error) };
      this.queue.push(job); this.pump();
    });
  }
  pump(): void {
    if (this.pumping || this.closedError) return;
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
      // A completion/rejection handler can enqueue while drain's final promise
      // is settling. Do not strand that healthy successor behind the old pump.
      if (this.queue.length && this.options.ready() && this.options.documentId()) this.pump();
    });
  }
  private async drain(): Promise<void> {
    while (!this.closedError && !this.active && this.queue.length) {
      if (!this.options.ready()) return;
      const documentId = this.options.documentId(); if (!documentId) return;
      const job = this.queue.shift()!; this.active = job; clearTimeout(job.timer);
      try { await this.transfer(job, documentId); job.resolve(); }
      catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))); }
      finally { this.active = null; }
    }
  }
  private async transfer(job: SenderJob, documentId: string): Promise<void> {
    const transferId = crypto.randomUUID();
    const total = Math.max(1, Math.ceil(job.bytes.length / VIEW_BINARY_CHUNK_BYTES));
    for (let seq = 0; seq < total; seq++) {
      if (this.closedError) throw this.closedError;
      if (job.error) throw job.error;
      if (Date.now() >= job.deadline) throw new Error('view binary transfer timed out');
      const key = `${transferId}:${seq}`; const done = seq === total - 1;
      let timer!: ReturnType<typeof setTimeout>;
      const expired = new Promise<never>((_resolve, reject) => {
        job.abort = reject;
        timer = setTimeout(() => reject(new Error('view binary ACK timed out')), this.limits.ackMs ?? VIEW_BINARY_ACK_TIMEOUT_MS);
      });
      const acknowledged = new Promise<void>((resolve, reject) => {
        this.waiters.set(key, { resolve, reject, timer, done });
      });
      const chunk: ViewBinaryChunkMessage = { type: 'binary-chunk', documentId, transferId, transferType: job.transferType,
        seq, done, data: encodeViewBinaryBase64(job.bytes.subarray(seq * VIEW_BINARY_CHUNK_BYTES, (seq + 1) * VIEW_BINARY_CHUNK_BYTES)) };
      try {
        // ACK is only accepted after native dispatch; a hung native invoke must
        // also lose its host-owned payload at the ACK deadline.
        const sending = this.options.send(chunk);
        await Promise.race([Promise.all([sending, acknowledged]), expired]);
        if (Date.now() >= job.deadline) throw new Error('view binary transfer timed out');
      } finally {
        clearTimeout(timer);
        this.waiters.delete(key);
        job.abort = undefined;
      }
    }
  }
  acknowledge(message: ViewBinaryAck): boolean {
    if (!validTransferId(message.transferId) || !integer(message.seq) || message.documentId !== this.options.documentId()) return false;
    const key = `${message.transferId}:${message.seq}`; const waiter = this.waiters.get(key);
    if (!waiter || waiter.done !== message.done || !this.active || this.active.error) return false;
    // A delayed timer callback must not allow an ACK at/after the absolute cutoff.
    if (Date.now() >= this.active.deadline) {
      this.active.reject(new Error('view binary transfer timed out'));
      return false;
    }
    this.waiters.delete(key);
    if (message.ok) waiter.resolve(); else waiter.reject(new Error(message.error || 'view binary receiver rejected the transfer'));
    return true;
  }
  cancel(reason: string): void {
    if (this.closedError) return; this.closedError = new Error(reason);
    for (const job of this.queue.splice(0)) job.reject(this.closedError);
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(this.closedError); }
    this.waiters.clear(); this.active?.abort?.(this.closedError); this.active?.reject(this.closedError);
  }
}
interface InboundTransfer {
  next: number; transferType: string; chunks: Uint8Array[]; total: number;
  updatedAt: number; lastSeq: number; lastDone: boolean;
  releases: Array<() => void>; timer: ReturnType<typeof setTimeout> | null;
}
export interface ViewBinaryReceiverOptions {
  now?: () => number; idleMs?: number; maxTransferBytes?: number; maxActive?: number;
  budget?: ViewBinaryBudget; owner?: string; abort?: (abort: ViewBinaryAbort) => void;
}
export class ViewBinaryReceiver {
  private transfers = new Map<string, InboundTransfer>();
  constructor(private options: ViewBinaryReceiverOptions = {}) {}
  private remove(id: string): void {
    const state = this.transfers.get(id); if (!state) return;
    clearTimeout(state.timer ?? undefined); state.releases.forEach(release => release());
    state.chunks.length = 0; this.transfers.delete(id);
  }
  private abort(id: string, reason: string): void {
    const state = this.transfers.get(id); if (!state) return;
    this.remove(id);
    try { this.options.abort?.({ transferId: id, seq: state.lastSeq, done: state.lastDone, reason }); }
    catch (error) { console.debug('[pluginViewBinary] abort notification failed', error); }
  }
  push(chunk: IncomingViewBinaryChunk): InboundBinaryResult {
    const now = (this.options.now ?? Date.now)(); const idle = this.options.idleMs ?? VIEW_BINARY_TRANSFER_IDLE_MS;
    for (const [id, state] of this.transfers) if (now - state.updatedAt >= idle) this.abort(id, 'binary transfer timed out');
    const id = validTransferId(chunk.transferId);
    if (!id) return { kind: 'error', error: 'invalid binary chunk metadata' };
    const error = (message: string): InboundBinaryResult => { this.remove(id); return { kind: 'error', error: message }; };
    if (!integer(chunk.seq) || typeof chunk.done !== 'boolean') return error('invalid binary chunk metadata');
    try { viewBinaryType(chunk.transferType); } catch { return error('invalid binary chunk metadata'); }
    let bytes: Uint8Array;
    try { bytes = decodeViewBinaryBase64(chunk.data); } catch { return error('invalid binary chunk encoding'); }
    if (bytes.length > VIEW_BINARY_CHUNK_BYTES) return error('binary chunk exceeds 8 KiB');
    // Non-final empty chunks otherwise grow an unbounded array of zero-byte objects.
    if (!chunk.done && !bytes.length) return error('empty non-final binary chunk');
    let state = this.transfers.get(id);
    if (!state) {
      if (chunk.seq !== 0) return error('binary chunk order mismatch');
      if (this.transfers.size >= (this.options.maxActive ?? MAX_ACTIVE_VIEW_BINARY_TRANSFERS)) {
        const oldest = [...this.transfers].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (oldest) this.abort(oldest[0], 'too many binary transfers');
      }
      let release: () => void;
      try { release = this.options.budget?.reserve(this.options.owner ?? '', 0, 1) ?? (() => {}); }
      catch { return error('plugin view binary aggregate capacity exceeded'); }
      state = { next: 0, transferType: chunk.transferType, chunks: [], total: 0, updatedAt: now, lastSeq: 0, lastDone: false, releases: [release], timer: null };
      this.transfers.set(id, state);
    }
    if (chunk.seq !== state.next || chunk.transferType !== state.transferType) return error('binary chunk order mismatch');
    if (state.total + bytes.length > (this.options.maxTransferBytes ?? MAX_VIEW_BINARY_TRANSFER_BYTES)) return error('binary transfer exceeds capacity');
    if (state.next >= Math.ceil((this.options.maxTransferBytes ?? MAX_VIEW_BINARY_TRANSFER_BYTES) / VIEW_BINARY_CHUNK_BYTES) && !chunk.done) return error('too many binary chunks');
    try { state.releases.push(this.options.budget?.reserve(this.options.owner ?? '', bytes.length) ?? (() => {})); }
    catch { return error('plugin view binary aggregate capacity exceeded'); }
    state.chunks.push(bytes); state.total += bytes.length; state.next++;
    state.updatedAt = now; state.lastSeq = chunk.seq; state.lastDone = chunk.done;
    clearTimeout(state.timer ?? undefined);
    state.timer = setTimeout(() => this.abort(id, 'binary transfer timed out'), idle);
    if (!chunk.done) return { kind: 'buffered' };
    // Joining briefly owns both buffers. Reserve that peak, then replace the
    // chunk reservations with a completed-buffer lease lasting until Worker ACK.
    let releaseJoined: () => void;
    try { releaseJoined = this.options.budget?.reserve(this.options.owner ?? '', state.total) ?? (() => {}); }
    catch { return error('plugin view binary aggregate capacity exceeded'); }
    try {
      const joined = new Uint8Array(state.total); let offset = 0;
      for (const part of state.chunks) { joined.set(part, offset); offset += part.length; }
      // Move, rather than duplicate, the transfer slot into the completed lease.
      // All slots may legitimately be full when an existing transfer completes.
      const releaseSlot = state.releases.shift()!;
      this.remove(id);
      return { kind: 'complete', transferType: state.transferType, bytes: joined,
        release: () => { releaseJoined(); releaseSlot(); } };
    } catch (cause) { releaseJoined(); return error(String(cause)); }
  }
  reset(): void { for (const id of [...this.transfers.keys()]) this.remove(id); }
}
