import { pluginFsService } from '../services/pluginFs';
import type { PluginFsPage, PluginFsPageOptions, PluginFsPriority, PluginFsRange, PluginFsResults } from '../services/pluginFs';
import { PluginLogQuota } from './pluginLogQuota';

const MAX_PENDING_CANCELS = 64;
const MAX_PRE_CANCELLED = 64;
interface RequestState { cancelled: boolean; sessionId?: string }
interface ResponseLease {
  release: () => Promise<void>;
  pending: Promise<void> | null;
  released: boolean;
}
const leases = new WeakMap<object, ResponseLease>();

/** Internal response ownership; failures remain retryable and concurrent releases coalesce. */
export function attachPluginFsLease(result: object, release: () => Promise<void>): void {
  leases.set(result, { release, pending: null, released: false });
}
export async function releasePluginFsResult(result: unknown): Promise<void> {
  if (result === null || typeof result !== 'object') return;
  const lease = leases.get(result);
  if (!lease || lease.released) return;
  if (!lease.pending) {
    const pending: Promise<void> = Promise.resolve().then(lease.release).then(() => {
      lease.released = true;
      if (leases.get(result) === lease) leases.delete(result);
    }).finally(() => {
      if (lease.pending === pending) lease.pending = null;
    });
    lease.pending = pending;
  }
  await lease.pending;
}
/** One bounded retry of idempotent cleanup only; never retries the file operation. */
export async function releasePluginFsResultWithRetry(result: unknown, onFailure?: (error: unknown) => void): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await releasePluginFsResult(result); return; }
    catch (error) { if (attempt === 1) onFailure?.(error); }
  }
}
function moveLease(from: object, to: object): void {
  const lease = leases.get(from);
  if (lease) { leases.delete(from); leases.set(to, lease); }
}
function aborted(): Error {
  const error = new Error('plugin FS request aborted');
  error.name = 'AbortError';
  return error;
}

/** One root Worker epoch. Construction never invokes native IPC (old plugins stay unchanged). */
export class PluginFsContext {
  private alive = true;
  private sessionId: string | null = null;
  private opening: Promise<string> | null = null;
  private readonly requests = new Map<string, RequestState>();
  private readonly preCancelled = new Set<string>();
  private readonly pendingCancels = new Map<string, Promise<void>>();
  private readonly cleanupLogQuota = new PluginLogQuota();

  constructor(readonly pluginId: string, readonly installGeneration: string, readonly workerEpoch: number) {}

  private assertLive(beforeSend?: () => void): void {
    if (!this.alive) throw new Error('plugin FS session retired');
    beforeSend?.();
  }

  private getSession(beforeSend?: () => void): Promise<string> {
    this.assertLive(beforeSend);
    if (this.sessionId) return Promise.resolve(this.sessionId);
    if (!this.opening) {
      const opening = pluginFsService.openSession(this.pluginId, this.installGeneration).then(async sessionId => {
        if (!this.alive) {
          await pluginFsService.closeSession(this.pluginId, sessionId);
          throw new Error('plugin FS session retired');
        }
        this.sessionId = sessionId;
        return sessionId;
      });
      this.opening = opening;
      void opening.catch(() => { if (this.opening === opening) this.opening = null; });
    }
    return this.opening;
  }

  private begin(requestId: string, beforeSend?: () => void): RequestState {
    this.assertLive(beforeSend);
    if (this.requests.has(requestId)) throw new Error('duplicate plugin FS requestId');
    if (this.preCancelled.delete(requestId)) throw aborted();
    const state = { cancelled: false };
    this.requests.set(requestId, state);
    return state;
  }

  private checkRequest(state: RequestState, beforeSend?: () => void): void {
    this.assertLive(beforeSend);
    if (state.cancelled) throw aborted();
  }

  private invalidateSession(error: unknown, sessionId: string | undefined): void {
    const message = error instanceof Error ? error.message : String(error);
    if (sessionId && this.sessionId === sessionId && message.includes('PLUGIN_FS_SESSION_INVALID')) {
      this.sessionId = null;
      this.opening = null;
    }
  }

  private async nativeCancel(sessionId: string, requestId: string): Promise<void> {
    const existing = this.pendingCancels.get(requestId);
    if (existing) return existing;
    if (this.pendingCancels.size >= MAX_PENDING_CANCELS) throw new Error('plugin FS cancel capacity exceeded');
    const pending = pluginFsService.cancel(this.pluginId, sessionId, requestId);
    this.pendingCancels.set(requestId, pending);
    try { await pending; }
    catch (error) { this.invalidateSession(error, sessionId); throw error; }
    finally { this.pendingCancels.delete(requestId); }
  }

