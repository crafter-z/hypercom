import { describe, expect, it } from 'vitest';
import { makeHit, matchRecord, matchWindow, splitSpans, validateSearchSpec } from './searchMatcher';
import type { SearchRecord, SearchSpec } from './searchTypes';

const base: SearchSpec = {
  query: '', mode: 'literal', multiline: false, caseSensitive: false,
  wholeWord: false, scope: 'buffer', directions: ['RX', 'TX', 'TOOL', 'NOTE'],
};
const row = (seq: number, text: string, direction: SearchRecord['direction'] = 'RX'): SearchRecord => ({
  seq, text, timestamp: seq, direction,
});

describe('terminal advanced search matcher', () => {
  it('validates regex with the shared safe-regex policy', () => {
    expect(validateSearchSpec({ ...base, query: '(a+)+$', mode: 'regex' })).toBe('terminal.search.error.invalidRegex');
    expect(validateSearchSpec({ ...base, query: '[a-z]+', mode: 'regex' })).toBeNull();
  });

  it('keeps UTF-16 offsets for emoji and whole-word literal matches', () => {
    const match = matchRecord(row(7, '🙂 Foo bar foo'), { ...base, query: 'foo', wholeWord: true });
    expect(match?.spans).toEqual([{ start: 3, end: 6 }, { start: 11, end: 14 }]);
  });

  it('matches fuzzy queries greedily and returns ordered character spans', () => {
    const match = matchRecord(row(1, 'terminal search'), { ...base, query: 'trs', mode: 'fuzzy' });
    expect(match?.spans).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 9, end: 10 }]);
    expect(match?.score).toBeDefined();
  });

  it('matches HEX against raw bytes without transferring ownership', () => {
    const record = { ...row(4, ''), rawData: Uint8Array.from([0x10, 0xab, 0xcd, 0xef]) };
    const match = matchRecord(record, { ...base, query: 'AB CD', mode: 'hex' });
    expect(match?.spans).toEqual([{ start: 1, end: 3 }]);
  });

  it('preserves offsets through case-fold expansion and does not split fuzzy emoji', () => {
    expect(matchRecord(row(0, 'İ foo'), { ...base, query: 'foo' })?.spans).toEqual([{ start: 2, end: 5 }]);
    expect(matchRecord(row(0, 'a🙂xxB'), { ...base, query: '🙂b', mode: 'fuzzy' })?.spans)
      .toEqual([{ start: 1, end: 3 }, { start: 5, end: 6 }]);
  });

  it('advances empty /u regex matches by code point and ignores zero-length hits', () => {
    expect(matchRecord(row(0, '🙂🙂'), { ...base, query: '(?:)', mode: 'regex' })).toBeNull();
    expect(matchRecord(row(0, '🙂x'), { ...base, query: '(?:)|x', mode: 'regex' })).toBeNull();
  });

  it('maps HEX byte matches to spaced-HEX character offsets', () => {
    const record = { ...row(4, ''), rawData: new Uint8Array([0x10, 0xab, 0xcd]) };
    const matched = matchRecord(record, { ...base, query: 'ABCD', mode: 'hex' })!;
    expect(makeHit('hex', 1, [record], matched, 'hex')?.spans).toEqual([{ seq: 4, start: 3, end: 8 }]);
    expect(validateSearchSpec({ ...base, mode: 'hex', query: 'A' })).toBe('terminal.search.error.invalidHex');
    expect(validateSearchSpec({ ...base, mode: 'hex', query: 'AA', multiline: true })).toBe('terminal.search.error.hexMultiline');
  });

  it('does not manufacture cross-line hits out of independent occurrences or sequence gaps', () => {
    expect(matchWindow([row(0, 'a'), row(1, 'a')], { ...base, query: 'a', multiline: true })).toBeNull();
    expect(matchWindow([row(0, 'a'), row(2, 'b')], { ...base, query: 'a\nb', multiline: true })).toBeNull();
  });

  it('cuts multiline adjacency at null and excluded directions', () => {
    const spec = { ...base, query: 'left\nright', multiline: true };
    expect(matchWindow([row(1, 'left'), row(2, 'right')], spec)).not.toBeNull();
    expect(matchWindow([row(1, 'left'), row(2, 'right', 'TX')], { ...spec, directions: ['RX'] })).toBeNull();
    expect(matchWindow([row(1, 'left'), null, row(2, 'right')] as unknown as SearchRecord[], spec)).toBeNull();
    const hit = makeHit('s', 1, [row(1, 'left'), row(2, 'right')], matchWindow([row(1, 'left'), row(2, 'right')], spec)!);
    expect(hit && { start: hit.startSeq, end: hit.endSeq, spans: hit.spans }).toEqual({
      start: 1, end: 2,
      spans: [{ seq: 1, start: 0, end: 4 }, { seq: 2, start: 0, end: 5 }],
    });
    expect(splitSpans([row(1, 'a'), row(2, 'b')], { spans: [{ start: 0, end: 3 }] })).toEqual([
      { seq: 1, start: 0, end: 1 }, { seq: 2, start: 0, end: 1 },
    ]);
  });
});
