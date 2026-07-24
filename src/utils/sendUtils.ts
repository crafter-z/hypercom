/**
 * Send-area pure helpers (byte count, HEX parsing, line-ending bytes).
 * DOM-free so they can be unit-tested under vitest's `environment: 'node'`.
 */
import type { Encoding, LineEnding } from '../types';

/**
 * Return the raw bytes represented by a line-ending selector value.
 * Values mirror the `LineEnding` type sent to the backend.
 */
export function getLineEndingBytes(lineEnding: LineEnding): number[] {
  switch (lineEnding) {
    case '\\r\\n':
      return [0x0d, 0x0a];
    case '\\r':
      return [0x0d];
    case '\\n':
      return [0x0a];
    default:
      return [];
  }
}

/**
 * Parse a space-separated or compact HEX string into a byte array.
 * Invalid / incomplete bytes are skipped so the live counter stays useful.
 */
export function parseHexBytes(input: string): number[] {
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned.length === 0) return [];
  // Pad the trailing nibble with a leading zero when the cleaned length is odd,
  // so e.g. "C" → "0C" and "486" → "4806" rather than silently dropping input.
  const even = cleaned.length % 2 === 0
    ? cleaned
    : `${cleaned.slice(0, -1)}0${cleaned.slice(-1)}`;
  const bytes: number[] = [];
  for (let i = 0; i < even.length; i += 2) {
    const byte = parseInt(even.slice(i, i + 2), 16);
    if (!Number.isNaN(byte)) {
      bytes.push(byte);
    }
  }
  return bytes;
}

export interface ByteCountResult {
  count: number;
  /** Ready-to-display label, e.g. "42 B" or "3 chars · ? bytes". */
  label: string;
  /** Optional tooltip for ambiguous encodings. */
  tooltip?: string;
}

/**
 * Compute the byte count for the current send input.
 *
 * - HEX mode: parsed byte count + line-ending suffix bytes.
 * - UTF-8 / ASCII text: `TextEncoder` byte count + suffix.
 * - GBK / ISO-8859-1 text: shows character count with a "? bytes" hint,
 *   because the final byte length depends on the backend encoding_rs pass.
 */
export function computeByteCount(
  input: string,
  isHex: boolean,
  encoding: Encoding,
  lineEnding: LineEnding
): ByteCountResult {
  const suffixLen = getLineEndingBytes(lineEnding).length;

  if (isHex) {
    const bytes = parseHexBytes(input);
    const count = bytes.length + suffixLen;
    return { count, label: `${count} B` };
  }

  if (encoding === 'UTF-8' || encoding === 'ASCII') {
    const count = new TextEncoder().encode(input).length + suffixLen;
    return { count, label: `${count} B` };
  }

  // GBK / ISO-8859-1: exact bytes require encoding_rs; show chars + hint.
  return {
    count: input.length + suffixLen,
    label: `${input.length} chars · ? bytes`,
    tooltip:
      'Exact byte count depends on the actual bytes after encoding; showing character count.',
  };
}

/**
 * Format a line-ending selector value as a display string of its HEX bytes,
 * e.g. "\\r\\n" -> "0D 0A". Returns `null` when there is no suffix.
 */
export function formatLineEndingHex(lineEnding: LineEnding): string | null {
  const bytes = getLineEndingBytes(lineEnding);
  if (bytes.length === 0) return null;
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Convert plain text to a spaced uppercase HEX byte preview (UTF-8 bytes). '' → ''. */
export function textToHexPreview(text: string): string {
  if (!text) return '';
  return Array.from(new TextEncoder().encode(text))
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/** Decode a HEX byte string back to text (UTF-8, non-fatal). Empty/whitespace → ''. */
export function hexToTextPreview(hex: string): string {
  if (!hex.trim()) return '';
  const bytes = parseHexBytes(hex);
  if (bytes.length === 0) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/** Strip anything that isn't a HEX digit or whitespace (HEX-mode input guard). */
export function sanitizeHexInput(input: string): string {
  return input.replace(/[^0-9a-fA-F\s]/g, '');
}
