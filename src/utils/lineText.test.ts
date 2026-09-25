import { describe, it, expect } from 'vitest';
import type { TerminalLine } from '../types';
import { decodeBytes, getLineText, normalizeEncodingLabel } from './lineText';

const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  timestamp: 0,
  direction: 'RX',
  isHex: false,
  ...overrides,
});

describe('normalizeEncodingLabel', () => {
  it('maps ASCII to utf-8', () => {
    expect(normalizeEncodingLabel('ASCII')).toBe('utf-8');
    expect(normalizeEncodingLabel('ascii')).toBe('utf-8');
  });

  it('lowercases other encodings', () => {
    expect(normalizeEncodingLabel('UTF-8')).toBe('utf-8');
    expect(normalizeEncodingLabel('GBK')).toBe('gbk');
    expect(normalizeEncodingLabel('ISO-8859-1')).toBe('iso-8859-1');
  });
});

describe('decodeBytes', () => {
  it('decodes UTF-8 bytes', () => {
    expect(decodeBytes(new TextEncoder().encode('你好'), 'UTF-8')).toBe('你好');
  });

  it('decodes GBK bytes', () => {
    // "你" in GBK = 0xC4 0xE3, "好" = 0xBA 0xC3
    expect(decodeBytes(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]), 'GBK')).toBe('你好');
  });

  it('falls back to utf-8 for invalid labels', () => {
    expect(decodeBytes(new Uint8Array([72, 105]), 'INVALID' as never)).toBe('Hi');
  });

  it('keeps cached decoders isolated per label (interleaved use)', () => {
    // 缓存实例按 label 共享；同一实例被不同编码复用时结果会互相污染，
    // 交错解码必须各自正确（ASCII 归一化到 utf-8 亦然）。
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    expect(decodeBytes(gbk, 'UTF-8')).not.toBe('你好');
    expect(decodeBytes(gbk, 'GBK')).toBe('你好');
    expect(decodeBytes(new Uint8Array([0x41]), 'ASCII')).toBe('A');
    expect(decodeBytes(gbk, 'GBK')).toBe('你好');
  });

  it('strips a leading UTF-8 BOM (ignoreBOM: false)', () => {
    // BOM 是编码标记而非内容：进入行文本会污染渲染、搜索 haystack 与右键复制。
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), 'UTF-8')).toBe('A');
  });
});

describe('getLineText', () => {
  it('returns content when present (TX/TOOL/replay lines)', () => {
    expect(getLineText(makeLine({ content: 'hello' }), 'UTF-8')).toBe('hello');
  });

  it('decodes rawData under the given encoding', () => {
    const line = makeLine({ rawData: new TextEncoder().encode('你好') });
    expect(getLineText(line, 'UTF-8')).toBe('你好');
  });

  it('decodes GBK rawData under GBK', () => {
    const line = makeLine({ rawData: new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]) });
    expect(getLineText(line, 'GBK')).toBe('你好');
  });

  it('re-decodes with a different encoding on switch', () => {
    const line = makeLine({ rawData: new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]) });
    expect(getLineText(line, 'UTF-8')).not.toBe('你好');
    expect(getLineText(line, 'GBK')).toBe('你好');
  });

  it('returns empty string when neither content nor rawData', () => {
    expect(getLineText(makeLine({ content: undefined }), 'UTF-8')).toBe('');
  });

  it('prefers content over rawData', () => {
    const line = makeLine({
      content: 'stale',
      rawData: new TextEncoder().encode('fresh'),
    });
    expect(getLineText(line, 'UTF-8')).toBe('stale');
  });
});
