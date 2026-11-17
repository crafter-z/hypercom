import { createDecoder } from '../utils/lineText';

/** Compatibility helpers for legacy whole-file plugin APIs, not the bounded raw protocol. */
export function isPluginRawUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('PLUGIN_FS_RAW_UNSUPPORTED');
}

export function decodeLegacyPluginBytes(base64: string): Uint8Array {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

/** HCFD carries a display path as bounded metadata, never the file bytes as JSON. */
export function decodeLegacyDirectoryFrame(raw: unknown): { path: string; bytes: Uint8Array } {
  const invalid = (): never => { throw new Error('invalid plugin directory raw response'); };
  if (!(raw instanceof ArrayBuffer) || raw.byteLength < 8) return invalid();
  const view = new DataView(raw);
  if (view.getUint32(0, false) !== 0x48434644) return invalid(); // HCFD
  const length = view.getUint32(4, true);
  if (length === 0 || length > 128 * 1024 || length > raw.byteLength - 8) return invalid();
  let metadata: unknown;
  try { metadata = JSON.parse(createDecoder('utf-8', { fatal: true }).decode(new Uint8Array(raw, 8, length))); }
  catch { return invalid(); }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata) ||
    !('path' in metadata) || typeof metadata.path !== 'string' ||
    Object.keys(metadata).some(key => key !== 'path')) return invalid();
  return { path: metadata.path, bytes: new Uint8Array(raw.slice(8 + length)) };
}
