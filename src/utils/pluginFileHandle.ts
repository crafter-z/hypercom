import { pluginFileHandleService, PLUGIN_FILE_WINDOW_BYTES } from '../services/pluginFileHandle';
import type { PluginFilePickOptions, PluginFileRequest, PluginFileSelection } from '../services/pluginFileHandle';
import { pluginFsService } from '../services/pluginFs';
import { attachPluginFsLease, releasePluginFsResultWithRetry } from './pluginFs';

export const PLUGIN_FILE_HANDLE_REQUEST_OPS = [
  'fs.openFile', 'fs.createFile', 'fs.readFileWindow', 'fs.writeFileChunk', 'fs.commitFile',
] as const;
export const PLUGIN_FILE_HANDLE_OPS = [
  ...PLUGIN_FILE_HANDLE_REQUEST_OPS, 'fs.closeFile', 'fs.cancelFileRequest',
] as const;
export type PluginFileHandleOperation = typeof PLUGIN_FILE_HANDLE_OPS[number];
const MAX_PENDING = 8;
const MAX_TOMBSTONES = 64;


export function isPluginFileHandleOperation(op: string): op is PluginFileHandleOperation {
  return (PLUGIN_FILE_HANDLE_OPS as readonly string[]).includes(op);
}

export interface PluginFileHandleSessionPort {
  acquire(beforeSend?: () => void): Promise<string>;
  invalidate(error: unknown, sessionId: string | undefined): void;
}
interface Handle { selection: PluginFileSelection; sessionId: string }
interface Operation { cancelled: boolean; sessionId?: string }
type Args = Record<string, unknown>;
function object(value: unknown): Args {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('plugin file options must be an object');
  return value as Args;
}
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('invalid plugin file request ID');
  return value;
}
function abortError(): Error {
  const error = new Error('plugin file operation aborted');
  error.name = 'AbortError';
  return error;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid plugin file offset or length');
  return value;
}
function pickOptions(value: unknown): PluginFilePickOptions {
  if (value === undefined) return {};
  const input = object(value);
  if (Object.keys(input).some(key => !['title', 'defaultFileName', 'filters'].includes(key))) throw new Error('unsupported plugin file picker option');
  if ((input.title !== undefined && typeof input.title !== 'string') ||
      (input.defaultFileName !== undefined && typeof input.defaultFileName !== 'string')) throw new Error('invalid plugin file picker hint');
  const filters = input.filters;
  if (filters !== undefined && (!Array.isArray(filters) || filters.length > 32 || filters.some(filter => {
    const item = object(filter);
    return typeof item.name !== 'string' || !Array.isArray(item.extensions) || item.extensions.length > 64 ||
      item.extensions.some(extension => typeof extension !== 'string');
  }))) throw new Error('invalid plugin file picker filters');
  return {
    title: input.title as string | undefined,
    defaultFileName: input.defaultFileName as string | undefined,
    filters: filters as PluginFilePickOptions['filters'],
  };
}

/** One host instance per Worker. It borrows the existing FS context's session,
 * never accepts session/installation IDs from Worker messages, and ignores
 * responses that no longer belong to the active worker operation. */
export class PluginFileHandleHost {
  private alive = true;
  private readonly handles = new Map<string, Handle>();
  private readonly requests = new Map<string, Operation>();
  private readonly preCancelled = new Set<string>();
  private activeSession: string | undefined;
  private selecting = false;

  constructor(readonly pluginId: string, readonly installGeneration: string, private readonly session: PluginFileHandleSessionPort) {}

