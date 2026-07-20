import { describe, it, expect } from 'vitest';
import { findMatches, getSearchableText, formatLineForCopy } from './terminalSearch';
import type { TerminalLine } from '../../types';

const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  id: 'l1',
  timestamp: 0,
  direction: 'RX',
  content: '',
  isHex: false,
  ...overrides,
});

describe('findMatches', () => {
  it('returns empty array for empty query', () => {
    const lines = [makeLine({ content: 'hello' })];
    expect(findMatches(lines, { query: '', caseSensitive: false })).toEqual([]);
  });

  it('finds case-insensitive matches across multiple lines', () => {
    const lines = [
      makeLine({ id: 'a', content: 'Hello World' }),
      makeLine({ id: 'b', content: 'no match here' }),
      makeLine({ id: 'c', content: 'world of warcraft' }),
    ];
    expect(findMatches(lines, { query: 'world', caseSensitive: false })).toEqual([0, 2]);
  });

  it('respects caseSensitive flag', () => {
    const lines = [
      makeLine({ id: 'a', content: 'Hello World' }),
      makeLine({ id: 'b', content: 'hello world' }),
    ];
    expect(findMatches(lines, { query: 'Hello', caseSensitive: true })).toEqual([0]);
    expect(findMatches(lines, { query: 'Hello', caseSensitive: false })).toEqual([0, 1]);
  });

  it('searches hex representation when displayFormat is hex', () => {
    const lines = [
      makeLine({ id: 'a', content: 'ignored', rawData: [0xaa, 0xbb, 0xcc] }),
      makeLine({ id: 'b', content: 'nope', rawData: [0x01, 0x02] }),
    ];
    const matches = findMatches(lines, { query: 'AA BB', caseSensitive: true, displayFormat: 'hex' });
    expect(matches).toEqual([0]);
  });

  it('returns empty when no lines match', () => {
    const lines = [makeLine({ content: 'foo' }), makeLine({ content: 'bar' })];
    expect(findMatches(lines, { query: 'baz', caseSensitive: false })).toEqual([]);
  });
});

describe('getSearchableText', () => {
  it('returns content for string display format', () => {
    const line = makeLine({ content: 'abc', rawData: [0x61] });
    expect(getSearchableText(line, 'string')).toBe('abc');
  });

  it('returns hex string for hex display format when rawData exists', () => {
    const line = makeLine({ content: 'ignored', rawData: [0xaa, 0x0f] });
    expect(getSearchableText(line, 'hex')).toBe('AA 0F');
  });

  it('falls back to content when hex format but no rawData', () => {
    const line = makeLine({ content: 'fallback' });
    expect(getSearchableText(line, 'hex')).toBe('fallback');
  });
});

describe('formatLineForCopy', () => {
  it('formats as [timestamp] direction content', () => {
    const line = makeLine({
      timestamp: new Date('2026-01-02T03:04:05.678Z').getTime(),
      direction: 'TX',
      content: 'ping',
    });
    // Local time formatting — verify shape with regex
    expect(formatLineForCopy(line)).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] TX ping$/);
  });
});