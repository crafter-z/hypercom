import type { DisplayFormat, Encoding, TerminalLine } from '../../types';

/** Contiguous stable sequence keys; records and retention belong to the source. */
export interface TerminalSource {
  readonly length: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly version?: number;
  getBySeq(seq: number): TerminalLine | null;
  snapshot(fromSeq?: number, toSeq?: number): TerminalLine[];
  getTimeMs?(seq: number): number | null;
  /** Optional confirmed clock segment; different epochs require explicit mapping. */
  getClockEpoch?(seq: number): string | undefined;
}
export function upperBoundSeq(seqs: readonly number[], value: number, offset = 0): number {
  let lo = offset, hi = seqs.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (seqs[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function countVisibleSeqs(source: TerminalSource, seqs: readonly number[] | null, offset: number, frozen: number | null): number {
  if (seqs === null) return Math.max(0, Math.min(frozen ?? source.lastSeq, source.lastSeq) - source.firstSeq + 1);
  return frozen === null ? seqs.length - offset : upperBoundSeq(seqs, frozen, offset) - offset;
}
export function sourceTimeMs(source: TerminalSource, seq: number): number | null {
  const time = source.getTimeMs ? source.getTimeMs(seq) : source.getBySeq(seq)?.timestamp;
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}
/** Conservative physical budget, not an assertion of browser limits. */
export const TERMINAL_MAX_PHYSICAL_HEIGHT = 8_000_000;
/** One rebuild policy shared by filter, search and time-index construction. */
export const TERMINAL_REBUILD_SYNC_LIMIT = 8192;
export const TERMINAL_REBUILD_CHUNK_SIZE = 2048;
export function physicalRowCount(count: number, height: number): number {
  return Math.min(count, Math.max(1, Math.floor(TERMINAL_MAX_PHYSICAL_HEIGHT / height)));
}
export function mapScrollTop(top: number, fromRows: number, toRows: number, height: number, clientHeight: number): number {
  if (fromRows === toRows) return top;
  const fromMax = Math.max(0, fromRows * height - clientHeight);
  const toMax = Math.max(0, toRows * height - clientHeight);
  return fromMax === 0 ? 0 : Math.max(0, Math.min(top, fromMax)) * toMax / fromMax;
}
export interface TerminalGeometryAnchor { seq: number; visibleIndex: number; offsetPx: number }
export interface TerminalTimelineAnchor extends TerminalGeometryAnchor {
  recordKey: string; timeMs: number | null; sourceGeneration: number; sourceRevision: number; clockEpoch?: string;
}
export type TerminalTimelineStatus = 'exact' | 'nearest' | 'before-range' | 'after-range' | 'no-time' | 'filtered' | 'held' | 'loading' | 'unsupported';
export interface TerminalTimelineResult {
  status: TerminalTimelineStatus; actualTimeMs: number | null; recordKey?: string; seq?: number; deltaMs?: number; sourceRevision?: number;
}
export interface TerminalTimelineRequest { timeMs: number; phase: 'preview' | 'commit'; signal?: AbortSignal; isCurrent?: () => boolean }
export interface ScheduledSeekResult { status: 'applied' | 'superseded' | 'aborted' | 'held' | 'unavailable'; seq?: number; timeMs?: number | null; sourceRevision: number }
export interface TerminalViewportOptions { source?: TerminalSource; display?: { encoding: Encoding; displayFormat: DisplayFormat } }
export type TerminalSeekOptions = { signal?: AbortSignal; isCurrent?: () => boolean };
export type TerminalAlignment = 'start' | 'center' | 'end';
