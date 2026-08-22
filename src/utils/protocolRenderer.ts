/**
 * Protocol field colorizer
 * Renders a TerminalLine with parsedFields into colored HTML, field by field.
 * Bytes belonging to each field are grouped, decoded, and wrapped in colored <span> tags.
 * Gap bytes (not in any field) are rendered without color.
 */

import type { TerminalLine, ParsedField } from '../types';
import { escapeHtml } from './highlightEngine';

/**
 * Validate that a color string is safe for CSS injection.
 * Accepts hex (#fff, #ffffff, #ffffffff), rgb/rgba/hsl/hsla functional notation, and named colors.
 */
function isValidColor(color: string): boolean {
  return (
    /^#[0-9a-fA-F]{3,8}$/.test(color) ||
    /^(rgb|hsl)a?\(/.test(color) ||
    /^[a-z]+$/i.test(color)
  );
}

/**
 * Find the field that covers a given byte index.
 * Returns null if the byte is a gap (not in any field).
 */
function getFieldForByte(fields: ParsedField[], byteIndex: number): ParsedField | null {
  for (const f of fields) {
    if (f.byteStart <= byteIndex && byteIndex < f.byteEnd) {
      return f;
    }
  }
  return null;
}

/**
 * Render bytes in hex mode: each byte → 2-char uppercase hex, grouped by field.
 * Consecutive bytes belonging to the same field are grouped into one <span>.
 * Gap bytes are rendered without color.
 */
function renderHexMode(rawData: Uint8Array, coverage: (ParsedField | null)[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < rawData.length) {
    const currentField = coverage[i];
    const hexBytes: string[] = [];
    while (i < rawData.length && coverage[i] === currentField) {
      hexBytes.push(rawData[i].toString(16).toUpperCase().padStart(2, '0'));
      i++;
    }
    const hexStr = hexBytes.join(' ');
    if (currentField && isValidColor(currentField.color)) {
      parts.push(`<span style="color:${currentField.color}">${hexStr}</span>`);
    } else {
      // Gap byte or invalid color — no styling
      parts.push(hexStr);
    }
  }
  return parts.join(' ');
}

/**
 * Render bytes in text mode: group consecutive bytes by field, decode as UTF-8, escapeHtml.
 * Field groups are wrapped in colored <span> tags.
 * Gap groups are rendered as plain escaped text.
 */
function renderTextMode(rawData: Uint8Array, coverage: (ParsedField | null)[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < rawData.length) {
    const currentField = coverage[i];
    const groupBytes: number[] = [];
    while (i < rawData.length && coverage[i] === currentField) {
      groupBytes.push(rawData[i]);
      i++;
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(groupBytes));
    const escaped = escapeHtml(decoded);
    if (currentField && isValidColor(currentField.color)) {
      parts.push(`<span style="color:${currentField.color}">${escaped}</span>`);
    } else {
      // Gap byte or invalid color — plain escaped text
      parts.push(escaped);
    }
  }
  return parts.join('');
}

/**
 * Render a protocol-parsed terminal line as colored HTML.
 *
 * Each parsedField's byte range is decoded/converted separately and wrapped in
 * a colored `<span>`. Non-field gap bytes are rendered without color.
 *
 * @param line - The terminal line to render. Must have rawData and parsedFields.
 * @returns An HTML string suitable for dangerouslySetInnerHTML.
 *
 * - In hex mode (line.isHex === true): each byte → 2-char uppercase hex, spaced.
 * - In text mode (line.isHex === false): bytes decoded via UTF-8 TextDecoder.
 *
 * Falls back to escapeHtml(line.content) if rawData or parsedFields are missing/empty.
 */
export function renderProtocolLine(line: TerminalLine): string {
  if (!line.rawData || !line.parsedFields || line.parsedFields.length === 0) {
    return escapeHtml(line.content ?? '');
  }

  // Sort fields by byteStart ascending for deterministic coverage
  const fields = [...line.parsedFields].sort((a, b) => a.byteStart - b.byteStart);
  const rawData = line.rawData;

  // Build coverage map: for each byte index, which field it belongs to (or null for gap)
  // Uint8Array 无 .map：Array.from 逐索引映射（issue #6-2）
  const coverage: (ParsedField | null)[] = Array.from({ length: rawData.length }, (_, i) =>
    getFieldForByte(fields, i)
  );

  if (line.isHex) {
    return renderHexMode(rawData, coverage);
  }
  return renderTextMode(rawData, coverage);
}
