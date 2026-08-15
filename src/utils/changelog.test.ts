import { describe, expect, it } from 'vitest';
import { parseChangelog, splitBold } from './changelog';

describe('splitBold (issue #12 二轮)', () => {
  it('splits bold segments preserving order', () => {
    expect(splitBold('前缀 **粗体** 后缀')).toEqual([
      { text: '前缀 ', bold: false },
      { text: '粗体', bold: true },
      { text: ' 后缀', bold: false },
    ]);
  });

  it('handles multiple bold groups', () => {
    expect(splitBold('**a** mid **b**')).toEqual([
      { text: 'a', bold: true },
      { text: ' mid ', bold: false },
      { text: 'b', bold: true },
    ]);
  });

  it('returns single plain segment when no bold', () => {
    expect(splitBold('纯文本无加粗')).toEqual([{ text: '纯文本无加粗', bold: false }]);
    expect(splitBold('')).toEqual([]);
  });

  it('ignores lone ** without closing pair', () => {
    expect(splitBold('a ** b')).toEqual([{ text: 'a ** b', bold: false }]);
  });
});

describe('parseChangelog (issue #12 二轮)', () => {
  it('parses headings / bullets / paragraphs from release notes shape', () => {
    const notes = [
      '# HyperCom v0.6.0',
      '',
      '## 新增',
      '- **TTY 模式**：xterm.js 完整交互终端',
      '- 自动更新双通道',
      '',
      '修复若干问题。',
    ].join('\n');
    expect(parseChangelog(notes)).toEqual([
      { kind: 'heading', level: 1, text: 'HyperCom v0.6.0' },
      { kind: 'heading', level: 2, text: '新增' },
      { kind: 'bullet', text: '**TTY 模式**：xterm.js 完整交互终端' },
      { kind: 'bullet', text: '自动更新双通道' },
      { kind: 'para', text: '修复若干问题。' },
    ]);
  });

  it('clamps deep headings to level 3 and trims whitespace', () => {
    expect(parseChangelog('##### 深层标题  ')).toEqual([
      { kind: 'heading', level: 3, text: '深层标题' },
    ]);
  });

  it('treats * bullets like - bullets; CRLF tolerated', () => {
    expect(parseChangelog('* 星号列表\r\n- 横线列表')).toEqual([
      { kind: 'bullet', text: '星号列表' },
      { kind: 'bullet', text: '横线列表' },
    ]);
  });

  it('skips blank lines and handles empty input', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('\n\n  \n')).toEqual([]);
  });
});