  private sessionRequest(sessionId: string, id: string): PluginFileRequest {
    return { pluginId: this.pluginId, expectedGeneration: this.installGeneration, sessionId, requestId: id };
  }
  private check(operation?: Operation, beforeSend?: () => void): void {
    if (!this.alive) throw new Error('plugin file worker retired');
    if (operation?.cancelled) throw abortError();
    beforeSend?.();
  }
  private owned(value: unknown, mode?: Handle['selection']['mode']): Handle {
    this.check();
    const item = typeof value === 'string' ? this.handles.get(value) : undefined;
    if (!item || (mode !== undefined && item.selection.mode !== mode)) throw new Error('PLUGIN_FILE_HANDLE_INVALID');
    return item;
  }
  readSource(handleId: unknown): { handleId: string; sessionId: string; size: number } {
    const { selection, sessionId } = this.owned(handleId, 'read');
    return { handleId: selection.handleId, sessionId, size: selection.size };
  }
  private close(handle: Handle): Promise<void> {
    return pluginFileHandleService.close({
      pluginId: this.pluginId, expectedGeneration: this.installGeneration, sessionId: handle.sessionId,
    }, handle.selection.handleId);
  }
  private async cancel(id: string): Promise<void> {
    this.check();
    const request = this.requests.get(id);
    if (request) {
      if (request.cancelled) return;
      request.cancelled = true;
    } else {
      // Cancel before initial local dispatch is bounded and must not open the FS session.
      this.preCancelled.add(id);
      if (this.preCancelled.size > MAX_TOMBSTONES) this.preCancelled.delete(this.preCancelled.values().next().value!);
    }
    const sessionId = request ? request.sessionId : this.activeSession;
    if (sessionId) await pluginFsService.cancel(this.pluginId, sessionId, id);
  }
  private invalidate(error: unknown, sessionId: string | undefined, handle?: Handle): void {
    if (!sessionId) return;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('PLUGIN_FS_SESSION_INVALID')) {
      if (this.activeSession === sessionId) this.activeSession = undefined;
      for (const [id, item] of this.handles) if (item.sessionId === sessionId) this.handles.delete(id);
      this.session.invalidate(error, sessionId);
    } else if (handle && message.includes('PLUGIN_FILE_HANDLE_INVALID')) {
      this.handles.delete(handle.selection.handleId);
    }
  }
  private lease(bytes: Uint8Array, request: PluginFileRequest): Uint8Array {
    attachPluginFsLease(bytes, () => pluginFsService.release(this.pluginId, request.sessionId, request.requestId));
    return bytes;
  }
  private async releaseFailedRead(request: PluginFileRequest): Promise<void> {
    const cleanup = {};
    attachPluginFsLease(cleanup, () => pluginFsService.release(this.pluginId, request.sessionId, request.requestId));
    await releasePluginFsResultWithRetry(cleanup);
  }

  async dispatch(op: PluginFileHandleOperation, value: unknown, beforeSend?: () => void): Promise<unknown> {
    const args = object(value);
    if (op === 'fs.cancelFileRequest') return this.cancel(requestId(args.requestId));
    if (op === 'fs.closeFile') {
      this.check();
      const item = typeof args.handleId === 'string' ? this.handles.get(args.handleId) : undefined;
      if (!item) return;
      await this.close(item);
      this.handles.delete(item.selection.handleId);
      return;
    }
    const id = requestId(args.requestId);
    this.check(undefined, beforeSend);
    if (this.preCancelled.delete(id)) throw abortError();
    if (this.requests.has(id) || this.requests.size >= MAX_PENDING) throw new Error('plugin file request capacity exceeded');
    const operation: Operation = { cancelled: false };
    this.requests.set(id, operation);
    let handle: Handle | undefined;
    try {
      if (op === 'fs.openFile' || op === 'fs.createFile') {
        if (this.selecting) throw new Error('PLUGIN_FILE_RESOURCES_BUSY');
        this.selecting = true;
        try {
          const options = pickOptions(args.options);
          const sessionId = await this.session.acquire(beforeSend);
          if (this.activeSession !== sessionId) {
            for (const [key, item] of this.handles) if (item.sessionId !== sessionId) this.handles.delete(key);
            this.activeSession = sessionId;
          }
          operation.sessionId = sessionId;
          this.check(operation, beforeSend);
          const result = await pluginFileHandleService.pick(this.sessionRequest(sessionId, id), op === 'fs.openFile' ? 'read' : 'write', options);
          try { this.check(operation, beforeSend); }
          catch (error) {
            if (result) void this.close({ selection: result, sessionId }).catch(() => undefined);
            throw error;
          }
          if (!result) return null;
          const { activeHandles, ...selection } = result;
          for (const key of this.handles.keys()) if (!activeHandles.includes(key)) this.handles.delete(key);
          this.handles.set(selection.handleId, { selection, sessionId });
          return selection;
        } finally {
          this.selecting = false;
        }
      }
      handle = this.owned(args.handleId, op === 'fs.readFileWindow' ? 'read' : 'write');
      const { selection, sessionId } = handle;
      operation.sessionId = sessionId;
      const request = this.sessionRequest(sessionId, id);
      this.check(operation, beforeSend);
      if (op === 'fs.readFileWindow') {
        const offset = integer(args.offset);
        const length = integer(args.length);
        if (length > PLUGIN_FILE_WINDOW_BYTES) throw new Error('plugin file window exceeds transport limit');
        try {
          const bytes = await pluginFileHandleService.read(request, selection.handleId, offset, length, Math.min(length, Math.max(0, selection.size - offset)));
          this.check(operation, beforeSend);
          if (this.handles.get(selection.handleId) !== handle) throw abortError();
          return this.lease(bytes, request);
        } catch (error) {
          await this.releaseFailedRead(request);
          throw error;
        }
      }
      if (op === 'fs.writeFileChunk') {
        const raw = args.bytes;
        const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : undefined;
        if (!bytes) throw new Error('plugin file write requires bytes');
        const offset = integer(args.offset);
        try {
          const total = await pluginFileHandleService.write(request, selection.handleId, offset, bytes);
          this.check(operation, beforeSend);
          return total;
        } catch (error) {
          // No automatic retry of possibly staged bytes. Abort this target instead.
          await this.close(handle).then(() => this.handles.delete(selection.handleId), () => undefined);
          throw error;
        }
      }
      try {
        // Do not turn a successful atomic replace into a claimed cancellation.
        const committed = await pluginFileHandleService.commit(request, selection.handleId);
        this.check();
        return committed;
      } finally {
        await this.close(handle).then(() => this.handles.delete(selection.handleId), () => undefined);
      }
    } catch (error) {
      this.invalidate(error, operation.sessionId, handle);
      throw error;
    } finally {
      this.requests.delete(id);
    }
  }

  /** No session creation on cleanup. The shared FS context also closes its
   * native session after retiring this facade. */
  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [id, operation] of this.requests) {
      operation.cancelled = true;
      if (operation.sessionId) void pluginFsService.cancel(this.pluginId, operation.sessionId, id).catch(() => undefined);
    }
    this.preCancelled.clear();
    for (const handle of this.handles.values()) void this.close(handle).catch(() => undefined);
    this.handles.clear();
  }
}
