/**
 * Tests for terminal timestamp formatting helpers.
 */
import { describe, it, expect } from 'vitest';
import type { TerminalLine } from '../types';
import {
  formatAbsoluteTimestamp,
  formatRelativeTimestamp,
  formatUptimeTimestamp,
  formatTerminalTimestamp,
  isSameRound,
} from './timeFormat';

function makeLine(timestamp: number, direction: 'RX' | 'TX' = 'RX'): TerminalLine {
  return {
    id: `line-${timestamp}`,
    timestamp,
    direction,
    content: '',
    isHex: false,
  };
}

describe('timeFormat', () => {
  describe('formatAbsoluteTimestamp', () => {
    it('renders HH:MM:SS.mmm', () => {
      const ts = new Date(2026, 6, 20, 14, 5, 9, 42).getTime();
      expect(formatAbsoluteTimestamp(ts)).toBe('14:05:09.042');
    });
  });

  describe('formatRelativeTimestamp', () => {
    it('returns +0ms for the first line', () => {
      expect(formatRelativeTimestamp([makeLine(1000)], 0)).toBe('+0ms');
    });

    it('shows milliseconds for deltas below 1 second', () => {
      const lines = [makeLine(1000), makeLine(1123)];
      expect(formatRelativeTimestamp(lines, 1)).toBe('+123ms');
    });

    it('shows seconds with one decimal for deltas >= 1 second', () => {
      const lines = [makeLine(1000), makeLine(2500)];
      expect(formatRelativeTimestamp(lines, 1)).toBe('+1.5s');
    });

    it('clamps negative delta to +0ms when timestamps are out of order', () => {
      const lines = [makeLine(1500), makeLine(1000)];
      expect(formatRelativeTimestamp(lines, 1)).toBe('+0ms');
    });
  });

  describe('formatUptimeTimestamp', () => {
    it('formats elapsed time since connection', () => {
      const line = makeLine(3723004);
      expect(formatUptimeTimestamp(line, 0)).toBe('1:02:03.004');
    });

    it('shows zero elapsed when connectedAt is unknown', () => {
      const line = makeLine(61000);
      expect(formatUptimeTimestamp(line, null)).toBe('0:00:00.000');
    });
  });

  describe('formatTerminalTimestamp', () => {
    const lines = [makeLine(1000), makeLine(1050), makeLine(2050)];

    it('formats absolute timestamps', () => {
      expect(formatTerminalTimestamp(lines, 0, null, 'absolute')).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it('formats relative deltas', () => {
      expect(formatTerminalTimestamp(lines, 0, null, 'relative')).toBe('+0ms');
      expect(formatTerminalTimestamp(lines, 1, null, 'relative')).toBe('+50ms');
      expect(formatTerminalTimestamp(lines, 2, null, 'relative')).toBe('+1.0s');
    });

    it('formats uptime', () => {
      expect(formatTerminalTimestamp(lines, 1, 1000, 'uptime')).toBe('0:00:00.050');
    });
  });

  describe('isSameRound', () => {
    it('groups lines within the default 50ms threshold', () => {
      const prev = makeLine(1000);
      const current = makeLine(1040);
      expect(isSameRound(prev, current)).toBe(true);
    });

    it('splits lines beyond the threshold', () => {
      const prev = makeLine(1000);
      const current = makeLine(1060);
      expect(isSameRound(prev, current)).toBe(false);
    });

    it('uses a custom threshold', () => {
      const prev = makeLine(1000);
      const current = makeLine(1080);
      expect(isSameRound(prev, current, 100)).toBe(true);
      expect(isSameRound(prev, current, 50)).toBe(false);
    });
  });
});