  private reportReleaseFailure = (): void => {
    const verdict = this.cleanupLogQuota.tryConsume(Date.now());
    if (verdict.allowed) {
      console.warn(`[pluginFs] ${this.pluginId} release failed; native reaper will reclaim`);
    } else if (verdict.warn) {
      console.warn(`[pluginFs] ${this.pluginId} cleanup diagnostics suppressed: ${verdict.droppedTotal}`);
    }
  };

  private attachRequestLease(result: object, sessionId: string, requestId: string): void {
    attachPluginFsLease(result, async () => {
      // Drop host bookkeeping even if native cleanup fails; the WeakMap retains
      // retry ownership without accumulating historical IDs in the live context.
      this.requests.delete(requestId);
      await pluginFsService.release(this.pluginId, sessionId, requestId);
    });
  }

  private async cleanupRequest(sessionId: string | undefined, requestId: string): Promise<void> {
    this.requests.delete(requestId);
    if (!sessionId) return;
    const cleanup = {};
    this.attachRequestLease(cleanup, sessionId, requestId);
    await releasePluginFsResultWithRetry(cleanup, this.reportReleaseFailure);
  }

  /** Cancel never opens or waits for a session; a bounded tombstone handles cancel-before-read. */
  async cancel(requestId: string): Promise<void> {
    this.assertLive();
    const state = this.requests.get(requestId);
    if (state) state.cancelled = true;
    else {
      this.preCancelled.delete(requestId);
      this.preCancelled.add(requestId);
      while (this.preCancelled.size > MAX_PRE_CANCELLED) this.preCancelled.delete(this.preCancelled.values().next().value!);
    }
    if (state?.sessionId) await this.nativeCancel(state.sessionId, requestId);
    else if (this.sessionId) await this.nativeCancel(this.sessionId, requestId);
    // If open is still pending, local cancellation is sufficient: the waiting
    // read checks its state before dispatch. Never occupy a cancel slot awaiting open.
  }

  async readRanges(requestId: string, ranges: PluginFsRange[], priority: PluginFsPriority, beforeSend?: () => void): Promise<PluginFsResults> {
    const state = this.begin(requestId, beforeSend);
    let sessionId: string | undefined;
    let leased = false;
    try {
      sessionId = await this.getSession(beforeSend);
      state.sessionId = sessionId;
      this.checkRequest(state, beforeSend);
      const result = await pluginFsService.readRanges(this.pluginId, this.installGeneration, sessionId, requestId, ranges, priority);
      this.checkRequest(state, beforeSend);
      this.attachRequestLease(result, sessionId, requestId);
      leased = true;
      return result;
    } catch (error) {
      this.invalidateSession(error, sessionId);
      throw error;
    } finally {
      if (!leased) await this.cleanupRequest(sessionId, requestId);
    }
  }

  async readRange(requestId: string, range: PluginFsRange, priority: PluginFsPriority, beforeSend?: () => void): Promise<Uint8Array> {
    const result = await this.readRanges(requestId, [range], priority, beforeSend);
    const item = result.results[0];
    if ('error' in item) {
      await releasePluginFsResultWithRetry(result, this.reportReleaseFailure);
      throw new Error(item.error);
    }
    moveLease(result, item.bytes);
    return item.bytes;
  }

  async listDirectoryPage(requestId: string, options: PluginFsPageOptions, beforeSend?: () => void): Promise<PluginFsPage> {
    const state = this.begin(requestId, beforeSend);
    let sessionId: string | undefined;
    let leased = false;
    try {
      sessionId = await this.getSession(beforeSend);
      state.sessionId = sessionId;
      this.checkRequest(state, beforeSend);
      const page = await pluginFsService.listDirectoryPage(this.pluginId, this.installGeneration, sessionId, requestId, options);
      this.checkRequest(state, beforeSend);
      this.attachRequestLease(page, sessionId, requestId);
      leased = true;
      return page;
    } catch (error) {
      this.invalidateSession(error, sessionId);
      throw error;
    } finally {
      if (!leased) await this.cleanupRequest(sessionId, requestId);
    }
  }

  /** Mark dead before any cleanup IPC; a late open closes itself instead of becoming usable. */
  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const state of this.requests.values()) state.cancelled = true;
    this.preCancelled.clear();
    for (const [requestId, state] of this.requests) {
      if (state.sessionId) void this.nativeCancel(state.sessionId, requestId).catch(() => undefined);
    }
    if (this.sessionId) {
      void pluginFsService.closeSession(this.pluginId, this.sessionId).catch(() => undefined);
    }
  }
}

/** Transfer each underlying buffer once, even for batch entries sharing a payload. */
export function pluginFsTransferables(result: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const collect = (value: unknown): void => {
    if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
  };
  collect(result);
  if (result !== null && typeof result === 'object' && 'results' in result && Array.isArray(result.results)) {
    for (const item of result.results) if (item && typeof item === 'object' && 'bytes' in item) collect(item.bytes);
  }
  return [...buffers];
}
