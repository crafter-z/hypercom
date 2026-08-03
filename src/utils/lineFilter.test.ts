import { describe, it, expect } from 'vitest';
import { filterLines, type DirectionFilter } from './lineFilter';
import type { TerminalLine } from '../types';

const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  id: 'l1',
  timestamp: 0,
  direction: 'RX',
  content: '',
  isHex: false,
  ...overrides,
});

const sample = (): TerminalLine[] => [
  makeLine({ id: 'a', direction: 'TX', content: 'AT+RESET' }),
  makeLine({ id: 'b', direction: 'RX', content: 'OK' }),
  makeLine({ id: 'c', direction: 'TX', content: 'AT+GMR' }),
  makeLine({ id: 'd', direction: 'RX', content: 'error: timeout' }),
  makeLine({ id: 'e', direction: 'RX', content: 'AT command echoed' }),
];

describe('filterLines', () => {
  it('returns null (implicit identity) when no filter is active', () => {
    expect(filterLines(sample(), { direction: 'all', keyword: '' })).toBeNull();
  });

  it('returns empty array for empty input with an active filter', () => {
    expect(filterLines([], { direction: 'TX', keyword: 'x' })).toEqual([]);
  });

  it('keeps only TX lines for direction TX', () => {
    expect(filterLines(sample(), { direction: 'TX', keyword: '' })).toEqual([0, 2]);
  });

  it('keeps only RX lines for direction RX', () => {
    expect(filterLines(sample(), { direction: 'RX', keyword: '' })).toEqual([1, 3, 4]);
  });

  it('matches keyword case-insensitively against content', () => {
    expect(filterLines(sample(), { direction: 'all', keyword: 'at' })).toEqual([0, 2, 4]);
    expect(filterLines(sample(), { direction: 'all', keyword: 'TIMEOUT' })).toEqual([3]);
  });

  it('treats whitespace-only keyword as no keyword filter', () => {
    expect(filterLines(sample(), { direction: 'all', keyword: '   ' })).toBeNull();
  });

  it('trims keyword before matching', () => {
    expect(filterLines(sample(), { direction: 'all', keyword: '  ok  ' })).toEqual([1]);
  });

  it('combines direction and keyword filters (AND semantics)', () => {
    // 'at' appears in TX lines 0, 2 and RX line 4; TX-only narrows to 0, 2.
    expect(filterLines(sample(), { direction: 'TX', keyword: 'at' })).toEqual([0, 2]);
    expect(filterLines(sample(), { direction: 'RX', keyword: 'at' })).toEqual([4]);
  });

  it('returns empty when nothing matches the keyword', () => {
    expect(filterLines(sample(), { direction: 'all', keyword: 'zzz' })).toEqual([]);
  });

  it('returns original indices, not re-numbered positions', () => {
    const lines = [
      makeLine({ id: 'x', direction: 'RX', content: 'skip' }),
      makeLine({ id: 'y', direction: 'RX', content: 'keep' }),
      makeLine({ id: 'z', direction: 'RX', content: 'skip' }),
    ];
    expect(filterLines(lines, { direction: 'all', keyword: 'keep' })).toEqual([1]);
  });

  it('accepts every DirectionFilter value', () => {
    const lines = sample();
    const dirs: DirectionFilter[] = ['all', 'TX', 'RX'];
    // null means implicit identity — count falls back to lines.length.
    const counts = dirs.map((d) => filterLines(lines, { direction: d, keyword: '' })?.length ?? lines.length);
    expect(counts).toEqual([5, 2, 3]);
  });

  describe('limit', () => {
    it('stops scanning at limit for keyword filters', () => {
      // 'at' matches indices 0, 2, 4 in the full sample; limit 2 scans 0..1.
      expect(filterLines(sample(), { direction: 'all', keyword: 'at' }, 2)).toEqual([0]);
    });

    it('stops scanning at limit for direction filters', () => {
      // RX lives at 1, 3, 4; limit 3 scans 0..2 → only index 1.
      expect(filterLines(sample(), { direction: 'RX', keyword: '' }, 3)).toEqual([1]);
    });

    it('returns empty for limit 0 with an active filter', () => {
      expect(filterLines(sample(), { direction: 'all', keyword: 'at' }, 0)).toEqual([]);
    });

    it('still returns null with no active filter regardless of limit', () => {
      expect(filterLines(sample(), { direction: 'all', keyword: '' }, 2)).toBeNull();
    });

    it('treats limit beyond the buffer as the full buffer', () => {
      expect(filterLines(sample(), { direction: 'RX', keyword: '' }, 99)).toEqual([1, 3, 4]);
    });
  });
});
