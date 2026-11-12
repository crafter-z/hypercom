/**
 * Terminal line filter predicate (pure, DOM-free).
 *
 * Direction + keyword, evaluated against the lazily decoded line text
 * (`getLineText`; issue #14: RX lines carry `rawData` only, so keyword matching
 * and display always agree on the encoding).
 *
 * The matching **index list** — incremental append-time maintenance, the
 * identity/no-allocation fast path, the pause-limited prefix scan — belongs to
 * the viewport manager (`recomputeFilter`), which is the only production
 * implementation. A second array-based scan lived here and had to be kept in
 * sync by hand; it is gone.
 *
 * Unit-testable under vitest's `environment: 'node'` config (no jsdom).
 */
import type { TerminalLine } from '../types';
import { getLineText } from './lineText';
import { isLikelyAsciiNoise } from './asciiNoise';

/** Direction filter: 'all' shows everything, 'TX'/'RX' only that direction. */
export type DirectionFilter = 'all' | 'TX' | 'RX';

/**
 * Direction + keyword line predicate (encoding-aware lazy decode). Shared by
 * the append-time incremental path and the full rescan in the viewport manager.
 */
export function linePassesFilter(
  line: TerminalLine,
  direction: DirectionFilter,
  keyword: string,
  encoding: string,
  hideAsciiNoise = false,
): boolean {
  if (direction !== 'all' && line.direction !== direction) return false;
  // Display-only: inspect original RX bytes, never mutate content/rawData or
  // gate upstream observers. Text-only replay rows without bytes stay visible.
  if (hideAsciiNoise && line.direction === 'RX' && line.rawData && isLikelyAsciiNoise(line.rawData)) return false;
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return getLineText(line, encoding).toLowerCase().includes(kw);
}
