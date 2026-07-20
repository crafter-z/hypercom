/**
 * Terminal search helpers (pure, DOM-free).
 *
 * Extracted from TerminalView so search logic can be unit-tested under
 * vitest's `environment: 'node'` config (no jsdom required).
 */
import type { TerminalLine, DisplayFormat } from '../../types';

export interface FindMatchesOptions {
  query: string;
  caseSensitive: boolean;
  /** When 'hex', matches against the hex representation of rawData. */
  displayFormat?: DisplayFormat;
}

/**
 * Returns the searchable text for a single terminal line, mirroring the
 * rendering branch in TerminalView (hex display falls back to rawData,
 * everything else uses content).
 */
export function getSearchableText(
  line: TerminalLine,
  displayFormat?: DisplayFormat
): string {
  if (displayFormat === 'hex' && line.rawData) {
    return line.rawData
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');
  }
  return line.content;
}

/**
 * Returns the list of line indices whose searchable text contains `query`.
 * Empty query returns `[]`. Case-insensitive by default.
 */
export function findMatches(
  lines: TerminalLine[],
  options: FindMatchesOptions
): number[] {
  const { query, caseSensitive, displayFormat } = options;
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = getSearchableText(lines[i], displayFormat);
    const haystack = caseSensitive ? text : text.toLowerCase();
    if (haystack.includes(needle)) result.push(i);
  }
  return result;
}

/**
 * Formats a terminal line as plain text for clipboard copy / export,
 * matching the existing export format: `[timestamp] direction content`.
 */
export function formatLineForCopy(line: TerminalLine): string {
  const d = new Date(line.timestamp);
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  return `[${ts}] ${line.direction} ${line.content}`;
}