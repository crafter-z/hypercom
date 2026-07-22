/**
 * Hex <-> String conversion utilities.
 * Shared across terminal display and operation panel.
 */

/**
 * Convert a space-separated hex string (e.g. "41 42 43") to a string ("ABC").
 * Empty / whitespace-only input yields "". Tokens that are not a valid single
 * byte (NaN or outside 0x00–0xFF) are skipped.
 */
export function hexToString(hex: string): string {
  const trimmed = hex.trim();
  if (trimmed.length === 0) return '';
  const bytes = trimmed.split(/\s+/);
  return bytes.map(b => {
    const code = parseInt(b, 16);
    if (isNaN(code) || code < 0 || code > 0xFF) return '';
    return String.fromCharCode(code);
  }).join('');
}

/**
 * Convert a string to a space-separated uppercase hex string (e.g. "ABC" -> "41 42 43").
 */
export function stringToHex(str: string): string {
  return Array.from(str).map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
