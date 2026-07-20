/**
 * Terminal timestamp formatting helpers.
 *
 * Pure, DOM-free utilities so they can be unit-tested under vitest's
 * `environment: 'node'` config.
 */
import type { TerminalLine, TimestampFormat } from '../types';

/** Format a single timestamp as HH:MM:SS.mmm. */
export function formatAbsoluteTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

/** Relative delta since the previous line of the same port. */
export function formatRelativeTimestamp(
  lines: TerminalLine[],
  index: number
): string {
  if (index <= 0 || lines.length === 0) return '+0ms';
  const delta = Math.max(0, lines[index].timestamp - lines[index - 1].timestamp);
  if (delta >= 1000) {
    return `+${(delta / 1000).toFixed(1)}s`;
  }
  return `+${delta}ms`;
}

/** Elapsed time since the port connected (or the line timestamp if unknown). */
export function formatUptimeTimestamp(
  line: TerminalLine,
  connectedAt: number | null | undefined
): string {
  const start = connectedAt ?? line.timestamp;
  const elapsed = Math.max(0, line.timestamp - start);
  const h = Math.floor(elapsed / 3600000);
  const m = Math.floor((elapsed % 3600000) / 60000);
  const s = Math.floor((elapsed % 60000) / 1000);
  const ms = elapsed % 1000;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${h}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}

/** Format a terminal line according to the configured timestamp format. */
export function formatTerminalTimestamp(
  lines: TerminalLine[],
  index: number,
  connectedAt: number | null | undefined,
  format: TimestampFormat
): string {
  const line = lines[index];
  if (!line) return '';
  switch (format) {
    case 'relative':
      return formatRelativeTimestamp(lines, index);
    case 'uptime':
      return formatUptimeTimestamp(line, connectedAt);
    case 'absolute':
    default:
      return formatAbsoluteTimestamp(line.timestamp);
  }
}

/** Per-round grouping predicate: same port, next line within `thresholdMs`. */
export function isSameRound(
  previous: TerminalLine,
  current: TerminalLine,
  thresholdMs = 50
): boolean {
  return current.timestamp - previous.timestamp <= thresholdMs;
}
