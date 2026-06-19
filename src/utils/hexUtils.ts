/**
 * Hex <-> String conversion utilities.
 * Shared across terminal display and operation panel.
 */

/**
 * Convert a space-separated hex string (e.g. "41 42 43") to a string ("ABC").
 * Invalid bytes are replaced with '?'.
 */
export function hexToString(hex: string): string {
  const bytes = hex.trim().split(/\s+/);
  return bytes.map(b => {
    const code = parseInt(b, 16);
    return isNaN(code) ? '?' : String.fromCharCode(code);
  }).join('');
}

/**
 * Convert a string to a space-separated uppercase hex string (e.g. "ABC" -> "41 42 43").
 */
export function stringToHex(str: string): string {
  return Array.from(str).map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
