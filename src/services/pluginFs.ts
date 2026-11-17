import { invoke } from '@tauri-apps/api/core';
import { createDecoder } from '../utils/lineText';

export const MAX_PLUGIN_FS_RANGE_BYTES = 4 * 1024 * 1024;
export const MAX_PLUGIN_FS_BATCH_BYTES = 8 * 1024 * 1024;
export const MAX_PLUGIN_FS_RANGES = 64;
const MAX_FRAME_METADATA_BYTES = 512 * 1024;
export type PluginFsPriority = 'interactive' | 'background';
export interface PluginFsRange { rel: string; offset: number; length: number; grantId?: string }
export type PluginFsRangeResult = { rel: string; bytes: Uint8Array } | { rel: string; error: string };
export interface PluginFsResults { results: PluginFsRangeResult[] }
export interface PluginFsEntry {
  name: string;
  rel: string;
  kind: 'file' | 'directory' | 'other';
  size: number;
  modifiedMs: number;
}
export interface PluginFsPage { entries: PluginFsEntry[]; nextCursor: string | null }
export interface PluginFsPageOptions {
  grantId: string; relPath?: string; recursive?: boolean; cursor?: string; limit?: number; priority: PluginFsPriority;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalidFrame(): never { throw new Error('invalid plugin FS raw frame'); }

/** Only Tauri's raw ArrayBuffer response is accepted; JSON/base64 fallbacks are not raw transport. */
export function decodePluginFsFrame(frame: unknown, ranges: readonly PluginFsRange[]): PluginFsResults {
  if (!(frame instanceof ArrayBuffer) || frame.byteLength < 8 ||
    frame.byteLength > 8 + MAX_FRAME_METADATA_BYTES + MAX_PLUGIN_FS_BATCH_BYTES) return invalidFrame();
  const view = new DataView(frame);
  if (view.getUint32(0, false) !== 0x48434652) return invalidFrame(); // HCFR
  const metadataLength = view.getUint32(4, true);
  if (metadataLength === 0 || metadataLength > MAX_FRAME_METADATA_BYTES || metadataLength > frame.byteLength - 8) return invalidFrame();
  const payloadStart = 8 + metadataLength;
  const payloadLength = frame.byteLength - payloadStart;
  if (payloadLength > MAX_PLUGIN_FS_BATCH_BYTES) return invalidFrame();
  let metadata: unknown;
  try {
    metadata = JSON.parse(createDecoder('utf-8', { fatal: true }).decode(new Uint8Array(frame, 8, metadataLength)));
  } catch { return invalidFrame(); }
  if (!object(metadata) || Object.keys(metadata).some(key => key !== 'results') ||
    !Array.isArray(metadata.results) || metadata.results.length !== ranges.length || ranges.length === 0 || ranges.length > MAX_PLUGIN_FS_RANGES) return invalidFrame();
  let end = 0;
  const descriptors = metadata.results.map((item: unknown, index: number) => {
    if (!object(item) || Object.keys(item).some(key => !['rel', 'offset', 'length', 'error'].includes(key)) ||
      item.rel !== ranges[index].rel || typeof item.offset !== 'number' || !Number.isSafeInteger(item.offset) ||
      typeof item.length !== 'number' || !Number.isSafeInteger(item.length) || item.offset !== end ||
      item.length < 0 || item.length > ranges[index].length || item.length > payloadLength - end ||
      (item.error !== undefined && (typeof item.error !== 'string' || item.error.length === 0 || item.length !== 0))) return invalidFrame();
    end += item.length;
    return { rel: item.rel as string, offset: item.offset, length: item.length, error: item.error as string | undefined };
  });
  if (end !== payloadLength) return invalidFrame();
  // Drop the header/metadata from the transferred buffer. A single range gets an
  // exact buffer; batches share only their own payload, never the native frame.
  const payload = frame.slice(payloadStart);
  return { results: descriptors.map(item => item.error !== undefined
    ? { rel: item.rel, error: item.error }
    : { rel: item.rel, bytes: new Uint8Array(payload, item.offset, item.length) }) };
}

function decodePage(value: unknown, limit = 256): PluginFsPage {
  if (!object(value) || !Array.isArray(value.entries) || value.entries.length > limit ||
    (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 4096))) {
    throw new Error('invalid plugin FS directory page');
  }
  const entries = value.entries.map((entry: unknown): PluginFsEntry => {
    if (!object(entry) || typeof entry.name !== 'string' || typeof entry.rel !== 'string' ||
      !['file', 'directory', 'other'].includes(String(entry.kind)) ||
      typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      typeof entry.modifiedMs !== 'number' || !Number.isSafeInteger(entry.modifiedMs) || entry.modifiedMs < 0) {
      throw new Error('invalid plugin FS directory entry');
    }
    return { name: entry.name, rel: entry.rel, kind: entry.kind as PluginFsEntry['kind'], size: entry.size, modifiedMs: entry.modifiedMs };
  });
  return { entries, nextCursor: value.nextCursor as string | null };
}

export const pluginFsService = {
  async openSession(pluginId: string, expectedGeneration: string): Promise<string> {
    const sessionId = await invoke<unknown>('plugin_fs_open_session', { pluginId, expectedGeneration });
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      throw new Error('invalid plugin FS session');
    }
    return sessionId;
  },
  closeSession: (pluginId: string, sessionId: string): Promise<void> => invoke('plugin_fs_close_session', { pluginId, sessionId }),
  cancel: (pluginId: string, sessionId: string, requestId: string): Promise<void> => invoke('plugin_fs_cancel', { pluginId, sessionId, requestId }),
  release: (pluginId: string, sessionId: string, requestId: string): Promise<void> => invoke('plugin_fs_release', { pluginId, sessionId, requestId }),
  async readRanges(pluginId: string, expectedGeneration: string, sessionId: string, requestId: string,
    ranges: PluginFsRange[], priority: PluginFsPriority): Promise<PluginFsResults> {
    const frame = await invoke<unknown>('plugin_fs_read_ranges', { pluginId, expectedGeneration, sessionId, requestId, ranges, priority });
    return decodePluginFsFrame(frame, ranges);
  },
  async listDirectoryPage(pluginId: string, expectedGeneration: string, sessionId: string, requestId: string,
    options: PluginFsPageOptions): Promise<PluginFsPage> {
    return decodePage(await invoke<unknown>('plugin_fs_list_directory_page', {
      pluginId, expectedGeneration, sessionId, requestId,
      grantId: options.grantId, relPath: options.relPath, recursive: options.recursive,
      cursor: options.cursor, limit: options.limit, priority: options.priority,
    }), options.limit);
  },
};
