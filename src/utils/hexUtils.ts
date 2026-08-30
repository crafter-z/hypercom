/**
 * Hex <-> String conversion utilities.
 * Shared across terminal display and operation panel.
 */

/**
 * Convert a space-separated hex string (e.g. "41 42 43") to a string ("ABC").
 * Empty / whitespace-only input yields "". Tokens that don't match
 * /^[0-9a-fA-F]{1,2}$/ are skipped. Bytes are decoded as UTF-8 so multi-byte
 * sequences (e.g. "E4 B8 AD" -> "中") round-trip correctly.
 */
export function hexToString(hex: string): string {
  const trimmed = hex.trim();
  if (trimmed.length === 0) return '';
  const bytes: number[] = [];
  for (const token of trimmed.split(/\s+/)) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(token)) continue;
    bytes.push(parseInt(token, 16));
  }
  if (bytes.length === 0) return '';
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/**
 * Convert a string to a space-separated uppercase hex string (e.g. "ABC" -> "41 42 43").
 * Encodes as UTF-8 so non-Latin characters emit their multi-byte representation.
 */
export function stringToHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}
