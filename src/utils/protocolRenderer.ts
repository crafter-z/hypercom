/**
 * Protocol field colorizer
 * Renders a TerminalLine with parsedFields into colored HTML, field by field.
 * Bytes belonging to each field are grouped, decoded, and wrapped in colored <span> tags.
 * Gap bytes (not in any field) are rendered without color.
 */

import type { TerminalLine, ParsedField } from '../types';
import { escapeHtml } from './highlightEngine';
import { safeCssColor } from './cssColor';
import { createDecoder } from './lineText';
import { hexByte } from './hexFormat';


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
      hexBytes.push(hexByte(rawData[i]));
      i++;
    }
    const hexStr = hexBytes.join(' ');
    const color = currentField ? safeCssColor(currentField.color) : null;
    if (color) {
      parts.push(`<span style="color:${color}">${hexStr}</span>`);
    } else {
      // Gap byte or invalid color — no styling
      parts.push(hexStr);
    }
  }
  return parts.join(' ');
}

/**
 * Render text with one streaming decoder per line so a field boundary cannot
 * split a multibyte character. The field completing a character owns its color.
 */
function renderTextMode(
  rawData: Uint8Array,
  coverage: (ParsedField | null)[],
  encoding: string,
): string {
  const parts: string[] = [];
  const decoder = createDecoder(encoding);
  let i = 0;
  while (i < rawData.length) {
    const currentField = coverage[i];
    const start = i;
    while (i < rawData.length && coverage[i] === currentField) i++;
    const decoded = decoder.decode(rawData.subarray(start, i), { stream: i < rawData.length });
    const escaped = escapeHtml(decoded);
    const color = currentField ? safeCssColor(currentField.color) : null;
    if (color) {
      parts.push(`<span style="color:${color}">${escaped}</span>`);
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
 * Each parsedField's byte range is colored, preserving decoder state across
 * field boundaries. Non-field gap bytes are rendered without color.
 *
 * @param line - The terminal line to render. Must have rawData and parsedFields.
 * @param encoding - 端口当前编码（默认 'UTF-8'）：text 模式下按此编码解码字段字节，
 *   避免硬编码 UTF-8 导致 GBK 等编码字段乱码（issue #14 / P2-2）。
 * @returns An HTML string suitable for dangerouslySetInnerHTML.
 *
 * - In hex display mode: each byte → 2-char uppercase hex, spaced.
 * - In text display mode: bytes decoded under the given encoding.
 *
 * Falls back to escapeHtml(line.content) if rawData or parsedFields are missing/empty.
 */
export function renderProtocolLine(line: TerminalLine, encoding: string = 'UTF-8', isHex: boolean = line.isHex): string {
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

  if (isHex) {
    return renderHexMode(rawData, coverage);
  }
  return renderTextMode(rawData, coverage, encoding);
}
