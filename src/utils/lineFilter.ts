/**
 * Terminal line filter helpers (pure, DOM-free).
 *
 * Extracted from TerminalView (Phase F.1) so the filter predicate can be
 * unit-tested under vitest's `environment: 'node'` config (no jsdom).
 *
 * The filter works at the DATA level: it returns the list of ORIGINAL
 * indices into `lines` that pass the filter, so the virtualizer only
 * renders matching rows (never hidden DOM nodes).
 *
 * Null-sentinel contract: when NO filter is active the function returns
 * `null` instead of allocating the identity array [0..n-1] — callers treat
 * null as "identity is implicit" and render `limit ?? lines.length` rows
 * directly. This keeps the high-frequency append path allocation-free.
 */
import type { TerminalLine } from '../types';

/** Direction filter: 'all' shows everything, 'TX'/'RX' only that direction. */
export type DirectionFilter = 'all' | 'TX' | 'RX';

export interface LineFilterOptions {
  direction: DirectionFilter;
  /** Case-insensitive substring match against `line.content`. */
  keyword: string;
}

/**
 * Returns the original indices of `lines` that pass both the direction and
 * keyword filters, in ascending order.
 *
 * - direction 'all' imposes no constraint.
 * - keyword is trimmed and matched case-insensitively against `content`;
 *   an empty/whitespace keyword imposes no constraint.
 * - With no active filter, returns `null` (identity is implicit; callers
 *   render `limit ?? lines.length` rows directly — no allocation).
 * - `limit` caps the scanned prefix of `lines` (0..limit). It replaces the
 *   old paused-prefix slice: callers pass the frozen line count while the
 *   view is paused instead of allocating `lines.slice(0, frozenCount)`.
 */
export function filterLines(
  lines: TerminalLine[],
  options: LineFilterOptions,
  limit?: number
): number[] | null {
  const direction = options.direction;
  const keyword = options.keyword.trim().toLowerCase();
  const hasDirection = direction !== 'all';
  const hasKeyword = keyword.length > 0;

  // Fast path: identity when nothing is filtered — no allocation.
  if (!hasDirection && !hasKeyword) return null;

  const end = limit !== undefined && limit < lines.length ? limit : lines.length;
  const result: number[] = [];
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (hasDirection && line.direction !== direction) continue;
    if (hasKeyword && !line.content.toLowerCase().includes(keyword)) continue;
    result.push(i);
  }
  return result;
}
