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
 * This file is the **single TextDecoder factory + cache of the app** (K8):
 * the RxPipeline decoded every line with its own per-port cache and ttyService
 * built its own streaming decoder — three construction sites, two of which
 * passed `ignoreBOM: true`. That made "does the line text start with a U+FEFF"
 * depend on which path the bytes took. Decoders now always use
 * `ignoreBOM: false`: a BOM is an encoding marker, not content, and leaking it
 * into the decoded string pollutes the rendered row, the search haystack and
 * the right-click copy.
 *
 * Pure logic + a module-level decoder cache (GBK construction is not free);
 * no React/store/DOM dependencies, unit-testable under node.
 */
import type { Encoding, TerminalLine } from '../types';

/** Encoding label normalization: ASCII → utf-8 (TextDecoder has no 'ascii'
 *  label), everything else lowercased. Single normalization for every caller
 *  (the pipeline used to normalize again on its way in). */
export function normalizeEncodingLabel(encoding: Encoding | string): string {
  const lower = encoding.toLowerCase();
  return lower === 'ascii' ? 'utf-8' : lower;
}

/**
 * Build a decoder for a label. Invalid labels fall back to utf-8 (never
 * throws). Callers that need `{ stream: true }` decode-time buffering (xterm
 * RX across event splits) call this per port — a streaming decoder holds
 * partial bytes, so instances MUST NOT be shared between ports.
 */
export function createDecoder(encoding: Encoding | string): TextDecoder {
  try {
    return new TextDecoder(normalizeEncodingLabel(encoding), { fatal: false, ignoreBOM: false });
  } catch {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  }
}

/** Non-streaming decoder cache: one instance per label, reused. Decoding a
 *  whole line never needs stream state, so sharing across ports is safe. */
const decoderCache = new Map<string, TextDecoder>();

/**
 * Decode raw bytes under the given encoding (non-streaming).
 */
export function decodeBytes(bytes: Uint8Array, encoding: Encoding | string): string {
  const label = normalizeEncodingLabel(encoding);
  let decoder = decoderCache.get(label);
  if (!decoder) {
    decoder = createDecoder(label);
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
