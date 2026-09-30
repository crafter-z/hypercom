import { describe, it, expect } from 'vitest';
import { linePassesFilter, type DirectionFilter } from './lineFilter';
import type { TerminalLine } from '../types';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

// RX 行不带 content（方案B, issue #14）：文本由 linePassesFilter 内部经 getLineText
// 按 rawData + encoding 惰性解码；TX 行保留 content。
const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  timestamp: 0,
  direction: 'RX',
  rawData: new Uint8Array(),
  isHex: false,
  ...overrides,
});

const passes = (
  line: TerminalLine,
  direction: DirectionFilter,
  keyword = '',
  encoding = 'UTF-8',
): boolean => linePassesFilter(line, direction, keyword, encoding);

describe('linePassesFilter', () => {
  it('passes every line when no filter is active', () => {
    const lines = [
      makeLine({ direction: 'TX', content: 'AT+RESET' }),
      makeLine({ direction: 'RX', rawData: bytes('OK') }),
    ];
    expect(lines.every((l) => passes(l, 'all'))).toBe(true);
  });

  it('keeps only the requested direction', () => {
    const tx = makeLine({ direction: 'TX', content: 'AT+GMR' });
    const rx = makeLine({ direction: 'RX', rawData: bytes('OK') });
    expect(passes(tx, 'TX')).toBe(true);
    expect(passes(tx, 'RX')).toBe(false);
    expect(passes(rx, 'RX')).toBe(true);
    expect(passes(rx, 'TX')).toBe(false);
  });

  it('matches keyword case-insensitively against content', () => {
    const line = makeLine({ content: 'AT+RESET' });
    expect(passes(line, 'all', 'at+res')).toBe(true);
    expect(passes(line, 'all', 'RESET')).toBe(true);
    expect(passes(line, 'all', 'zzz')).toBe(false);
  });

  it('trims the keyword and treats whitespace-only as no keyword', () => {
    const line = makeLine({ content: 'OK' });
    expect(passes(line, 'all', '  ok  ')).toBe(true);
    expect(passes(line, 'all', '   ')).toBe(true);
  });

  it('combines direction and keyword (AND semantics)', () => {
    const tx = makeLine({ direction: 'TX', content: 'AT+GMR' });
    const rx = makeLine({ direction: 'RX', content: 'AT command echoed' });
    expect(passes(tx, 'TX', 'at')).toBe(true);
    expect(passes(tx, 'RX', 'at')).toBe(false);
    expect(passes(rx, 'RX', 'at')).toBe(true);
    expect(passes(rx, 'TX', 'at')).toBe(false);
  });

  it('decodes RX rawData lazily under the given encoding', () => {
    // GBK: C4E3 BAC3 = 你好；UTF-8 下同一字节序列解不出该文本
    const line = makeLine({ rawData: new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]) });
    expect(passes(line, 'all', '你好')).toBe(false);
    expect(passes(line, 'all', '你好', 'GBK')).toBe(true);
  });

  it('accepts every DirectionFilter value', () => {
    const dirs: DirectionFilter[] = ['all', 'TX', 'RX'];
    const line = makeLine({ direction: 'RX', content: 'x' });
    // 'all' 与 'RX' 放行，'TX' 拒绝
    expect(dirs.map((d) => passes(line, d))).toEqual([true, false, true]);
  });
});
