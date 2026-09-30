import { describe, it, expect } from 'vitest';
import {
  markSearchMatchesInHtml,
  getSearchableText,
  formatLineForCopy,
} from './terminalSearch';
import type { TerminalLine } from '../types';

const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  timestamp: 0,
  direction: 'RX',
  content: '',
  isHex: false,
  ...overrides,
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
