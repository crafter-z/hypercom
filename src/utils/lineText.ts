/**
 * Terminal line text resolution helpers (方案B, issue #14).
 *
 * RX lines no longer carry a redundant decoded `content` string — the
 * TerminalLine stores only `rawData` (Uint8Array) + metadata, and the
 * display/search/filter/export paths resolve text lazily via `getLineText`
 * with the **current** encoding. Encoding switches therefore take effect
 * automatically on the next re-render (decode happens at draw time), instead
 * of the old `setTerminalEncoding` walk that rewrote every buffered line.
 *
 * TX/TOOL/replay lines carry `content` directly and return it unchanged.
 *
 * Pure logic + a module-level TextDecoder cache (GBK construction is not
 * free); no React/store/DOM dependencies, unit-testable under node.
 */
import type { Encoding, TerminalLine } from '../types';

/** Encoding label normalization: ASCII → utf-8 (TextDecoder has no 'ascii'
 *  label), everything else lowercased. Matches the pipeline's convention. */
export function normalizeEncodingLabel(encoding: Encoding | string): string {
  const lower = encoding.toLowerCase();
  return lower === 'ascii' ? 'utf-8' : lower;
}

/** Module-level decoder cache: reuse one TextDecoder per label. */
const decoderCache = new Map<string, TextDecoder>();

/**
 * Decode raw bytes under the given encoding. Invalid labels fall back to
 * utf-8 (never throws) — mirrors the pipeline's TextDecoder handling.
 */
export function decodeBytes(bytes: Uint8Array, encoding: Encoding | string): string {
  const label = normalizeEncodingLabel(encoding);
  let decoder = decoderCache.get(label);
  if (!decoder) {
    try {
      decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true });
    } catch {
      decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
    }
    decoderCache.set(label, decoder);
  }
  return decoder.decode(bytes);
}

/**
 * Resolve a line's display text: `content` wins (TX/TOOL/replay lines),
 * otherwise `rawData` is decoded under the current encoding. Empty string
 * when neither is present.
 */
export function getLineText(line: TerminalLine, encoding: Encoding | string): string {
  if (line.content !== undefined) return line.content;
  if (line.rawData) return decodeBytes(line.rawData, encoding);
  return '';
}

/** Line byte accounting: rawData length when present, else UTF-8 byte length
 *  of content, else 0. Used by the ring buffer's byte-budget trim. */
export function lineBytes(line: TerminalLine): number {
  if (line.rawData) return line.rawData.length;
  if (line.content !== undefined) return new TextEncoder().encode(line.content).length;
  return 0;
}
