/**
 * Terminal line filter helpers (pure, DOM-free).
 *
 * Extracted from TerminalView (Phase F.1) so the filter predicate can be
 * unit-tested under vitest's `environment: 'node'` config (no jsdom).
 *
 * The filter works at the DATA level: it returns the list of ORIGINAL
 * indices into `lines` that pass the filter, so the virtualizer only
 * renders matching rows (never hidden DOM nodes).
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
 * - With no active filter, returns the identity mapping [0..n-1].
 */
export function filterLines(
  lines: TerminalLine[],
  options: LineFilterOptions
): number[] {
  const direction = options.direction;
  const keyword = options.keyword.trim().toLowerCase();
  const hasDirection = direction !== 'all';
  const hasKeyword = keyword.length > 0;

  // Fast path: identity mapping when nothing is filtered.
  if (!hasDirection && !hasKeyword) {
    const all = new Array<number>(lines.length);
    for (let i = 0; i < lines.length; i++) all[i] = i;
    return all;
  }

  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hasDirection && line.direction !== direction) continue;
    if (hasKeyword && !line.content.toLowerCase().includes(keyword)) continue;
    result.push(i);
  }
  return result;
}
