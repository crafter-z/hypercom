import { describe, it, expect } from 'vitest';
import {
  findMatches,
  findMatchesIncremental,
  markSearchMatchesInHtml,
  getSearchableText,
  formatLineForCopy,
  type MatchCache,
} from './terminalSearch';
import type { TerminalLine } from '../types';

const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
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
      makeLine({ content: 'Hello World' }),
      makeLine({ content: 'no match here' }),
      makeLine({ content: 'world of warcraft' }),
    ];
    expect(findMatches(lines, { query: 'world', caseSensitive: false })).toEqual([0, 2]);
  });

  it('respects caseSensitive flag', () => {
    const lines = [
      makeLine({ content: 'Hello World' }),
      makeLine({ content: 'hello world' }),
    ];
    expect(findMatches(lines, { query: 'Hello', caseSensitive: true })).toEqual([0]);
    expect(findMatches(lines, { query: 'Hello', caseSensitive: false })).toEqual([0, 1]);
  });

  it('searches hex representation when displayFormat is hex', () => {
    const lines = [
      makeLine({ content: 'ignored', rawData: new Uint8Array([0xaa, 0xbb, 0xcc]) }),
      makeLine({ content: 'nope', rawData: new Uint8Array([0x01, 0x02]) }),
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
    const line = makeLine({ content: 'abc', rawData: new Uint8Array([0x61]) });
    expect(getSearchableText(line, 'string')).toBe('abc');
  });

  it('returns hex string for hex display format when rawData exists', () => {
    const line = makeLine({ content: 'ignored', rawData: new Uint8Array([0xaa, 0x0f]) });
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

describe('findMatchesIncremental (issue #2-8 perf)', () => {
  const lines = [
    makeLine({ content: 'hello world' }),
    makeLine({ content: 'help me' }),
    makeLine({ content: 'foo' }),
  ];

  it('falls back to a full scan without a previous cache', () => {
    expect(findMatchesIncremental(lines, { query: 'hel', caseSensitive: false }, null))
      .toEqual([0, 1]);
  });

  it('narrows to previous matches when the query grows by prefix', () => {
    const prev: MatchCache = {
      query: 'hel', caseSensitive: false, displayFormat: undefined,
      matches: [0, 1], lineCount: 3,
    };
    expect(findMatchesIncremental(lines, { query: 'hello', caseSensitive: false }, prev))
      .toEqual([0]);
  });

  it('also scans lines appended after the cached scan (live RX)', () => {
    const prev: MatchCache = {
      query: 'hel', caseSensitive: false, displayFormat: undefined,
      matches: [0, 1], lineCount: 3,
    };
    const grown = [...lines, makeLine({ content: 'HELLO again' })];
    expect(findMatchesIncremental(grown, { query: 'hel', caseSensitive: false }, prev))
      .toEqual([0, 1, 3]);
  });

  it('falls back to full scan when the query is not a prefix extension', () => {
    const prev: MatchCache = {
      query: 'hello', caseSensitive: false, displayFormat: undefined,
      matches: [0], lineCount: 3,
    };
    expect(findMatchesIncremental(lines, { query: 'foo', caseSensitive: false }, prev))
      .toEqual([2]);
  });

  it('falls back to full scan when case sensitivity changed', () => {
    const prev: MatchCache = {
      query: 'hel', caseSensitive: false, displayFormat: undefined,
      matches: [0, 1], lineCount: 3,
    };
    const caseLines = [makeLine({ content: 'HELLO' }), makeLine({ content: 'hello' })];
    const prevCase: MatchCache = { ...prev, query: 'HE', matches: [0], lineCount: 2 };
    // caseSensitive flipped → full re-scan finds only the exact-case line
    expect(findMatchesIncremental(caseLines, { query: 'HEL', caseSensitive: true }, prevCase))
      .toEqual([0]);
  });

  it('falls back to full scan when the buffer was trimmed (lineCount regressed)', () => {
    const prev: MatchCache = {
      query: 'hel', caseSensitive: false, displayFormat: undefined,
      matches: [0, 1], lineCount: 10,
    };
    // maxLines 裁剪后 lines.length < prev.lineCount → 旧索引可能越界，必须全量重扫
    expect(findMatchesIncremental(lines, { query: 'hel', caseSensitive: false }, prev))
      .toEqual([0, 1]);
  });
});

describe('markSearchMatchesInHtml (issue #2-8 char-level highlight)', () => {
  it('wraps plain-text occurrences in <mark>', () => {
    const html = markSearchMatchesInHtml('hello world', 'world', false, false);
    expect(html).toBe('hello <mark class="terminal-search-mark">world</mark>');
  });

  it('adds the current modifier class on the current-match line', () => {
    const html = markSearchMatchesInHtml('err x err', 'err', false, true);
    expect(html).toBe(
      '<mark class="terminal-search-mark current">err</mark> x '
      + '<mark class="terminal-search-mark current">err</mark>'
    );
  });

  it('is case-insensitive by default but preserves original casing', () => {
    expect(markSearchMatchesInHtml('Hello HELLO', 'hello', false, false))
      .toBe('<mark class="terminal-search-mark">Hello</mark> <mark class="terminal-search-mark">HELLO</mark>');
  });

  it('respects caseSensitive=true', () => {
    expect(markSearchMatchesInHtml('Hello hello', 'Hello', true, false))
      .toBe('<mark class="terminal-search-mark">Hello</mark> hello');
  });

  it('never matches inside tags or attributes', () => {
    const html = '<span style="color:red">span text</span>';
    const marked = markSearchMatchesInHtml(html, 'span', false, false);
    expect(marked).toBe('<span style="color:red"><mark class="terminal-search-mark">span</mark> text</span>');
  });

  it('matches text decoded from entities (&amp; &lt; &gt;)', () => {
    // 高亮引擎会把 < > & 转义成实体；搜索应命中解码后的文本并正确切片
    const html = markSearchMatchesInHtml('a &lt;b&gt; &amp; c', '<b>', false, false);
    expect(html).toBe('a <mark class="terminal-search-mark">&lt;b&gt;</mark> &amp; c');
  });

  it('does not turn escaped entity lookalikes into entities', () => {
    // 原文里的 "&#39;" 被转义为 "&amp;#39;" —— 必须按字面文本匹配
    const html = markSearchMatchesInHtml('&amp;#39;text', '&#39;', false, false);
    expect(html).toBe('<mark class="terminal-search-mark">&amp;#39;</mark>text');
  });

  it('handles a match spanning a highlight-span boundary', () => {
    // "error" 被高亮 span 切成 "er|ror"，搜索 "error" 仍应整段命中
    const html = markSearchMatchesInHtml('er<span style="color:red">ror</span>!', 'error', false, false);
    expect(html).toBe(
      '<mark class="terminal-search-mark">er</mark>'
      + '<span style="color:red"><mark class="terminal-search-mark">ror</mark></span>!'
    );
  });

  it('returns the input untouched when there is no match or empty query', () => {
    expect(markSearchMatchesInHtml('abc', 'xyz', false, false)).toBe('abc');
    expect(markSearchMatchesInHtml('abc', '', false, false)).toBe('abc');
  });

  it('marks every non-overlapping occurrence', () => {
    expect(markSearchMatchesInHtml('aa aa aa', 'aa', false, false)).toBe(
      '<mark class="terminal-search-mark">aa</mark> '
      + '<mark class="terminal-search-mark">aa</mark> '
      + '<mark class="terminal-search-mark">aa</mark>'
    );
  });
});
