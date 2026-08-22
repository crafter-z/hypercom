import { describe, it, expect } from 'vitest';
import { filterLines, type DirectionFilter } from './lineFilter';
import type { TerminalLine } from '../types';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

// RX 行不带 content（方案B, issue #14）：文本由 filterLines 内部经 getLineText
// 按 rawData + encoding 惰性解码；TX 行保留 content。
const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  timestamp: 0,
  direction: 'RX',
  rawData: new Uint8Array(),
  isHex: false,
  ...overrides,
});

const sample = (): TerminalLine[] => [
  makeLine({ direction: 'TX', content: 'AT+RESET' }),
  makeLine({ direction: 'RX', rawData: bytes('OK') }),
  makeLine({ direction: 'TX', content: 'AT+GMR' }),
  makeLine({ direction: 'RX', rawData: bytes('error: timeout') }),
  makeLine({ direction: 'RX', rawData: bytes('AT command echoed') }),
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
      makeLine({ direction: 'RX', rawData: bytes('skip') }),
      makeLine({ direction: 'RX', rawData: bytes('keep') }),
      makeLine({ direction: 'RX', rawData: bytes('skip') }),
    ];
    expect(filterLines(lines, { direction: 'all', keyword: 'keep' })).toEqual([1]);
  });

  it('decodes RX rawData lazily under the given encoding', () => {
    // '你好' GBK = C4E3 BAC3：默认 UTF-8 解不出（得到替换符），显式传 encoding 才命中
    const lines = [
      makeLine({ direction: 'RX', rawData: new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]) }),
    ];
    expect(filterLines(lines, { direction: 'all', keyword: '你好' })).toEqual([]);
    expect(filterLines(lines, { direction: 'all', keyword: '你好', encoding: 'GBK' })).toEqual([0]);
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
