/**
 * Shared strict HEX input parsing and UTF-8 text conversion.
 * Terminal conversion, send previews, editor validation and HEX matching use
 * the same bytes; invalid input is never padded or partially recovered.
 */
import { bytesToSpacedHex } from './hexFormat';
import { decodeBytes } from './lineText';

/** Exact whitespace set accepted by Rust `serial/codec.rs::parse_hex_string`.
 * JS `\s` also accepts Unicode spaces that the backend rejects. */
const ASCII_WS = /[ \t\n\r\v\f]+/g;

function compactHex(input: string): string {
  return input.replace(ASCII_WS, '');
}

function validCompactHex(input: string): boolean {
  return input.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(input);
}

/** Empty input is valid; callers requiring a command must check for bytes. */
export function isValidHexInput(input: string): boolean {
  return validCompactHex(compactHex(input));
}

/** Parse spaced or compact HEX. Invalid input returns [] (no padding/skipping). */
export function parseHexBytes(input: string): number[] {
  const cleaned = compactHex(input);
  if (!validCompactHex(cleaned)) return [];
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return bytes;
}

/** Decode strict HEX as UTF-8 using the app's shared non-fatal/BOM policy. */
export function hexToString(hex: string): string {
  return decodeBytes(Uint8Array.from(parseHexBytes(hex)), 'UTF-8');
}

/**
 * Convert a string to a space-separated uppercase hex string (e.g. "ABC" -> "41 42 43").
 * Encodes as UTF-8 so non-Latin characters emit their multi-byte representation.
 */
export function stringToHex(str: string): string {
  return bytesToSpacedHex(new TextEncoder().encode(str));
}
