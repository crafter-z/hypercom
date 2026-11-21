import { invoke } from '@tauri-apps/api/core';

export const PLUGIN_FILE_WINDOW_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PluginFilePickOptions {
  title?: string;
  defaultFileName?: string;
  filters?: { name: string; extensions: string[] }[];
}
export interface PluginFileSelection {
  handleId: string;
  mode: 'read' | 'write';
  name: string;
  /** Read size at open; zero for a new staged write. */
  size: number;
}
export interface PluginFileCommitResult {
  bytesWritten: number;
  durabilityWarning?: string;
}
interface FileSession {
  pluginId: string;
  expectedGeneration: string;
  sessionId: string;
}
export interface PluginFileRequest extends FileSession { requestId: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function encodeChunk(bytes: Uint8Array): string {
  // Work in slices to retain the <=1 MiB protocol budget without hitting
  // argument-count limits. Do not encode the rest of the caller's buffer.
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export const pluginFileHandleService = {
  async pick(request: PluginFileRequest, mode: PluginFileSelection['mode'], options: PluginFilePickOptions): Promise<(PluginFileSelection & { activeHandles: string[] }) | null> {
    const args = { ...request, options };
    const value: unknown = mode === 'read'
      ? await invoke('plugin_file_pick_read', args)
      : await invoke('plugin_file_pick_write', args);
    if (value === null) return null;
    if (!record(value) || typeof value.handleId !== 'string' || !UUID.test(value.handleId) || value.mode !== mode ||
      typeof value.name !== 'string' || !integer(value.size) || (mode === 'write' && value.size !== 0) ||
      !Array.isArray(value.activeHandles) || value.activeHandles.length > 4 || !value.activeHandles.includes(value.handleId) ||
      value.activeHandles.some(id => typeof id !== 'string' || !UUID.test(id))) {
      throw new Error('invalid native plugin file selection');
    }
    return { handleId: value.handleId, name: value.name, mode, size: value.size, activeHandles: value.activeHandles };
  },
  async read(request: PluginFileRequest, handleId: string, offset: number, length: number, expectedLength: number): Promise<Uint8Array> {
    if (!integer(offset) || !integer(length) || length > PLUGIN_FILE_WINDOW_BYTES) throw new Error('invalid plugin file window');
    const result: unknown = await invoke('plugin_file_read', { ...request, handleId, offset, length });
    if (!(result instanceof ArrayBuffer) || result.byteLength !== expectedLength) {
      throw new Error('invalid native plugin file window');
    }
    return new Uint8Array(result);
  },
  async write(request: PluginFileRequest, handleId: string, offset: number, bytes: Uint8Array): Promise<number> {
    if (!integer(offset) || !integer(offset + bytes.byteLength) || bytes.byteLength < 1 || bytes.byteLength > PLUGIN_FILE_WINDOW_BYTES) {
      throw new Error('invalid plugin file chunk');
    }
    const result: unknown = await invoke('plugin_file_write', { ...request, handleId, offset, base64: encodeChunk(bytes) });
    if (!integer(result) || result !== offset + bytes.byteLength) throw new Error('invalid native staged file progress');
    return result;
  },
  async commit(request: PluginFileRequest, handleId: string): Promise<PluginFileCommitResult> {
    const result: unknown = await invoke('plugin_file_commit', { ...request, handleId });
    if (!record(result) || !integer(result.bytesWritten) ||
        (result.durabilityWarning !== undefined && typeof result.durabilityWarning !== 'string')) {
      throw new Error('invalid native file commit result; publication status is unknown');
    }
    return { bytesWritten: result.bytesWritten, ...(result.durabilityWarning !== undefined ? { durabilityWarning: result.durabilityWarning } : {}) };
  },
  close: (session: FileSession, handleId: string): Promise<void> => invoke('plugin_file_close', { ...session, handleId }),
};
